package app

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

type mediaSourceTrack struct {
	track *webrtc.TrackLocalStaticRTP
}

type mediaPeer struct {
	token                string
	userID               string
	pc                   *webrtc.PeerConnection
	senders              map[string]*webrtc.RTPSender
	renegotiating        bool
	pendingRenegotiate   bool
	pendingICECandidates []webrtc.ICECandidateInit
}

type MediaManager struct {
	mu              sync.Mutex
	logger          *slog.Logger
	hub             *Hub
	peers           map[string]*mediaPeer
	sources         map[string]*mediaSourceTrack   // sourceToken -> track
	broadcastActive map[string]map[string]struct{} // sourceToken -> broadcastGroupID set
	directActive    map[string]string              // sourceToken -> targetUserID
}

func NewMediaManager(hub *Hub, logger *slog.Logger) *MediaManager {
	return &MediaManager{
		logger:          logger,
		hub:             hub,
		peers:           make(map[string]*mediaPeer),
		sources:         make(map[string]*mediaSourceTrack),
		broadcastActive: make(map[string]map[string]struct{}),
		directActive:    make(map[string]string),
	}
}

func (m *MediaManager) EnsurePeer(token string, user User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.peers[token]; ok {
		return nil
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	_, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})
	if err != nil {
		_ = pc.Close()
		return err
	}
	peer := &mediaPeer{
		token:   token,
		userID:  user.ID,
		pc:      pc,
		senders: make(map[string]*webrtc.RTPSender),
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		m.sendWS(token, WSOutbound{
			Type: "webrtc_ice_candidate",
			Data: WebRTCIceCandidate{
				Candidate:     init.Candidate,
				SDPMid:        derefString(init.SDPMid),
				SDPMLineIndex: derefUint16(init.SDPMLineIndex),
			},
		})
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		m.handleRemoteTrack(peer, remote)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		m.logger.Info("peer connection state changed", "token", token, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.RemovePeer(token)
		}
	})
	m.peers[token] = peer
	return nil
}

func (m *MediaManager) SyncRouting() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recomputeAllSourcesLocked()
}

func (m *MediaManager) EnsureNegotiation(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, ok := m.peers[token]
	if !ok {
		return
	}
	m.renegotiateLocked(peer)
}

func (m *MediaManager) HandleAnswer(token string, sdp string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, ok := m.peers[token]
	if !ok {
		return fmt.Errorf("peer not found")
	}
	if err := peer.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}); err != nil {
		return err
	}
	for _, c := range peer.pendingICECandidates {
		if err := peer.pc.AddICECandidate(c); err != nil {
			m.logger.Warn("flush pending ice candidate failed", "token", token, "error", err)
		}
	}
	peer.pendingICECandidates = nil
	peer.renegotiating = false
	if peer.pendingRenegotiate {
		peer.pendingRenegotiate = false
		m.renegotiateLocked(peer)
	}
	return nil
}

func (m *MediaManager) HandleICECandidate(token string, c WebRTCIceCandidate) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, ok := m.peers[token]
	if !ok {
		return fmt.Errorf("peer not found")
	}
	var mid *string
	if c.SDPMid != "" {
		mid = &c.SDPMid
	}
	mline := &c.SDPMLineIndex
	candidate := webrtc.ICECandidateInit{
		Candidate:     c.Candidate,
		SDPMid:        mid,
		SDPMLineIndex: mline,
	}
	if peer.pc.RemoteDescription() == nil {
		peer.pendingICECandidates = append(peer.pendingICECandidates, candidate)
		return nil
	}
	return peer.pc.AddICECandidate(candidate)
}

func (m *MediaManager) RemovePeer(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, ok := m.peers[token]
	if !ok {
		return
	}
	_ = peer.pc.Close()
	delete(m.peers, token)
	delete(m.broadcastActive, token)
	delete(m.directActive, token)
	delete(m.sources, token)

	var affectedSources []string
	for sourceToken, targetUserID := range m.directActive {
		if targetUserID == peer.userID {
			delete(m.directActive, sourceToken)
			affectedSources = append(affectedSources, sourceToken)
		}
	}

	for _, p := range m.peers {
		if m.removeSenderLocked(p, token) {
			m.renegotiateLocked(p)
		}
	}
	for _, sourceToken := range affectedSources {
		m.recomputeSourceRoutingLocked(sourceToken)
	}
}

