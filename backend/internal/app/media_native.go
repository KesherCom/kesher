package app

// media_native.go implements the bridge between the WebRTC SFU and the native
// (UDP) audio relay. It runs alongside MediaManager (see media.go) and exposes
// the small contract defined by udp_audio.go's MediaBridge interface.
//
// Routing model:
//   - Routing is computed whenever it can change (SyncRouting, PTT/direct/
//     broadcast changes, peer join/leave), always under m.mu, and published
//     as immutable destination lists through atomic pointers.
//   - The per-frame paths (UDP relay fan-out, WebRTC forwarding loop) only
//     load those pointers. They never take m.mu or the hub lock, so a
//     routing change cannot stall audio forwarding.
//
// Data flow:
//   - Native source -> native dests: UDPAudioRelay sends to the list from
//     NativeDestsForSource, preserving the source's sequence/timestamp.
//   - Native source -> browser dests: BridgeNativeOpusToWebRTC writes the frame
//     as a Sample to a per-source TrackLocalStaticSample that is attached
//     (with renegotiation) to every browser peer that should hear it.
//   - Browser source -> native dests: MediaManager's RTP forwarding loop calls
//     forwardOpusToNativeDests with the source's precomputed native dest list.

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// nativeRoutingRefreshInterval is a safety net only: every routing change is
// pushed explicitly, but a stale list self-heals after this long. The refresh
// runs off the frame path.
const nativeRoutingRefreshInterval = 1 * time.Second

// nativeMediaSource represents a native (UDP-origin) audio source. It carries
// a single shared TrackLocalStaticSample that is attached as a sender to
// every connected WebRTC peer that the routing snapshot says should hear
// this source.
type nativeMediaSource struct {
	userID string
	track  *webrtc.TrackLocalStaticSample
	// senders is guarded by MediaManager.mu.
	senders map[string]*webrtc.RTPSender // destToken -> sender
	// nativeDests is the immutable list of native destination tokens that
	// currently hear this source. Read lock-free on every frame.
	nativeDests atomic.Pointer[[]string]
	// hasWebRTCDests reports whether any browser peer currently hears this
	// source, so the bridge can skip the Opus->RTP write otherwise.
	hasWebRTCDests atomic.Bool
	// lastRefreshNanos / refreshing implement the safety-net refresh.
	lastRefreshNanos atomic.Int64
	refreshing       atomic.Bool
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

func (m *MediaManager) nativeSource(sourceToken string) (*nativeMediaSource, bool) {
	m.nativeMu.RLock()
	defer m.nativeMu.RUnlock()
	src, ok := m.nativeSources[sourceToken]
	return src, ok
}

// nativeSourcesSnapshot returns the current native sources. Lock order is
// m.mu -> nativeMu, so this may be called while holding m.mu.
func (m *MediaManager) nativeSourcesSnapshot() map[string]*nativeMediaSource {
	m.nativeMu.RLock()
	defer m.nativeMu.RUnlock()
	out := make(map[string]*nativeMediaSource, len(m.nativeSources))
	for token, src := range m.nativeSources {
		out[token] = src
	}
	return out
}

// EnsureNativeSource is called when a native (UDP) source first delivers a
// frame for a given session token. It creates a shared StaticSample track
// and computes the initial routing.
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
		userID:  userID,
		track:   track,
		senders: make(map[string]*webrtc.RTPSender),
	}
	empty := []string{}
	src.nativeDests.Store(&empty)
	m.nativeSources[sourceToken] = src
	m.nativeMu.Unlock()

	m.mu.Lock()
	m.recomputeNativeSourceRoutingLocked(sourceToken, src, m.buildHubSnapshotLocked())
	m.mu.Unlock()
	return nil
}

// removeNativeSource removes any tracks and senders associated with a native
// source token (e.g. when its session disconnects). Caller must NOT hold m.mu.
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
	src.senders = map[string]*webrtc.RTPSender{}
	src.hasWebRTCDests.Store(false)
	empty := []string{}
	src.nativeDests.Store(&empty)
}

// recomputeAllNativeSourcesLocked refreshes routing for every native source.
// Caller must hold m.mu.
func (m *MediaManager) recomputeAllNativeSourcesLocked(snapshot mediaHubSnapshot) {
	for token, src := range m.nativeSourcesSnapshot() {
		m.recomputeNativeSourceRoutingLocked(token, src, snapshot)
	}
}

