package app

import (
	"context"
	"fmt"
	"hash/fnv"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

type mediaSourceTrack struct {
	track *webrtc.TrackLocalStaticRTP
}

type MediaRealtimeStats struct {
	Peers                 int    `json:"peers"`
	Sources               int    `json:"sources"`
	SyncRequests          uint64 `json:"syncRequests"`
	SyncRuns              uint64 `json:"syncRuns"`
	SyncRequestsCoalesced uint64 `json:"syncRequestsCoalesced"`
	SyncRunAvgMs          uint64 `json:"syncRunAvgMs"`
	SyncRunMaxMs          uint64 `json:"syncRunMaxMs"`
	VoiceStateToSyncAvgMs uint64 `json:"voiceStateToSyncAvgMs"`
	VoiceStateToSyncMaxMs uint64 `json:"voiceStateToSyncMaxMs"`
	Renegotiations        uint64 `json:"renegotiations"`
	RenegotiationAvgMs    uint64 `json:"renegotiationAvgMs"`
	RenegotiationMaxMs    uint64 `json:"renegotiationMaxMs"`
}

type mediaPeer struct {
	token                string
	userID               string
	pc                   *webrtc.PeerConnection
	senders              map[string]*webrtc.RTPSender
	renegotiating        bool
	pendingRenegotiate   bool
	lastSenderSetHash    uint64
	lastSenderSetHashSet bool
	renegotiateTimer     *time.Timer
	pendingICECandidates []webrtc.ICECandidateInit
}

type MediaManager struct {
	mu                         sync.Mutex
	logger                     *slog.Logger
	hub                        *Hub
	peers                      map[string]*mediaPeer
	sources                    map[string]*mediaSourceTrack   // sourceToken -> track
	broadcastActive            map[string]map[string]struct{} // sourceToken -> broadcastGroupID set
	directActive               map[string]string              // sourceToken -> targetUserID
	idleRoomFallbackSuppressed map[string]struct{}            // sourceToken -> suppressed after direct/broadcast release while mic is idle
	syncScheduled              bool
	syncRequests               atomic.Uint64
	syncRuns                   atomic.Uint64
	syncMerged                 atomic.Uint64
	syncRunTotalNanos          atomic.Uint64
	syncRunMaxNanos            atomic.Uint64
	voiceStateTriggerNanos     atomic.Uint64
	voiceStateToSyncCount      atomic.Uint64
	voiceStateToSyncTotalNanos atomic.Uint64
	voiceStateToSyncMaxNanos   atomic.Uint64
	renegotiations             atomic.Uint64
	renegotiationTotalNanos    atomic.Uint64
	renegotiationMaxNanos      atomic.Uint64
}

const syncRoutingDebounce = 10 * time.Millisecond
const renegotiationDebounce = 20 * time.Millisecond

func NewMediaManager(hub *Hub, logger *slog.Logger) *MediaManager {
	return &MediaManager{
		logger:                     logger,
		hub:                        hub,
		peers:                      make(map[string]*mediaPeer),
		sources:                    make(map[string]*mediaSourceTrack),
		broadcastActive:            make(map[string]map[string]struct{}),
		directActive:               make(map[string]string),
		idleRoomFallbackSuppressed: make(map[string]struct{}),
	}
}

func (m *MediaManager) sourceMicEnabledLocked(sourceToken string) bool {
	m.hub.mu.RLock()
	defer m.hub.mu.RUnlock()
	c, ok := m.hub.clients[sourceToken]
	return ok && c.micEnabled
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
	m.syncRequests.Add(1)
	m.mu.Lock()
	if m.syncScheduled {
		m.syncMerged.Add(1)
		m.mu.Unlock()
		return
	}
	m.syncScheduled = true
	m.mu.Unlock()
	time.AfterFunc(syncRoutingDebounce, func() {
		m.mu.Lock()
		m.syncScheduled = false
		m.syncRuns.Add(1)
		recordVoiceStateToSyncNanos(&m.voiceStateTriggerNanos, &m.voiceStateToSyncCount, &m.voiceStateToSyncTotalNanos, &m.voiceStateToSyncMaxNanos)
		start := time.Now()
		m.recomputeAllSourcesLocked()
		recordDurationNanos(&m.syncRunTotalNanos, &m.syncRunMaxNanos, time.Since(start))
		m.mu.Unlock()
	})
}

func (m *MediaManager) NoteVoiceStateTrigger() {
	m.voiceStateTriggerNanos.Store(uint64(time.Now().UnixNano()))
}

func (m *MediaManager) RealtimeStats() MediaRealtimeStats {
	syncRuns := m.syncRuns.Load()
	renegotiations := m.renegotiations.Load()
	voiceStateToSyncCount := m.voiceStateToSyncCount.Load()
	syncAvgMs := uint64(0)
	if syncRuns > 0 {
		syncAvgMs = (m.syncRunTotalNanos.Load() / syncRuns) / uint64(time.Millisecond)
	}
	voiceStateToSyncAvgMs := uint64(0)
	if voiceStateToSyncCount > 0 {
		voiceStateToSyncAvgMs = (m.voiceStateToSyncTotalNanos.Load() / voiceStateToSyncCount) / uint64(time.Millisecond)
	}
	renegotiationAvgMs := uint64(0)
	if renegotiations > 0 {
		renegotiationAvgMs = (m.renegotiationTotalNanos.Load() / renegotiations) / uint64(time.Millisecond)
	}

	m.mu.Lock()
	stats := MediaRealtimeStats{
		Peers:                 len(m.peers),
		Sources:               len(m.sources),
		SyncRequests:          m.syncRequests.Load(),
		SyncRuns:              syncRuns,
		SyncRequestsCoalesced: m.syncMerged.Load(),
		SyncRunAvgMs:          syncAvgMs,
		SyncRunMaxMs:          m.syncRunMaxNanos.Load() / uint64(time.Millisecond),
		VoiceStateToSyncAvgMs: voiceStateToSyncAvgMs,
		VoiceStateToSyncMaxMs: m.voiceStateToSyncMaxNanos.Load() / uint64(time.Millisecond),
		Renegotiations:        renegotiations,
		RenegotiationAvgMs:    renegotiationAvgMs,
		RenegotiationMaxMs:    m.renegotiationMaxNanos.Load() / uint64(time.Millisecond),
	}
	m.mu.Unlock()
	return stats
}

func (m *MediaManager) EnsureNegotiation(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	peer, ok := m.peers[token]
	if !ok {
		return
	}
	m.requestRenegotiationLocked(peer)
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
		m.maybeRenegotiateLocked(peer)
		if peer.pendingRenegotiate {
			m.scheduleRenegotiationLocked(peer.token)
		}
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
	if peer.renegotiateTimer != nil {
		peer.renegotiateTimer.Stop()
		peer.renegotiateTimer = nil
	}
	_ = peer.pc.Close()
	delete(m.peers, token)
	delete(m.broadcastActive, token)
	delete(m.directActive, token)
	delete(m.idleRoomFallbackSuppressed, token)
	delete(m.sources, token)

	var affectedSources []string
	for sourceToken, targetUserID := range m.directActive {
		if targetUserID == peer.userID {
			delete(m.directActive, sourceToken)
			if !m.sourceMicEnabledLocked(sourceToken) {
				m.idleRoomFallbackSuppressed[sourceToken] = struct{}{}
			}
			affectedSources = append(affectedSources, sourceToken)
		}
	}

	for _, p := range m.peers {
		if m.removeSenderLocked(p, token) {
			m.requestRenegotiationLocked(p)
		}
	}
	for _, sourceToken := range affectedSources {
		m.recomputeSourceRoutingLocked(sourceToken)
	}
}

func (m *MediaManager) handleRemoteTrack(sourcePeer *mediaPeer, remote *webrtc.TrackRemote) {
	localTrack, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, fmt.Sprintf("audio-user-%s", sourcePeer.userID), "intercom")
	if err != nil {
		m.logger.Error("failed to create local track", "error", err)
		return
	}
	m.mu.Lock()
	m.sources[sourcePeer.token] = &mediaSourceTrack{track: localTrack}
	m.recomputeSourceRoutingLocked(sourcePeer.token)
	m.mu.Unlock()
	buf := make([]byte, 2048)

	for {
		n, _, readErr := remote.Read(buf)
		if readErr != nil {
			break
		}
		if _, writeErr := localTrack.Write(buf[:n]); writeErr != nil {
			break
		}
	}

	m.mu.Lock()
	delete(m.sources, sourcePeer.token)
	for _, p := range m.peers {
		if m.removeSenderLocked(p, sourcePeer.token) {
			m.requestRenegotiationLocked(p)
		}
	}
	m.mu.Unlock()
}

