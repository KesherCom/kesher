package app

// media_native.go implements the bridge between the WebRTC SFU and the native
// (UDP) audio relay. It runs alongside MediaManager (see media.go) and exposes
// the small contract defined by udp_audio.go's MediaBridge interface.
//
// Lifecycle:
//   - MediaManager owns this bridge; SetUDPAudioRelay wires the relay in.
//   - When a native client REGISTERs (see UDPAudioRelay.registerPeer), the
//     hub triggers SyncRouting which causes any active native sources to
//     have a fresh routing snapshot pushed to the relay.
//   - When a native source produces an Opus frame, the relay calls back
//     BridgeNativeOpusToWebRTC; we deliver that frame to any browser
//     destination that currently has an open routing gate by writing it as
//     a Sample to a per-source TrackLocalStaticSample.
//   - When a WebRTC source produces RTP, MediaManager's existing forwarding
//     loop writes to per-destination StaticRTP tracks for browser dests AND
//     calls forwardOpusToNativeDests for native dests; that helper extracts
//     the Opus payload and pushes it to the relay's per-token UDP socket.
//
// Stage-1 simplification: per-destination gating for browser destinations of
// a native source is handled at sender-attach time; we add/remove a sender
// (renegotiating) on routing changes rather than gating each frame. Routing
// changes are infrequent compared to PTT changes, so this is acceptable.

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// nativeMediaSource represents a native (UDP-origin) audio source. It carries
// a single shared TrackLocalStaticSample that is attached as a sender to
// every connected WebRTC peer that the routing snapshot says should hear
// this source.
type nativeMediaSource struct {
	userID  string
	track   *webrtc.TrackLocalStaticSample
	senders map[string]*webrtc.RTPSender // destToken -> sender
	// nativeDests are the native destination tokens that currently have an
	// open routing gate for this source. Used by RoutingForSource so the
	// UDP relay can fan-out without re-running routing logic.
	nativeDests map[string]struct{}
	// webrtcDests records the destination tokens we currently have a sender
	// attached to. Used to diff against the latest routing snapshot.
	webrtcDests map[string]struct{}
}

// initNativeBridge is called once during MediaManager construction. It is
// idempotent and only allocates the maps.
func (m *MediaManager) initNativeBridge() {
	m.nativeMu.Lock()
	defer m.nativeMu.Unlock()
	if m.nativeSources == nil {
		m.nativeSources = make(map[string]*nativeMediaSource)
	}
}

// SetUDPAudioRelay wires the relay into MediaManager and registers the
// bidirectional bridge so the relay can push native frames to WebRTC dests.
func (m *MediaManager) SetUDPAudioRelay(relay *UDPAudioRelay) {
	m.initNativeBridge()
	m.nativeMu.Lock()
	m.udpAudio = relay
	m.nativeMu.Unlock()
	if relay != nil {
		relay.SetMediaBridge(m)
	}
}

// EnsureNativeSource is called when a native (UDP) source first delivers a
// frame for a given session token. It creates a shared StaticSample track
// and attaches it to all currently-connected WebRTC peers that the routing
// snapshot says should hear this source.
func (m *MediaManager) EnsureNativeSource(sourceToken string, userID string) error {
	m.initNativeBridge()
	m.nativeMu.Lock()
	if _, ok := m.nativeSources[sourceToken]; ok {
		m.nativeMu.Unlock()
		return nil
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: 48000,
			Channels:  1,
		},
		fmt.Sprintf("audio-user-%s", userID),
		"intercom-native",
	)
	if err != nil {
		m.nativeMu.Unlock()
		return fmt.Errorf("create native source track: %w", err)
	}
	src := &nativeMediaSource{
		userID:      userID,
		track:       track,
		senders:     make(map[string]*webrtc.RTPSender),
		nativeDests: make(map[string]struct{}),
		webrtcDests: make(map[string]struct{}),
	}
	m.nativeSources[sourceToken] = src
	m.nativeMu.Unlock()

	m.recomputeNativeSourceRouting(sourceToken)
	return nil
}

// removeNativeSource removes any tracks and senders associated with a native
// source token (e.g. when its session disconnects).
func (m *MediaManager) removeNativeSource(sourceToken string) {
	m.nativeMu.Lock()
	src, ok := m.nativeSources[sourceToken]
	if !ok {
		m.nativeMu.Unlock()
		return
	}
	delete(m.nativeSources, sourceToken)
	m.nativeMu.Unlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	for destToken, sender := range src.senders {
		_ = sender.ReplaceTrack(nil)
		if peer, ok := m.peers[destToken]; ok {
			_ = peer.pc.RemoveTrack(sender)
			m.requestRenegotiationLocked(peer)
		}
	}
}