// recomputeNativeSourceRoutingLocked refreshes which destinations should hear
// this native source. It attaches/detaches the shared sample track on WebRTC
// peers (with renegotiation) and publishes the native destination list.
//
// Caller must hold m.mu.
func (m *MediaManager) recomputeNativeSourceRoutingLocked(sourceToken string, src *nativeMediaSource, snapshot mediaHubSnapshot) {
	src.lastRefreshNanos.Store(time.Now().UnixNano())
	open := m.computeOpenDestsLocked(sourceToken, snapshot)
	wantWebRTC := make(map[string]struct{})
	nativeDests := make([]string, 0, len(open))
	for destToken := range open {
		if snapshot.clients[destToken].native {
			nativeDests = append(nativeDests, destToken)
		} else if _, ok := m.peers[destToken]; ok {
			wantWebRTC[destToken] = struct{}{}
		}
	}

	// Add senders for newly-open WebRTC dests.
	for destToken := range wantWebRTC {
		if _, already := src.senders[destToken]; already {
			continue
		}
		peer := m.peers[destToken]
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

	src.hasWebRTCDests.Store(len(src.senders) > 0)
	src.nativeDests.Store(&nativeDests)
}

// computeOpenDestsLocked returns the set of destination tokens (browser and
// native) that should receive audio from the given source. Mirrors the
// gate logic in recomputeSourceRoutingWithSnapshotLocked.
//
// Caller must hold m.mu.
func (m *MediaManager) computeOpenDestsLocked(sourceToken string, snapshot mediaHubSnapshot) map[string]struct{} {
	open := make(map[string]struct{})
	directTargetUserID := m.directActive[sourceToken]
	broadcastRooms := m.broadcastRoomsForSourceFromSnapshotLocked(sourceToken, snapshot)
	talkRooms := m.talkRoomsForSourceFromSnapshotLocked(sourceToken, snapshot)
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

// NativeDestsForSource is the MediaBridge implementation used by
// UDPAudioRelay on every inbound native frame. It only loads the routing
// published by the last recompute.
func (m *MediaManager) NativeDestsForSource(sourceToken string) []string {
	src, ok := m.nativeSource(sourceToken)
	if !ok {
		// First frame for this token: register the source. This is the only
		// frame-path call that takes routing locks, once per session.
		if m.hub == nil {
			return nil
		}
		userID := m.hub.userIDForToken(sourceToken)
		if userID == "" {
			return nil
		}
		if err := m.EnsureNativeSource(sourceToken, userID); err != nil {
			m.logger.Warn("native bridge: ensure source failed", "error", err)
			return nil
		}
		if src, ok = m.nativeSource(sourceToken); !ok {
			return nil
		}
	}
	m.maybeRefreshNativeSource(sourceToken, src)
	return *src.nativeDests.Load()
}

// maybeRefreshNativeSource runs the safety-net recompute in the background
// so the UDP receive loop never waits for m.mu.
func (m *MediaManager) maybeRefreshNativeSource(sourceToken string, src *nativeMediaSource) {
	if time.Now().UnixNano()-src.lastRefreshNanos.Load() < int64(nativeRoutingRefreshInterval) {
		return
	}
	if !src.refreshing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer src.refreshing.Store(false)
		m.mu.Lock()
		defer m.mu.Unlock()
		if current, ok := m.nativeSource(sourceToken); !ok || current != src {
			return
		}
		m.recomputeNativeSourceRoutingLocked(sourceToken, src, m.buildHubSnapshotLocked())
	}()
}

// BridgeNativeOpusToWebRTC writes a single Opus frame originating from a
// native UDP source to all WebRTC peers that the routing snapshot says
// should hear this source.
func (m *MediaManager) BridgeNativeOpusToWebRTC(sourceToken string, opus []byte) {
	src, ok := m.nativeSource(sourceToken)
	if !ok || !src.hasWebRTCDests.Load() {
		return
	}
	duration := opusPacketDuration(opus)
	if duration <= 0 {
		return
	}
	if err := src.track.WriteSample(mediaSample{Data: opus, Duration: duration}); err != nil {
		m.logger.Debug("native bridge: WriteSample failed", "error", err)
	}
}

// forwardOpusToNativeDests is invoked from MediaManager's RTP forwarding
// loop after a WebRTC source produces a packet; it extracts the Opus payload
// and pushes it to the UDP relay for each native destination, keeping the
// RTP sequence number and timestamp so native receivers can run a proper
// per-source jitter buffer.
//
// Caller must NOT hold m.mu.
func (m *MediaManager) forwardOpusToNativeDests(sourceID uint32, dests []string, rtpBytes []byte) {
	m.nativeMu.RLock()
	relay := m.udpAudio
	m.nativeMu.RUnlock()
	if relay == nil {
		return
	}
	var pkt rtp.Packet
	if err := pkt.Unmarshal(rtpBytes); err != nil {
		return
	}
	for _, destToken := range dests {
		relay.SendOpus(destToken, sourceID, pkt.SequenceNumber, pkt.Timestamp, pkt.Payload)
	}
}

// opusPacketDuration returns the audio duration of an Opus packet from its
// TOC byte (RFC 6716 section 3.1). Native clients may send 2.5, 5 or 10 ms
// frames; Pion needs the real duration to advance RTP timestamps.
func opusPacketDuration(packet []byte) time.Duration {
	if len(packet) == 0 {
		return 0
	}
	toc := packet[0]
	config := toc >> 3
	var frame time.Duration
	switch {
	case config < 12: // SILK-only: 10, 20, 40, 60 ms
		frame = [...]time.Duration{10, 20, 40, 60}[config%4] * time.Millisecond
	case config < 16: // Hybrid: 10, 20 ms
		frame = [...]time.Duration{10, 20}[config%2] * time.Millisecond
	default: // CELT-only: 2.5, 5, 10, 20 ms
		frame = [...]time.Duration{2500, 5000, 10000, 20000}[config%4] * time.Microsecond
	}
	var frames int
	switch toc & 0x3 {
	case 0:
		frames = 1
	case 1, 2:
		frames = 2
	default:
		if len(packet) < 2 {
			return 0
		}
		frames = int(packet[1] & 0x3f)
	}
	return frame * time.Duration(frames)
}

// A small compile-time assertion that MediaManager implements MediaBridge.
var _ MediaBridge = (*MediaManager)(nil)