func (m *MediaManager) handleRemoteTrack(sourcePeer *mediaPeer, remote *webrtc.TrackRemote) {
	localTrack, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, fmt.Sprintf("audio-%s", sourcePeer.token), "intercom")
	if err != nil {
		m.logger.Error("failed to create local track", "error", err)
		return
	}
	m.mu.Lock()
	m.sources[sourcePeer.token] = &mediaSourceTrack{track: localTrack}
	m.recomputeSourceRoutingLocked(sourcePeer.token)
	m.mu.Unlock()

	for {
		pkt, _, readErr := remote.ReadRTP()
		if readErr != nil {
			break
		}
		if writeErr := localTrack.WriteRTP(pkt); writeErr != nil {
			break
		}
	}

	m.mu.Lock()
	delete(m.sources, sourcePeer.token)
	for _, p := range m.peers {
		if m.removeSenderLocked(p, sourcePeer.token) {
			m.renegotiateLocked(p)
		}
	}
	m.mu.Unlock()
}

func (m *MediaManager) SetBroadcastGroupActive(sourceToken, groupID string, enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if enabled {
		if _, ok := m.broadcastActive[sourceToken]; !ok {
			m.broadcastActive[sourceToken] = make(map[string]struct{})
		}
		m.broadcastActive[sourceToken][groupID] = struct{}{}
	} else {
		if groups, ok := m.broadcastActive[sourceToken]; ok {
			delete(groups, groupID)
			if len(groups) == 0 {
				delete(m.broadcastActive, sourceToken)
			}
		}
	}
	m.recomputeSourceRoutingLocked(sourceToken)
}

func (m *MediaManager) SetDirectTargetActive(sourceToken, targetUserID string, enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if enabled {
		m.directActive[sourceToken] = targetUserID
	} else if currentTarget, ok := m.directActive[sourceToken]; ok {
		if currentTarget == targetUserID || targetUserID == "" {
			delete(m.directActive, sourceToken)
		}
	}
	m.recomputeSourceRoutingLocked(sourceToken)
}

func (m *MediaManager) recomputeAllSourcesLocked() {
	for sourceToken := range m.sources {
		m.recomputeSourceRoutingLocked(sourceToken)
	}
}

func (m *MediaManager) recomputeSourceRoutingLocked(sourceToken string) {
	src, ok := m.sources[sourceToken]
	if !ok {
		return
	}
	directTargetUserID := m.directActive[sourceToken]
	var directTargetPeerToken string
	if directTargetUserID != "" {
		for _, p := range m.peers {
			if p.userID == directTargetUserID {
				directTargetPeerToken = p.token
				break
			}
		}
	}
	broadcastRooms := m.broadcastRoomsForSourceLocked(sourceToken)
	talkRooms := m.talkRoomsForSourceLocked(sourceToken)

	for _, p := range m.peers {
		if p.token == sourceToken {
			continue
		}
		shouldReceive := false
		if directTargetPeerToken != "" {
			shouldReceive = p.token == directTargetPeerToken
		} else if len(broadcastRooms) > 0 {
			shouldReceive = m.peerListensToAnyRoomLocked(p.token, broadcastRooms)
		} else {
			shouldReceive = m.peerListensToAnyRoomLocked(p.token, talkRooms)
		}

		if shouldReceive {
			if m.attachSourceToPeerLocked(sourceToken, src, p) {
				m.renegotiateLocked(p)
			}
			continue
		}
		if m.removeSenderLocked(p, sourceToken) {
			m.renegotiateLocked(p)
		}
	}
}

func (m *MediaManager) talkRoomsForSourceLocked(sourceToken string) map[string]struct{} {
	m.hub.mu.RLock()
	defer m.hub.mu.RUnlock()
	c, ok := m.hub.clients[sourceToken]
	if !ok || len(c.talkRooms) == 0 {
		return map[string]struct{}{}
	}
	rooms := make(map[string]struct{}, len(c.talkRooms))
	for roomID := range c.talkRooms {
		senderRoles, _, err := m.hub.store.RoomRolePolicies(context.Background(), roomID)
		if err != nil {
			continue
		}
		if !isRoleAllowed(senderRoles, c.session.RoleID) {
			continue
		}
		rooms[roomID] = struct{}{}
	}
	return rooms
}