// recomputeNativeSourceRouting refreshes which destinations should hear this
// native source. It updates the senders attached to WebRTC peers (adding
// or removing as needed, with renegotiation) and rebuilds nativeDests.
func (m *MediaManager) recomputeNativeSourceRouting(sourceToken string) {
	m.nativeMu.Lock()
	src, ok := m.nativeSources[sourceToken]
	m.nativeMu.Unlock()
	if !ok {
		return
	}

	m.mu.Lock()
	snapshot := m.buildHubSnapshotLocked()
	open := m.computeOpenDestsLocked(sourceToken, src.userID, snapshot)
	// Split into native vs webrtc by consulting hub.IsNativeTransport.
	wantWebRTC := make(map[string]struct{})
	wantNative := make(map[string]struct{})
	for destToken := range open {
		if m.hub != nil && m.hub.IsNativeTransport(destToken) {
			wantNative[destToken] = struct{}{}
		} else if _, ok := m.peers[destToken]; ok {
			wantWebRTC[destToken] = struct{}{}
		}
	}

	// Add senders for newly-open WebRTC dests.
	for destToken := range wantWebRTC {
		if _, already := src.senders[destToken]; already {
			continue
		}
		peer, ok := m.peers[destToken]
		if !ok {
			continue
		}
		sender, err := peer.pc.AddTrack(src.track)
		if err != nil {
			m.logger.Warn("native bridge: add track failed",
				"destToken", destToken, "error", err)
			continue
		}
		src.senders[destToken] = sender
		m.requestRenegotiationLocked(peer)
	}
	// Remove senders for dests that should no longer hear this source.
	for destToken, sender := range src.senders {
		if _, keep := wantWebRTC[destToken]; keep {
			continue
		}
		if peer, ok := m.peers[destToken]; ok {
			_ = peer.pc.RemoveTrack(sender)
			m.requestRenegotiationLocked(peer)
		}
		delete(src.senders, destToken)
	}
	m.mu.Unlock()

	m.nativeMu.Lock()
	src.webrtcDests = wantWebRTC
	src.nativeDests = wantNative
	m.nativeMu.Unlock()
}

// computeOpenDestsLocked returns the set of destination tokens that should
// receive audio from the given source. Mirrors the webrtc-source logic in
// recomputeSourceRoutingWithSnapshotLocked but does not mutate state.
//
// Caller must hold m.mu.
func (m *MediaManager) computeOpenDestsLocked(sourceToken, sourceUserID string, snapshot mediaHubSnapshot) map[string]struct{} {
	open := make(map[string]struct{})
	directTargetUserID := m.directActive[sourceToken]
	broadcastRooms := m.broadcastRoomsForSourceFromSnapshotLocked(sourceToken, snapshot)
	// For native sources there is no entry in m.sources, so fall back to
	// computing talkRooms from the hub snapshot directly.
	talkRooms := m.talkRoomsForSourceFromSnapshotLocked(sourceToken, snapshot)
	if len(talkRooms) == 0 {
		// snapshot already contains the source if its WS is up. The helper
		// only returns rooms when an entry exists, so this is a no-op fallthrough.
		_ = sourceUserID
	}
	_, idleRoomFallbackSuppressed := m.idleRoomFallbackSuppressed[sourceToken]

	for destToken, destClient := range snapshot.clients {
		if destToken == sourceToken {
			continue
		}
		shouldReceive := false
		switch {
		case directTargetUserID != "":
			shouldReceive = destClient.userID == directTargetUserID
		case len(broadcastRooms) > 0:
			shouldReceive = m.peerListensToAnyRoomInSnapshotLocked(destToken, broadcastRooms, snapshot)
		case !idleRoomFallbackSuppressed:
			shouldReceive = m.peerListensToAnyRoomInSnapshotLocked(destToken, talkRooms, snapshot)
		}
		if shouldReceive {
			open[destToken] = struct{}{}
		}
	}
	return open
}

// RoutingForSource is the MediaBridge implementation used by UDPAudioRelay
// to learn which native destinations should receive a given native source's
// audio frames.
func (m *MediaManager) RoutingForSource(sourceToken string) map[string]bool {
	m.nativeMu.RLock()
	src, ok := m.nativeSources[sourceToken]
	m.nativeMu.RUnlock()
	if ok {
		// Recompute lazily to pick up routing changes that arrived via
		// SyncRouting; the snapshot is cheap.
		m.recomputeNativeSourceRouting(sourceToken)
		m.nativeMu.RLock()
		out := make(map[string]bool, len(src.nativeDests))
		for destToken := range src.nativeDests {
			out[destToken] = true
		}
		m.nativeMu.RUnlock()
		return out
	}
	// First frame for this token: attempt to register the source on the fly.
	if m.hub != nil {
		userID := m.hub.userIDForToken(sourceToken)
		if userID != "" {
			_ = m.EnsureNativeSource(sourceToken, userID)
			m.nativeMu.RLock()
			src, ok = m.nativeSources[sourceToken]
			out := map[string]bool{}
			if ok {
				for destToken := range src.nativeDests {
					out[destToken] = true
				}
			}
			m.nativeMu.RUnlock()
			return out
		}
	}
	return map[string]bool{}
}

