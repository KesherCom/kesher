package app

import (
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
	roomID               string
	pc                   *webrtc.PeerConnection
	senders              map[string]*webrtc.RTPSender
	renegotiating        bool
	pendingRenegotiate   bool
	pendingICECandidates []webrtc.ICECandidateInit
}

type MediaManager struct {
	mu      sync.Mutex
	logger  *slog.Logger
	hub     *Hub
	peers   map[string]*mediaPeer
	sources map[string]map[string]*mediaSourceTrack // room -> sourceToken -> track
}

func NewMediaManager(hub *Hub, logger *slog.Logger) *MediaManager {
	return &MediaManager{
		logger:  logger,
		hub:     hub,
		peers:   make(map[string]*mediaPeer),
		sources: make(map[string]map[string]*mediaSourceTrack),
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
		roomID:  "",
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

func (m *MediaManager) SwitchRoom(token, roomID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, ok := m.peers[token]
	if !ok {
		return
	}
	if roomID == "" || peer.roomID == roomID {
		return
	}
	m.logger.Info("switching media room", "token", token, "fromRoom", peer.roomID, "toRoom", roomID)
	oldRoom := peer.roomID
	peer.roomID = roomID

	var movedSource *mediaSourceTrack
	if oldRoom != "" {
		if oldSources, ok := m.sources[oldRoom]; ok {
			if src, ok := oldSources[token]; ok {
				movedSource = src
				delete(oldSources, token)
				if len(oldSources) == 0 {
					delete(m.sources, oldRoom)
				}
			}
		}
	}
	if movedSource != nil {
		if _, ok := m.sources[roomID]; !ok {
			m.sources[roomID] = make(map[string]*mediaSourceTrack)
		}
		m.sources[roomID][token] = movedSource
	}
	m.detachAllIncomingLocked(peer)
	m.attachRoomSourcesLocked(peer)
	m.renegotiateLocked(peer)
	if oldRoom != "" {
		for _, p := range m.peers {
			if p.roomID == oldRoom {
				m.removeSenderLocked(p, token)
				m.renegotiateLocked(p)
			}
		}
	}
	if movedSource != nil {
		for _, p := range m.peers {
			if p.token == token || p.roomID != roomID {
				continue
			}
			m.attachSourceToPeerLocked(token, movedSource, p)
			m.renegotiateLocked(p)
		}
	}
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
	roomID := peer.roomID
	_ = peer.pc.Close()
	delete(m.peers, token)
	if roomID != "" {
		if _, ok := m.sources[roomID]; ok {
			delete(m.sources[roomID], token)
		}
		for _, p := range m.peers {
			if p.roomID != roomID {
				continue
			}
			m.removeSenderLocked(p, token)
			m.renegotiateLocked(p)
		}
	}
}

func (m *MediaManager) handleRemoteTrack(sourcePeer *mediaPeer, remote *webrtc.TrackRemote) {
	localTrack, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, fmt.Sprintf("audio-%s", sourcePeer.token), "intercom")
	if err != nil {
		m.logger.Error("failed to create local track", "error", err)
		return
	}
	m.mu.Lock()
	if _, ok := m.sources[sourcePeer.roomID]; !ok {
		m.sources[sourcePeer.roomID] = make(map[string]*mediaSourceTrack)
	}
	m.sources[sourcePeer.roomID][sourcePeer.token] = &mediaSourceTrack{track: localTrack}
	for _, p := range m.peers {
		if p.roomID != sourcePeer.roomID || p.token == sourcePeer.token {
			continue
		}
		m.attachSourceToPeerLocked(sourcePeer.token, m.sources[sourcePeer.roomID][sourcePeer.token], p)
		m.renegotiateLocked(p)
	}
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
	if _, ok := m.sources[sourcePeer.roomID]; ok {
		delete(m.sources[sourcePeer.roomID], sourcePeer.token)
	}
	for _, p := range m.peers {
		if p.roomID != sourcePeer.roomID {
			continue
		}
		m.removeSenderLocked(p, sourcePeer.token)
		m.renegotiateLocked(p)
	}
	m.mu.Unlock()
}

func (m *MediaManager) detachAllIncomingLocked(peer *mediaPeer) {
	for srcToken, sender := range peer.senders {
		_ = peer.pc.RemoveTrack(sender)
		delete(peer.senders, srcToken)
	}
}

func (m *MediaManager) attachRoomSourcesLocked(peer *mediaPeer) {
	roomSources := m.sources[peer.roomID]
	for srcToken, src := range roomSources {
		if srcToken == peer.token {
			continue
		}
		m.attachSourceToPeerLocked(srcToken, src, peer)
	}
}

func (m *MediaManager) attachSourceToPeerLocked(srcToken string, src *mediaSourceTrack, peer *mediaPeer) {
	if _, exists := peer.senders[srcToken]; exists {
		return
	}
	sender, err := peer.pc.AddTrack(src.track)
	if err != nil {
		m.logger.Warn("add track failed", "peerToken", peer.token, "sourceToken", srcToken, "error", err)
		return
	}
	peer.senders[srcToken] = sender
}

func (m *MediaManager) removeSenderLocked(peer *mediaPeer, srcToken string) {
	sender, ok := peer.senders[srcToken]
	if !ok {
		return
	}
	_ = peer.pc.RemoveTrack(sender)
	delete(peer.senders, srcToken)
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
