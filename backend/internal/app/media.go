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

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// mediaSample is a package-local alias for the Pion sample type, used by
// the native UDP bridge in media_native.go to avoid a second package import
// path there.
type mediaSample = media.Sample

// routedDest holds a per-destination local track and an atomic routing gate.
// The gate is flipped by recomputeSourceRoutingLocked; the RTP forwarding loop
// reads it lock-free to decide whether to forward each packet.
type routedDest struct {
	localTrack *webrtc.TrackLocalStaticRTP
	gate       atomic.Bool
}

type mediaSourceTrack struct {
	codec  webrtc.RTPCodecCapability
	userID string
	dests  map[string]*routedDest // key: destination peer token
}

type mediaSnapshotClient struct {
	userID      string
	roleID      string
	listenRooms map[string]struct{}
	talkRooms   map[string]struct{}
}

type mediaHubSnapshot struct {
	clients map[string]mediaSnapshotClient
}

type MediaRealtimeStats struct {
	Peers                 int    `json:"peers"`
	Sources               int    `json:"sources"`
	SyncRequests          uint64 `json:"syncRequests"`
	SyncRuns              uint64 `json:"syncRuns"`
	SyncRequestsCoalesced uint64 `json:"syncRequestsCoalesced"`
	SyncDirtySourcesAvg   uint64 `json:"syncDirtySourcesAvg"`
	SyncDirtySourcesMax   uint64 `json:"syncDirtySourcesMax"`
	SyncRunAvgMs          uint64 `json:"syncRunAvgMs"`
	SyncRunMaxMs          uint64 `json:"syncRunMaxMs"`
	SyncLockWaitAvgMs     uint64 `json:"syncLockWaitAvgMs"`
	SyncLockWaitMaxMs     uint64 `json:"syncLockWaitMaxMs"`
	SyncLockHoldAvgMs     uint64 `json:"syncLockHoldAvgMs"`
	SyncLockHoldMaxMs     uint64 `json:"syncLockHoldMaxMs"`
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
	ready                bool
	renegotiating        bool
	pendingRenegotiate   bool
	lastSenderSetHash    uint64
	lastSenderSetHashSet bool
	renegotiateTimer     *time.Timer
	pendingICECandidates []webrtc.ICECandidateInit
}

type MediaManager struct {
	mu                         sync.RWMutex
	logger                     *slog.Logger
	hub                        *Hub
	peers                      map[string]*mediaPeer
	sources                    map[string]*mediaSourceTrack   // sourceToken -> track
	broadcastActive            map[string]map[string]struct{} // sourceToken -> broadcastGroupID set
	directActive               map[string]string              // sourceToken -> targetUserID
	idleRoomFallbackSuppressed map[string]struct{}            // sourceToken -> suppressed after direct/broadcast release while mic is idle
	dirtySources               map[string]struct{}            // sourceToken set for incremental recompute
	syncForceAll               bool
	syncScheduled              bool
	syncRequests               atomic.Uint64
	syncRuns                   atomic.Uint64
	syncMerged                 atomic.Uint64
	syncDirtySourcesTotal      atomic.Uint64
	syncDirtySourcesMax        atomic.Uint64
	syncRunTotalNanos          atomic.Uint64
	syncRunMaxNanos            atomic.Uint64
	syncLockWaitTotalNanos     atomic.Uint64
	syncLockWaitMaxNanos       atomic.Uint64
	syncLockHoldTotalNanos     atomic.Uint64
	syncLockHoldMaxNanos       atomic.Uint64
	voiceStateTriggerNanos     atomic.Uint64
	voiceStateToSyncCount      atomic.Uint64
	voiceStateToSyncTotalNanos atomic.Uint64
	voiceStateToSyncMaxNanos   atomic.Uint64
	renegotiations             atomic.Uint64
	renegotiationTotalNanos    atomic.Uint64
	renegotiationMaxNanos      atomic.Uint64
	webrtcAPI                  *webrtc.API
	// Native UDP audio bridge (see media_native.go). nativeMu guards both
	// fields and is held only briefly during registration / routing recompute;
	// the WebRTC fast path never touches it.
	nativeMu      sync.RWMutex
	nativeSources map[string]*nativeMediaSource
	udpAudio      *UDPAudioRelay
}

const syncRoutingDebounce = 1 * time.Millisecond
const renegotiationDebounce = 5 * time.Millisecond