func (m *MediaManager) SetBroadcastGroupActive(sourceToken, groupID string, enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if enabled {
		delete(m.idleRoomFallbackSuppressed, sourceToken)
		if _, ok := m.broadcastActive[sourceToken]; !ok {
			m.broadcastActive[sourceToken] = make(map[string]struct{})
		}
		if _, alreadyActive := m.broadcastActive[sourceToken][groupID]; alreadyActive {
			return
		}
		m.broadcastActive[sourceToken][groupID] = struct{}{}
	} else {
		if groups, ok := m.broadcastActive[sourceToken]; ok {
			if _, existed := groups[groupID]; !existed {
				return
			}
			delete(groups, groupID)
			if len(groups) == 0 {
				delete(m.broadcastActive, sourceToken)
			}
		} else {
			return
		}
		if _, stillActive := m.broadcastActive[sourceToken]; !stillActive && !m.sourceMicEnabledLocked(sourceToken) {
			m.idleRoomFallbackSuppressed[sourceToken] = struct{}{}
		}
	}
	m.recomputeSourceRoutingLocked(sourceToken)
}

func (m *MediaManager) SetDirectTargetActive(sourceToken, targetUserID string, enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if enabled {
		delete(m.idleRoomFallbackSuppressed, sourceToken)
		if currentTarget, ok := m.directActive[sourceToken]; ok && currentTarget == targetUserID {
			return
		}
		m.directActive[sourceToken] = targetUserID
	} else if currentTarget, ok := m.directActive[sourceToken]; ok {
		if currentTarget == targetUserID || targetUserID == "" {
			delete(m.directActive, sourceToken)
			if !m.sourceMicEnabledLocked(sourceToken) {
				m.idleRoomFallbackSuppressed[sourceToken] = struct{}{}
			}
		} else {
			return
		}
	} else {
		return
	}
	m.recomputeSourceRoutingLocked(sourceToken)
}