// BridgeNativeOpusToWebRTC writes a single Opus frame originating from a
// native UDP source to all WebRTC peers that the routing snapshot says
// should hear this source.
func (m *MediaManager) BridgeNativeOpusToWebRTC(sourceToken string, opus []byte) {
	m.nativeMu.RLock()
	src, ok := m.nativeSources[sourceToken]
	m.nativeMu.RUnlock()
	if !ok {
		return
	}
	if len(src.webrtcDests) == 0 {
		return
	}
	// 5 ms framing matches the native side; if the source ever switches to
	// 10 ms, the duration only affects RTP timestamping inside Pion.
	if err := src.track.WriteSample(media_native_sample(opus)); err != nil {
		m.logger.Debug("native bridge: WriteSample failed", "error", err)
	}
}

// forwardOpusToNativeDests is invoked from MediaManager's RTP forwarding
// loop after a WebRTC source produces a packet; it extracts the Opus
// payload and pushes it to the UDP relay for each native destination with
// an open gate.
//
// rtpBytes contains the marshaled RTP packet as read from the remote track.
// Caller must NOT hold m.mu (we acquire RLock internally for the lookup).
func (m *MediaManager) forwardOpusToNativeDests(sourceToken string, rtpBytes []byte) {
	if m == nil {
		return
	}
	m.nativeMu.RLock()
	relay := m.udpAudio
	m.nativeMu.RUnlock()
	if relay == nil {
		return
	}
	// Compute the union of native destinations for this source. We already
	// have the routing in mediaSourceTrack via gate booleans plus the
	// hub-level IsNativeTransport check.
	m.mu.RLock()
	src, ok := m.sources[sourceToken]
	if !ok {
		m.mu.RUnlock()
		return
	}
	nativeTokens := make([]string, 0, 4)
	for destToken, dest := range src.dests {
		if !dest.gate.Load() {
			continue
		}
		if m.hub != nil && m.hub.IsNativeTransport(destToken) {
			nativeTokens = append(nativeTokens, destToken)
		}
	}
	m.mu.RUnlock()
	if len(nativeTokens) == 0 {
		return
	}
	pkt := &rtp.Packet{}
	if err := pkt.Unmarshal(rtpBytes); err != nil {
		return
	}
	for _, destToken := range nativeTokens {
		relay.SendOpusToToken(destToken, pkt.Payload)
	}
}

// nativeMu guards nativeSources and udpAudio. We use a separate mutex from
// MediaManager.mu so the WebRTC fast path doesn't contend with native
// registration.
//
// Note: declared on a helper struct here to avoid editing MediaManager's
// existing mutex layout in media.go.

// media_native_sample builds a Pion media.Sample from an Opus frame using
// the 5-ms native frame duration.
//
// We use a tiny wrapper to keep import locality simple.
func media_native_sample(opus []byte) (s nativeSample) {
	s.Data = opus
	s.Duration = 5 * time.Millisecond
	return
}

// nativeSample is a thin shim around webrtc/media.Sample to avoid a dotted
// import here; we re-export the same struct shape via interface satisfaction.
//
// Pion's TrackLocalStaticSample.WriteSample takes the concrete type
// `media.Sample`, so we alias it through the imported package.
type nativeSample = mediaSample

// MediaManager additions used by media_native.go
//
// Fields below are added to MediaManager's struct in media.go via this file
// using Go's "promoted fields are split-package only" mechanism — but Go
// does not actually allow that. We therefore declare the additional fields
// in media.go via the small patch elsewhere in this PR. The aliases below
// are referenced in this file and reside on the existing MediaManager.
var _ = (*MediaManager)(nil) // ensure type is accessible here

// Forward declarations used by this file but defined elsewhere in the
// package. Listed here for readability.
//
//   m.nativeMu sync.RWMutex
//   m.nativeSources map[string]*nativeMediaSource
//   m.udpAudio *UDPAudioRelay
//
// See the field additions in media.go.

// A small compile-time assertion that MediaManager implements MediaBridge.
var _ MediaBridge = (*MediaManager)(nil)

// guarantee atomic-bool import for native dest gates if used elsewhere.
var _ = atomic.Bool{}
var _ sync.RWMutex