// buildWebRTCAPI creates a Pion webrtc.API tuned for low-latency audio-only SFU.
// It registers only the Opus codec, disables mDNS for faster ICE, and uses a
// minimal interceptor set (NACK generator only, no responder/TWCC).
func buildWebRTCAPI(logger *slog.Logger) (*webrtc.API, error) {
	// ── MediaEngine: Opus only ─────────────────────────────────────────────
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=2;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register opus codec: %w", err)
	}

	// ── InterceptorRegistry: minimal ───────────────────────────────────────
	ir := &interceptor.Registry{}
	// NACK generator lets the receiver request retransmission if it notices a
	// gap.  We skip the NACK responder (server-side retransmit) to avoid
	// the latency of buffering outgoing packets.
	generator, err := nack.NewGeneratorInterceptor()
	if err != nil {
		return nil, fmt.Errorf("nack generator: %w", err)
	}
	ir.Add(generator)

	// ── SettingEngine ──────────────────────────────────────────────────────
	se := webrtc.SettingEngine{}
	// Disable mDNS so ICE candidates resolve immediately on LAN.
	se.SetICEMulticastDNSMode(0) // ice.MulticastDNSModeDisabled == 0
	// Increased replay window to tolerate more packet reordering on jittery networks
	se.SetSRTPReplayProtectionWindow(128)
	se.SetReceiveMTU(1200)

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(me),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	)
	logger.Info("webrtc API built: opus-only, minimal interceptors, mDNS disabled")
	return api, nil
}