func (m *MediaManager) SetIdleRoomFallbackSuppressed(sourceToken string, suppressed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if suppressed {
		m.idleRoomFallbackSuppressed[sourceToken] = struct{}{}
	} else {
		delete(m.idleRoomFallbackSuppressed, sourceToken)
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
	_, idleRoomFallbackSuppressed := m.idleRoomFallbackSuppressed[sourceToken]

	for _, p := range m.peers {
		if p.token == sourceToken {
			continue
		}
		shouldReceive := false
		if directTargetPeerToken != "" {
			shouldReceive = p.token == directTargetPeerToken
		} else if len(broadcastRooms) > 0 {
			shouldReceive = m.peerListensToAnyRoomLocked(p.token, broadcastRooms)
		} else if !idleRoomFallbackSuppressed {
			shouldReceive = m.peerListensToAnyRoomLocked(p.token, talkRooms)
		}

		if shouldReceive {
			if m.attachSourceToPeerLocked(sourceToken, src, p) {
				m.requestRenegotiationLocked(p)
			}
			continue
		}
		if m.removeSenderLocked(p, sourceToken) {
			m.requestRenegotiationLocked(p)
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
		allowed, err := m.hub.store.RoomAllowsSenderRole(context.Background(), roomID, c.session.RoleID)
		if err != nil {
			continue
		}
		if !allowed {
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
		allowed, err := m.hub.store.RoomAllowsReceiverRole(context.Background(), roomID, c.session.RoleID)
		if err != nil {
			continue
		}
		if allowed {
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
		allowed, err := m.hub.store.BroadcastGroupAllowsRole(context.Background(), groupID, sourceClient.session.RoleID)
		if err != nil {
			m.logger.Warn("broadcast group role lookup failed", "groupId", groupID, "error", err)
			continue
		}
		if !allowed {
			continue
		}
		roomIDs, err := m.hub.store.BroadcastGroupRoomIDs(context.Background(), groupID)
		if err != nil {
			m.logger.Warn("broadcast group room lookup failed", "groupId", groupID, "error", err)
			continue
		}
		for _, roomID := range roomIDs {
			canSend, err := m.hub.store.RoomAllowsSenderRole(context.Background(), roomID, sourceClient.session.RoleID)
			if err != nil {
				continue
			}
			if !canSend {
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

func senderSetHash(senders map[string]*webrtc.RTPSender) uint64 {
	if len(senders) == 0 {
		return 0
	}
	tokens := make([]string, 0, len(senders))
	for token := range senders {
		tokens = append(tokens, token)
	}
	sort.Strings(tokens)
	h := fnv.New64a()
	for _, token := range tokens {
		_, _ = h.Write([]byte(token))
		_, _ = h.Write([]byte{0})
	}
	return h.Sum64()
}

func (m *MediaManager) requestRenegotiationLocked(peer *mediaPeer) {
	peer.pendingRenegotiate = true
	m.scheduleRenegotiationLocked(peer.token)
}

func (m *MediaManager) scheduleRenegotiationLocked(token string) {
	peer, ok := m.peers[token]
	if !ok {
		return
	}
	if peer.renegotiateTimer != nil {
		return
	}
	peer.renegotiateTimer = time.AfterFunc(renegotiationDebounce, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		peer, ok := m.peers[token]
		if !ok {
			return
		}
		peer.renegotiateTimer = nil
		m.maybeRenegotiateLocked(peer)
		if peer.pendingRenegotiate {
			m.scheduleRenegotiationLocked(token)
		}
	})
}

func (m *MediaManager) maybeRenegotiateLocked(peer *mediaPeer) {
	if !peer.pendingRenegotiate {
		return
	}
	if peer.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		peer.pendingRenegotiate = false
		return
	}
	if peer.pc.SignalingState() != webrtc.SignalingStateStable || peer.renegotiating {
		return
	}
	nextSenderSetHash := senderSetHash(peer.senders)
	if peer.lastSenderSetHashSet && peer.lastSenderSetHash == nextSenderSetHash {
		peer.pendingRenegotiate = false
		return
	}
	peer.pendingRenegotiate = false
	peer.renegotiating = true
	start := time.Now()
	offer, err := peer.pc.CreateOffer(nil)
	if err != nil {
		peer.renegotiating = false
		peer.pendingRenegotiate = true
		m.scheduleRenegotiationLocked(peer.token)
		m.logger.Warn("create offer failed", "token", peer.token, "error", err)
		return
	}
	if err := peer.pc.SetLocalDescription(offer); err != nil {
		peer.renegotiating = false
		peer.pendingRenegotiate = true
		m.scheduleRenegotiationLocked(peer.token)
		m.logger.Warn("set local description failed", "token", peer.token, "error", err)
		return
	}
	peer.lastSenderSetHashSet = true
	peer.lastSenderSetHash = nextSenderSetHash
	m.renegotiations.Add(1)
	m.sendWS(peer.token, WSOutbound{
		Type: "webrtc_offer",
		Data: WebRTCOffer{SDP: offer.SDP},
	})
	recordDurationNanos(&m.renegotiationTotalNanos, &m.renegotiationMaxNanos, time.Since(start))
}

func recordDurationNanos(total, max *atomic.Uint64, d time.Duration) {
	nanos := uint64(d)
	total.Add(nanos)
	for {
		current := max.Load()
		if nanos <= current {
			return
		}
		if max.CompareAndSwap(current, nanos) {
			return
		}
	}
}

func recordVoiceStateToSyncNanos(trigger, count, total, max *atomic.Uint64) {
	triggerNanos := trigger.Load()
	if triggerNanos == 0 {
		return
	}
	nowNanos := uint64(time.Now().UnixNano())
	if nowNanos <= triggerNanos {
		return
	}
	latencyNanos := nowNanos - triggerNanos
	if latencyNanos > uint64(3*time.Second) {
		return
	}
	count.Add(1)
	total.Add(latencyNanos)
	for {
		current := max.Load()
		if latencyNanos <= current {
			return
		}
		if max.CompareAndSwap(current, latencyNanos) {
			return
		}
	}
}

func (m *MediaManager) sendWS(token string, msg WSOutbound) {
	m.hub.mu.RLock()
	defer m.hub.mu.RUnlock()
	c, ok := m.hub.clients[token]
	if !ok {
		return
	}
	m.hub.enqueueOutbound(c, msg)
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