func (m *MediaManager) peerListensToAnyRoomLocked(peerToken string, roomSet map[string]struct{}) bool {
	if len(roomSet) == 0 {
		return false
	}
	m.hub.mu.RLock()
	defer m.hub.mu.RUnlock()
	c, ok := m.hub.clients[peerToken]
	if !ok {
		return false
	}
	for roomID := range c.listenRooms {
		if _, ok := roomSet[roomID]; !ok {
			continue
		}
		_, receiverRoles, err := m.hub.store.RoomRolePolicies(context.Background(), roomID)
		if err != nil {
			continue
		}
		if isRoleAllowed(receiverRoles, c.session.RoleID) {
			return true
		}
	}
	return false
}

func (m *MediaManager) broadcastRoomsForSourceLocked(sourceToken string) map[string]struct{} {
	groups := m.broadcastActive[sourceToken]
	if len(groups) == 0 {
		return map[string]struct{}{}
	}
	m.hub.mu.RLock()
	sourceClient, ok := m.hub.clients[sourceToken]
	m.hub.mu.RUnlock()
	if !ok {
		return map[string]struct{}{}
	}
	rooms := make(map[string]struct{})
	for groupID := range groups {
		set, err := m.hub.store.BroadcastGroupRoomSet(context.Background(), groupID)
		if err != nil {
			m.logger.Warn("broadcast group room lookup failed", "groupId", groupID, "error", err)
			continue
		}
		for roomID := range set {
			senderRoles, _, err := m.hub.store.RoomRolePolicies(context.Background(), roomID)
			if err != nil {
				continue
			}
			if !isRoleAllowed(senderRoles, sourceClient.session.RoleID) {
				continue
			}
			rooms[roomID] = struct{}{}
		}
	}
	return rooms
}

func (m *MediaManager) attachSourceToPeerLocked(srcToken string, src *mediaSourceTrack, peer *mediaPeer) bool {
	if _, exists := peer.senders[srcToken]; exists {
		return false
	}
	sender, err := peer.pc.AddTrack(src.track)
	if err != nil {
		m.logger.Warn("add track failed", "peerToken", peer.token, "sourceToken", srcToken, "error", err)
		return false
	}
	peer.senders[srcToken] = sender
	return true
}

func (m *MediaManager) removeSenderLocked(peer *mediaPeer, srcToken string) bool {
	sender, ok := peer.senders[srcToken]
	if !ok {
		return false
	}
	_ = peer.pc.RemoveTrack(sender)
	delete(peer.senders, srcToken)
	return true
}

func (m *MediaManager) renegotiateLocked(peer *mediaPeer) {
	if peer.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		return
	}
	if peer.pc.SignalingState() != webrtc.SignalingStateStable || peer.renegotiating {
		peer.pendingRenegotiate = true
		return
	}
	peer.renegotiating = true
	offer, err := peer.pc.CreateOffer(nil)
	if err != nil {
		peer.renegotiating = false
		m.logger.Warn("create offer failed", "token", peer.token, "error", err)
		return
	}
	if err := peer.pc.SetLocalDescription(offer); err != nil {
		peer.renegotiating = false
		m.logger.Warn("set local description failed", "token", peer.token, "error", err)
		return
	}
	m.sendWS(peer.token, WSOutbound{
		Type: "webrtc_offer",
		Data: WebRTCOffer{SDP: offer.SDP},
	})
}

func (m *MediaManager) sendWS(token string, msg WSOutbound) {
	m.hub.mu.RLock()
	defer m.hub.mu.RUnlock()
	c, ok := m.hub.clients[token]
	if !ok {
		return
	}
	select {
	case c.send <- msg:
	default:
	}
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefUint16(u *uint16) uint16 {
	if u == nil {
		return 0
	}
	return *u
}