func NewMediaManager(hub *Hub, logger *slog.Logger) *MediaManager {
	api, err := buildWebRTCAPI(logger)
	if err != nil {
		logger.Error("failed to build low-latency webrtc API, falling back to defaults", "error", err)
		api = webrtc.NewAPI()
	}
	return &MediaManager{
		logger:                     logger,
		hub:                        hub,
		peers:                      make(map[string]*mediaPeer),
		sources:                    make(map[string]*mediaSourceTrack),
		broadcastActive:            make(map[string]map[string]struct{}),
		directActive:               make(map[string]string),
		idleRoomFallbackSuppressed: make(map[string]struct{}),
		dirtySources:               make(map[string]struct{}),
		webrtcAPI:                  api,
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
	pc, err := m.webrtcAPI.NewPeerConnection(webrtc.Configuration{})
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

	// Pre-attach existing source tracks to this new peer so audio can flow
	// instantly when routing gates open (no renegotiation needed later).
	for sourceToken := range m.sources {
		m.recomputeSourceRoutingLocked(sourceToken)
	}

	return nil
}

func (m *MediaManager) SyncRouting() {
	m.syncRoutingWithDirty("")
}

func (m *MediaManager) SyncRoutingSource(sourceToken string) {
	m.syncRoutingWithDirty(sourceToken)
}

func (m *MediaManager) syncRoutingWithDirty(sourceToken string) {
	m.syncRequests.Add(1)
	m.mu.Lock()
	if sourceToken == "" {
		m.syncForceAll = true
	} else {
		m.dirtySources[sourceToken] = struct{}{}
	}
	if m.syncScheduled {
		m.syncMerged.Add(1)
		m.mu.Unlock()
		return
	}
	m.syncScheduled = true
	m.mu.Unlock()
	time.AfterFunc(syncRoutingDebounce, func() {
		lockWaitStart := time.Now()
		m.mu.Lock()
		recordDurationNanos(&m.syncLockWaitTotalNanos, &m.syncLockWaitMaxNanos, time.Since(lockWaitStart))
		lockHoldStart := time.Now()
		m.syncScheduled = false
		m.syncRuns.Add(1)
		recordVoiceStateToSyncNanos(&m.voiceStateTriggerNanos, &m.voiceStateToSyncCount, &m.voiceStateToSyncTotalNanos, &m.voiceStateToSyncMaxNanos)
		start := time.Now()
		recomputedSources := m.recomputePendingSourcesLocked()
		m.syncDirtySourcesTotal.Add(uint64(recomputedSources))
		updateMax(&m.syncDirtySourcesMax, uint64(recomputedSources))
		recordDurationNanos(&m.syncRunTotalNanos, &m.syncRunMaxNanos, time.Since(start))
		recordDurationNanos(&m.syncLockHoldTotalNanos, &m.syncLockHoldMaxNanos, time.Since(lockHoldStart))
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
	syncDirtySourcesAvg := uint64(0)
	syncLockWaitAvgMs := uint64(0)
	syncLockHoldAvgMs := uint64(0)
	if syncRuns > 0 {
		syncAvgMs = (m.syncRunTotalNanos.Load() / syncRuns) / uint64(time.Millisecond)
		syncDirtySourcesAvg = m.syncDirtySourcesTotal.Load() / syncRuns
		syncLockWaitAvgMs = (m.syncLockWaitTotalNanos.Load() / syncRuns) / uint64(time.Millisecond)
		syncLockHoldAvgMs = (m.syncLockHoldTotalNanos.Load() / syncRuns) / uint64(time.Millisecond)
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
		SyncDirtySourcesAvg:   syncDirtySourcesAvg,
		SyncDirtySourcesMax:   m.syncDirtySourcesMax.Load(),
		SyncRunAvgMs:          syncAvgMs,
		SyncRunMaxMs:          m.syncRunMaxNanos.Load() / uint64(time.Millisecond),
		SyncLockWaitAvgMs:     syncLockWaitAvgMs,
		SyncLockWaitMaxMs:     m.syncLockWaitMaxNanos.Load() / uint64(time.Millisecond),
		SyncLockHoldAvgMs:     syncLockHoldAvgMs,
		SyncLockHoldMaxMs:     m.syncLockHoldMaxNanos.Load() / uint64(time.Millisecond),
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
	peer.ready = true
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

	// Clean up per-dest entries referencing this peer from all sources.
	for _, src := range m.sources {
		delete(src.dests, token)
	}

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
	codec := remote.Codec().RTPCodecCapability

	m.mu.Lock()
	src := &mediaSourceTrack{
		codec:  codec,
		userID: sourcePeer.userID,
		dests:  make(map[string]*routedDest),
	}
	m.sources[sourcePeer.token] = src
	m.recomputeSourceRoutingLocked(sourcePeer.token)
	m.mu.Unlock()

	buf := make([]byte, 2048)
	for {
		n, _, readErr := remote.Read(buf)
		if readErr != nil {
			break
		}
		// RLock allows concurrent forwarding from multiple sources while
		// routing changes (which need a full Lock) remain infrequent.
		m.mu.RLock()
		hasNativeDest := false
		if s := m.sources[sourcePeer.token]; s != nil {
			for destToken, dest := range s.dests {
				if dest.gate.Load() {
					if _, err := dest.localTrack.Write(buf[:n]); err != nil {
						// Log RTP write failures for diagnostics; may indicate full send buffer or peer disconnection
						m.logger.Debug("rtp forward write failed", "dest_token", destToken, "error", err)
					}
					if !hasNativeDest && m.hub != nil && m.hub.IsNativeTransport(destToken) {
						hasNativeDest = true
					}
				}
			}
		}
		m.mu.RUnlock()
		// Stage-1 native bridge: when at least one native (UDP) destination is
		// open for this WebRTC source, also push the Opus payload to the relay.
		if hasNativeDest {
			m.forwardOpusToNativeDests(sourcePeer.token, buf[:n])
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
	// Tear down any native-bridge state for this token as well.
	m.removeNativeSource(sourcePeer.token)
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

func (m *MediaManager) recomputePendingSourcesLocked() int {
	snapshot := m.buildHubSnapshotLocked()
	if m.syncForceAll || len(m.dirtySources) == 0 {
		m.syncForceAll = false
		for sourceToken := range m.sources {
			m.recomputeSourceRoutingWithSnapshotLocked(sourceToken, snapshot)
		}
		for sourceToken := range m.dirtySources {
			delete(m.dirtySources, sourceToken)
		}
		return len(m.sources)
	}
	recomputed := 0
	for sourceToken := range m.dirtySources {
		if _, ok := m.sources[sourceToken]; !ok {
			delete(m.dirtySources, sourceToken)
			continue
		}
		m.recomputeSourceRoutingWithSnapshotLocked(sourceToken, snapshot)
		recomputed++
		delete(m.dirtySources, sourceToken)
	}
	return recomputed
}

func (m *MediaManager) recomputeSourceRoutingLocked(sourceToken string) {
	snapshot := m.buildHubSnapshotLocked()
	m.recomputeSourceRoutingWithSnapshotLocked(sourceToken, snapshot)
}

func (m *MediaManager) recomputeSourceRoutingWithSnapshotLocked(sourceToken string, snapshot mediaHubSnapshot) {
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
	broadcastRooms := m.broadcastRoomsForSourceFromSnapshotLocked(sourceToken, snapshot)
	talkRooms := m.talkRoomsForSourceFromSnapshotLocked(sourceToken, snapshot)
	_, idleRoomFallbackSuppressed := m.idleRoomFallbackSuppressed[sourceToken]

	for _, p := range m.peers {
		if p.token == sourceToken {
			continue
		}

		// Ensure a per-destination track exists (pre-attachment).
		if _, exists := src.dests[p.token]; !exists {
			localTrack, err := webrtc.NewTrackLocalStaticRTP(
				src.codec,
				fmt.Sprintf("audio-user-%s", src.userID),
				"intercom",
			)
			if err != nil {
				m.logger.Warn("create per-dest track failed", "destPeer", p.token, "error", err)
				continue
			}
			sender, err := p.pc.AddTrack(localTrack)
			if err != nil {
				m.logger.Warn("pre-attach track failed", "destPeer", p.token, "sourceToken", sourceToken, "error", err)
				continue
			}
			p.senders[sourceToken] = sender
			src.dests[p.token] = &routedDest{localTrack: localTrack}
			m.requestRenegotiationLocked(p)
		}

		// Compute the routing gate — instant, no renegotiation.
		shouldReceive := false
		if directTargetPeerToken != "" {
			shouldReceive = p.token == directTargetPeerToken
		} else if len(broadcastRooms) > 0 {
			shouldReceive = m.peerListensToAnyRoomInSnapshotLocked(p.token, broadcastRooms, snapshot)
		} else if !idleRoomFallbackSuppressed {
			shouldReceive = m.peerListensToAnyRoomInSnapshotLocked(p.token, talkRooms, snapshot)
		}
		src.dests[p.token].gate.Store(shouldReceive)
	}

	// Remove stale destinations for peers that no longer exist.
	for destToken := range src.dests {
		if _, exists := m.peers[destToken]; !exists {
			delete(src.dests, destToken)
		}
	}
}

func (m *MediaManager) buildHubSnapshotLocked() mediaHubSnapshot {
	m.hub.mu.RLock()
	defer m.hub.mu.RUnlock()
	snapshot := mediaHubSnapshot{clients: make(map[string]mediaSnapshotClient, len(m.hub.clients))}
	for token, c := range m.hub.clients {
		snapshot.clients[token] = mediaSnapshotClient{
			userID:      c.user.ID,
			roleID:      c.session.RoleID,
			listenRooms: cloneRoomSet(c.listenRooms),
			talkRooms:   cloneRoomSet(c.talkRooms),
		}
	}
	return snapshot
}

func (m *MediaManager) talkRoomsForSourceFromSnapshotLocked(sourceToken string, snapshot mediaHubSnapshot) map[string]struct{} {
	sourceClient, ok := snapshot.clients[sourceToken]
	if !ok || len(sourceClient.talkRooms) == 0 {
		return map[string]struct{}{}
	}
	rooms := make(map[string]struct{}, len(sourceClient.talkRooms))
	for roomID := range sourceClient.talkRooms {
		allowed, err := m.hub.store.RoomAllowsSenderRole(context.Background(), roomID, sourceClient.roleID)
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

func (m *MediaManager) peerListensToAnyRoomInSnapshotLocked(peerToken string, roomSet map[string]struct{}, snapshot mediaHubSnapshot) bool {
	if len(roomSet) == 0 {
		return false
	}
	peerClient, ok := snapshot.clients[peerToken]
	if !ok {
		return false
	}
	for roomID := range peerClient.listenRooms {
		if _, ok := roomSet[roomID]; !ok {
			continue
		}
		allowed, err := m.hub.store.RoomAllowsReceiverRole(context.Background(), roomID, peerClient.roleID)
		if err != nil {
			continue
		}
		if allowed {
			return true
		}
	}
	return false
}

func (m *MediaManager) broadcastRoomsForSourceFromSnapshotLocked(sourceToken string, snapshot mediaHubSnapshot) map[string]struct{} {
	groups := m.broadcastActive[sourceToken]
	if len(groups) == 0 {
		return map[string]struct{}{}
	}
	sourceClient, ok := snapshot.clients[sourceToken]
	if !ok {
		return map[string]struct{}{}
	}
	rooms := make(map[string]struct{})
	for groupID := range groups {
		allowed, err := m.hub.store.BroadcastGroupAllowsRole(context.Background(), groupID, sourceClient.roleID)
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
			canSend, err := m.hub.store.RoomAllowsSenderRole(context.Background(), roomID, sourceClient.roleID)
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

func cloneRoomSet(src map[string]struct{}) map[string]struct{} {
	if len(src) == 0 {
		return map[string]struct{}{}
	}
	cloned := make(map[string]struct{}, len(src))
	for roomID := range src {
		cloned[roomID] = struct{}{}
	}
	return cloned
}

func (m *MediaManager) removeSenderLocked(peer *mediaPeer, srcToken string) bool {
	sender, ok := peer.senders[srcToken]
	if !ok {
		return false
	}
	_ = peer.pc.RemoveTrack(sender)
	delete(peer.senders, srcToken)
	// Also remove the per-destination routing entry if the source still exists.
	if src, ok := m.sources[srcToken]; ok {
		delete(src.dests, peer.token)
	}
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
	if !peer.ready {
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
	updateMax(max, nanos)
}

func updateMax(max *atomic.Uint64, value uint64) {
	for {
		current := max.Load()
		if value <= current {
			return
		}
		if max.CompareAndSwap(current, value) {
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
