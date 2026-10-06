package app

// UDPAudioRelay implements the native low-latency audio transport for the
// performance mode. It runs alongside the WebRTC SFU (see media.go) and is
// used by native (Tauri) desktop clients that send/receive Opus frames via
// raw UDP at 5 ms framing for sub-20-ms latency.
//
// Wire format (all multi-byte fields big-endian):
//
//	bytes  0..4   magic         "KSHR"
//	byte   4      version       0x01 or 0x02
//	byte   5      flags         bit0=AUDIO, bit1=REGISTER, bit2=HEARTBEAT,
//	                            bit3=LOOPBACK (echo audio back to sender)
//	bytes  6..8   sequence      uint16 (per-source monotonic, wraps)
//	bytes  8..12  timestamp     uint32 sample counter @ 48 kHz
//	bytes 12..16  token_hash    fnv32a("KSHR-AUD"+session_token)
//	bytes 16..20  source_id     (v2 only) fnv32a("KSHR-SRC"+source_token)
//	(payload follows the 16-byte v1 / 20-byte v2 header)
//
// Version 2 exists because a receiver mixes several sources: it needs one
// Opus decoder and one jitter buffer per source, keyed by source_id, plus the
// source's own sequence/timestamp to detect loss and reordering. On
// server->client packets v2 carries the originating source's sequence and
// timestamp unchanged. Client->server packets set source_id to 0. The relay
// answers each peer in the version that peer used for REGISTER, so v1
// clients keep working (single-source only).
//
// REGISTER payload: raw session token bytes (used for the first-time bind
// between UDP source-address and a hub session). Subsequent AUDIO/HEARTBEAT
// packets carry only the 4-byte token hash; the relay maps hash -> peer.
//
// HEARTBEAT carries no payload and must be sent at least once per second by
// the native client to keep the relay's address binding fresh.
//
// AUDIO carries a single Opus frame (typically 30..100 bytes for 5 ms @
// 48 kbps CBR). We never send packets larger than 1200 bytes.
//
// Authentication is intentionally light: a session token (32+ characters from
// the auth manager) gives the holder send/receive rights for that token.
// The system is designed for trusted LAN deployments. For untrusted networks
// SRTP/DTLS or a PSK-AEAD wrapper would be required (out of scope here).

import (
	"context"
	"encoding/binary"
	"errors"
	"hash/fnv"
	"log/slog"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

const (
	udpAudioMagic       = "KSHR"
	udpAudioVersion     = 0x01
	udpAudioVersion2    = 0x02
	udpAudioHeaderLen   = 16
	udpAudioHeaderLenV2 = 20
	udpAudioMaxPacket   = 1200
	udpAudioPeerExpiry  = 8 * time.Second
	udpAudioReapEvery   = 1 * time.Second
	// Send buffer: fan-out leaves in bursts (one inbound frame -> one packet
	// per listener), so allow plenty of room.
	udpAudioSendBuffer = 4 << 20
	// Receive buffer: kept small on purpose. If the relay ever falls behind,
	// a large inbound queue turns overload into seconds of delay for
	// everyone (seen in the 50-client load test); dropping is better for
	// live audio. 256 KiB is ~1 s at 3000 frames/s.
	udpAudioRecvBuffer = 256 << 10
	// Per-worker queue of inbound frames waiting for fan-out (~40 ms at
	// 200 frames/s for 5 talkers per worker); full = drop + count.
	udpAudioWorkerQueue = 256
	udpAudioMaxWorkers  = 16
	// Frames that waited longer than this for their worker are dropped: a
	// listener's jitter buffer cannot use them anyway, and forwarding them
	// would only keep the relay behind (bounded delay under overload).
	udpAudioMaxQueueAge = 100 * time.Millisecond
)

const (
	udpFlagAudio     byte = 1 << 0
	udpFlagRegister  byte = 1 << 1
	udpFlagHeartbeat byte = 1 << 2
	udpFlagLoopback  byte = 1 << 3
)

// UDPAudioPacket is the parsed view of a single relay datagram.
type UDPAudioPacket struct {
	// Version is udpAudioVersion (also used when zero) or udpAudioVersion2.
	Version   byte
	Flags     byte
	Sequence  uint16
	Timestamp uint32
	TokenHash uint32
	// SourceID identifies the originating source on v2 server->client
	// packets (see NativeSourceID). Not encoded for v1.
	SourceID uint32
	Payload  []byte
}

func udpAudioHeaderLenFor(version byte) int {
	if version == udpAudioVersion2 {
		return udpAudioHeaderLenV2
	}
	return udpAudioHeaderLen
}

// EncodeUDPAudioPacket serialises a packet into dst. dst must be large enough
// (header + len(payload)). Returns the total encoded length.
func EncodeUDPAudioPacket(dst []byte, p UDPAudioPacket) (int, error) {
	version := p.Version
	if version != udpAudioVersion2 {
		version = udpAudioVersion
	}
	headerLen := udpAudioHeaderLenFor(version)
	if len(dst) < headerLen+len(p.Payload) {
		return 0, errors.New("udp audio: dst too small")
	}
	copy(dst[0:4], udpAudioMagic)
	dst[4] = version
	dst[5] = p.Flags
	binary.BigEndian.PutUint16(dst[6:8], p.Sequence)
	binary.BigEndian.PutUint32(dst[8:12], p.Timestamp)
	binary.BigEndian.PutUint32(dst[12:16], p.TokenHash)
	if version == udpAudioVersion2 {
		binary.BigEndian.PutUint32(dst[16:20], p.SourceID)
	}
	copy(dst[headerLen:], p.Payload)
	return headerLen + len(p.Payload), nil
}

// DecodeUDPAudioPacket parses a datagram. The returned Payload aliases the
// caller's buffer; callers that retain it after the buffer is reused must
// copy.
func DecodeUDPAudioPacket(buf []byte) (UDPAudioPacket, error) {
	var p UDPAudioPacket
	if len(buf) < udpAudioHeaderLen {
		return p, errors.New("udp audio: short packet")
	}
	if string(buf[0:4]) != udpAudioMagic {
		return p, errors.New("udp audio: bad magic")
	}
	p.Version = buf[4]
	if p.Version != udpAudioVersion && p.Version != udpAudioVersion2 {
		return p, errors.New("udp audio: unsupported version")
	}
	headerLen := udpAudioHeaderLenFor(p.Version)
	if len(buf) < headerLen {
		return p, errors.New("udp audio: short packet")
	}
	p.Flags = buf[5]
	p.Sequence = binary.BigEndian.Uint16(buf[6:8])
	p.Timestamp = binary.BigEndian.Uint32(buf[8:12])
	p.TokenHash = binary.BigEndian.Uint32(buf[12:16])
	if p.Version == udpAudioVersion2 {
		p.SourceID = binary.BigEndian.Uint32(buf[16:20])
	}
	p.Payload = buf[headerLen:]
	return p, nil
}

// HashSessionToken derives the short token identifier used in audio/heartbeat
// packets so the relay does not have to ship the full token on every frame.
func HashSessionToken(token string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte("KSHR-AUD"))
	_, _ = h.Write([]byte(token))
	return h.Sum32()
}

// NativeSourceID derives the public per-source identifier carried in v2
// server->client packets. It uses a different salt than HashSessionToken so
// receivers cannot learn another session's token hash (which authenticates
// inbound audio) from the source IDs they see.
func NativeSourceID(token string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte("KSHR-SRC"))
	_, _ = h.Write([]byte(token))
	return h.Sum32()
}

// udpPeer tracks a single native client (one per session token).
type udpPeer struct {
	token     string
	tokenHash uint32
	sourceID  uint32
	userID    string
	// version is the protocol version the peer registered with; the relay
	// answers in the same version.
	version    atomic.Uint32
	mu         sync.Mutex
	addr       net.Addr
	lastSeen   time.Time
	rxFrames   atomic.Uint64
	txFrames   atomic.Uint64
	txSequence atomic.Uint32
	// lastAudioNanos is when the previous audio frame from this peer
	// arrived; only the receive loop touches it.
	lastAudioNanos int64
}

// MediaBridge is the slim contract MediaManager (or any future SFU) implements
// so the relay can hand off native source frames to WebRTC destinations and
// query the routing snapshot.
type MediaBridge interface {
	// NativeDestsForSource returns the native destination tokens that should
	// hear the given native source. It runs once per inbound frame, so
	// implementations must not take routing locks or allocate; the returned
	// slice is shared and must not be modified.
	NativeDestsForSource(sourceToken string) []string
	// BridgeNativeOpusToWebRTC pushes a native-origin Opus frame into the
	// WebRTC fan-out for the given source token. The implementation is
	// responsible for repacking into RTP and respecting routing gates.
	BridgeNativeOpusToWebRTC(sourceToken string, opus []byte)
}

// UDPAudioRelay is the central UDP listener and per-peer registry.
type UDPAudioRelay struct {
	logger *slog.Logger
	hub    *Hub
	bridge MediaBridge
	conn   net.PacketConn
	netem  *netemConfig

	mu          sync.RWMutex
	peers       map[string]*udpPeer // by session token
	peersByH    map[uint32]*udpPeer // by token hash (for fast inbound lookup)
	inboundGaps atomic.Uint64
	txErrors    atomic.Uint64
	rxTotal     atomic.Uint64
	txTotal     atomic.Uint64
	queueDrops  atomic.Uint64
	// workers fan out inbound frames; a source always maps to the same
	// worker, so its frames stay in order.
	workers []chan relayJob
	// batch sends one frame's copies with one syscall (Linux); nil = one
	// write per packet.
	batch              batchWriter
	batchFailed        atomic.Bool
	maxInboundGapNanos atomic.Uint64
	maxRouteNanos      atomic.Uint64
	closeOnce          sync.Once
	closed             atomic.Bool
	cancelLoop         context.CancelFunc
}

// NewUDPAudioRelay creates the relay but does not start listening. Call
// Start to bind and begin the receive loop.
func NewUDPAudioRelay(hub *Hub, logger *slog.Logger) *UDPAudioRelay {
	return &UDPAudioRelay{
		logger:   logger,
		hub:      hub,
		peers:    make(map[string]*udpPeer),
		peersByH: make(map[uint32]*udpPeer),
	}
}

// SetMediaBridge wires the WebRTC bridge after construction (avoids a
// circular dependency with MediaManager).
func (r *UDPAudioRelay) SetMediaBridge(b MediaBridge) {
	r.mu.Lock()
	r.bridge = b
	r.mu.Unlock()
}

// SetNetem routes this relay's socket through the userspace netlab network
// emulator so native UDP audio is shaped exactly like the WebRTC path.
// Must be called before Start. A nil config leaves the socket unwrapped.
func (r *UDPAudioRelay) SetNetem(cfg *netemConfig) {
	r.netem = cfg
}

// Start binds to addr and launches the receive loop in a goroutine. addr
// must be in net.ListenPacket form (e.g. ":8081" or "0.0.0.0:8081").
func (r *UDPAudioRelay) Start(addr string) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	udpConn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return err
	}
	// The relay fans every frame out to all listeners; after a scheduling
	// hiccup the backlog arrives and leaves as a burst. Larger buffers keep
	// such bursts instead of dropping them (a safety margin; the defaults
	// were enough on an idle lab machine with 8 talkers). Linux caps this at
	// net.core.rmem_max / wmem_max.
	if err := udpConn.SetReadBuffer(udpAudioRecvBuffer); err != nil {
		r.logger.Warn("udp audio: could not set receive buffer", "error", err)
	}
	if err := udpConn.SetWriteBuffer(udpAudioSendBuffer); err != nil {
		r.logger.Warn("udp audio: could not enlarge send buffer", "error", err)
	}
	var conn net.PacketConn = udpConn
	if r.netem == nil {
		r.batch = newBatchWriter(udpConn)
	}
	if r.netem != nil {
		conn = &emuPacketConn{PacketConn: conn, cfg: r.netem}
	}
	r.conn = conn

	ctx, cancel := context.WithCancel(context.Background())
	r.cancelLoop = cancel
	n := runtime.GOMAXPROCS(0)
	if n > udpAudioMaxWorkers {
		n = udpAudioMaxWorkers
	}
	r.workers = make([]chan relayJob, n)
	for i := range r.workers {
		r.workers[i] = make(chan relayJob, udpAudioWorkerQueue)
		go r.fanOutWorker(ctx, r.workers[i])
	}
	go r.recvLoop(ctx)
	go r.reaper(ctx)
	r.logger.Info("udp audio relay listening", "addr", conn.LocalAddr().String())
	return nil
}

// Close stops the relay and tears down peers.
func (r *UDPAudioRelay) Close() {
	r.closeOnce.Do(func() {
		r.closed.Store(true)
		if r.cancelLoop != nil {
			r.cancelLoop()
		}
		if r.conn != nil {
			_ = r.conn.Close()
		}
	})
}

func (r *UDPAudioRelay) recvLoop(ctx context.Context) {
	buf := make([]byte, udpAudioMaxPacket)
	for {
		if ctx.Err() != nil {
			return
		}
		// No read deadline: Close() unblocks ReadFrom, and re-arming a
		// deadline would cost a syscall per packet on the hot path.
		n, addr, err := r.conn.ReadFrom(buf)
		if err != nil {
			if r.closed.Load() || ctx.Err() != nil {
				return
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			r.logger.Warn("udp audio recv error", "error", err)
			continue
		}
		pkt, err := DecodeUDPAudioPacket(buf[:n])
		if err != nil {
			r.logger.Debug("udp audio: dropping malformed packet", "error", err, "bytes", n)
			continue
		}
		r.handlePacket(addr, pkt)
	}
}

func (r *UDPAudioRelay) handlePacket(addr net.Addr, pkt UDPAudioPacket) {
	switch {
	case pkt.Flags&udpFlagRegister != 0:
		token := string(pkt.Payload)
		if token == "" {
			return
		}
		r.registerPeer(token, addr, pkt.Version)
	case pkt.Flags&udpFlagHeartbeat != 0:
		if peer := r.peerByHash(pkt.TokenHash); peer != nil {
			peer.mu.Lock()
			peer.addr = addr
			peer.lastSeen = time.Now()
			peer.mu.Unlock()
		}
	case pkt.Flags&udpFlagAudio != 0:
		peer := r.peerByHash(pkt.TokenHash)
		if peer == nil {
			return
		}
		peer.mu.Lock()
		peer.addr = addr
		peer.lastSeen = time.Now()
		peer.mu.Unlock()
		peer.rxFrames.Add(1)
		r.rxTotal.Add(1)
		now := time.Now()
		r.noteInboundGap(peer, now)
		r.dispatch(peer, pkt, now)
	}
}

// relayJob is one inbound audio frame waiting for fan-out. The payload is
// copied into a pooled buffer because the receive buffer is reused.
type relayJob struct {
	src      *udpPeer
	pkt      UDPAudioPacket
	buf      *[]byte
	received time.Time
}

var relayPayloadPool = sync.Pool{
	New: func() any {
		b := make([]byte, udpAudioMaxPacket)
		return &b
	},
}

// dispatch hands a frame to its source's worker. A full queue means the
// relay is overloaded; the frame is dropped (and counted) rather than
// delayed.
func (r *UDPAudioRelay) dispatch(src *udpPeer, pkt UDPAudioPacket, now time.Time) {
	if len(r.workers) == 0 { // not started (tests)
		r.routeNativeAudio(src, pkt)
		return
	}
	buf := relayPayloadPool.Get().(*[]byte)
	n := copy(*buf, pkt.Payload)
	pkt.Payload = (*buf)[:n]
	job := relayJob{src: src, pkt: pkt, buf: buf, received: now}
	select {
	case r.workers[src.tokenHash%uint32(len(r.workers))] <- job:
	default:
		r.queueDrops.Add(1)
		relayPayloadPool.Put(buf)
	}
}

func (r *UDPAudioRelay) fanOutWorker(ctx context.Context, jobs <-chan relayJob) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-jobs:
			if time.Since(job.received) > udpAudioMaxQueueAge {
				r.queueDrops.Add(1)
				relayPayloadPool.Put(job.buf)
				continue
			}
			r.routeNativeAudio(job.src, job.pkt)
			relayPayloadPool.Put(job.buf)
			// From receipt to the last copy sent: queueing + fan-out.
			took := time.Since(job.received)
			updateMax(&r.maxRouteNanos, uint64(took))
			if took > 10*time.Millisecond {
				r.logger.Warn("udp audio slow fan-out", "token_hash", job.src.tokenHash, "took_ms", float64(took)/1e6)
			}
		}
	}
}

// registerPeer is invoked when a native client sends a REGISTER packet.
// We resolve the token through the hub to ensure it maps to a connected
// session, then bind it to the source address.
func (r *UDPAudioRelay) registerPeer(token string, addr net.Addr, version byte) {
	if r.hub == nil {
		return
	}
	userID := r.hub.userIDForToken(token)
	if userID == "" {
		r.logger.Debug("udp audio register rejected: unknown token")
		return
	}
	hash := HashSessionToken(token)
	r.mu.Lock()
	peer, ok := r.peers[token]
	if !ok {
		peer = &udpPeer{token: token, tokenHash: hash, sourceID: NativeSourceID(token), userID: userID}
		r.peers[token] = peer
		r.peersByH[hash] = peer
	}
	r.mu.Unlock()
	peer.version.Store(uint32(version))
	peer.mu.Lock()
	peer.addr = addr
	peer.lastSeen = time.Now()
	peer.mu.Unlock()
	// Clients repeat REGISTER periodically so a lost packet or a relay
	// restart heals itself; only the first one is worth an info line.
	logFn := r.logger.Debug
	if !ok {
		logFn = r.logger.Info
	}
	logFn("udp audio peer registered", "token_hash", hash, "user_id", userID, "remote", addr.String(), "version", version)
}

func (r *UDPAudioRelay) peerByHash(h uint32) *udpPeer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.peersByH[h]
}

// PeerByToken returns the bound peer for a session token, or nil.
func (r *UDPAudioRelay) PeerByToken(token string) *udpPeer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.peers[token]
}

// IsNativeRegistered returns true if the given token currently has an
// authenticated UDP peer with a fresh heartbeat.
func (r *UDPAudioRelay) IsNativeRegistered(token string) bool {
	peer := r.PeerByToken(token)
	if peer == nil {
		return false
	}
	peer.mu.Lock()
	stale := time.Since(peer.lastSeen) > udpAudioPeerExpiry
	peer.mu.Unlock()
	return !stale
}

// RemovePeer removes a session's binding from the relay. Called from the hub
// when a session disconnects.
func (r *UDPAudioRelay) RemovePeer(token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.peers[token]; ok {
		delete(r.peers, token)
		delete(r.peersByH, p.tokenHash)
	}
}

func (r *UDPAudioRelay) reaper(ctx context.Context) {
	t := time.NewTicker(udpAudioReapEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now()
			r.mu.Lock()
			for tok, p := range r.peers {
				p.mu.Lock()
				stale := now.Sub(p.lastSeen) > udpAudioPeerExpiry
				p.mu.Unlock()
				if stale {
					delete(r.peers, tok)
					delete(r.peersByH, p.tokenHash)
					r.logger.Debug("udp audio peer expired", "token_hash", p.tokenHash)
				}
			}
			r.mu.Unlock()
		}
	}
}

// routeNativeAudio is the inbound path: a registered native source has just
// produced an Opus frame. We forward it to native destinations directly and
// hand it off to the WebRTC bridge for browser destinations.
//
// pkt.Payload aliases the receive buffer. Everything below consumes it
// synchronously (UDP writes copy into the kernel, Pion's Opus payloader
// copies into its RTP packets), so no per-frame copy is needed.
func (r *UDPAudioRelay) routeNativeAudio(src *udpPeer, pkt UDPAudioPacket) {
	if r.bridge == nil {
		return
	}
	// Latency test: echo the frame back to its sender only. The client sets
	// this flag while measuring mouth-to-ear latency; the test click must not
	// reach anyone else.
	if pkt.Flags&udpFlagLoopback != 0 {
		r.sendOpusToPeer(src, src.sourceID, pkt.Sequence, pkt.Timestamp, pkt.Payload)
		return
	}
	// Native -> Native fan-out, preserving the source's own sequence and
	// timestamp so receivers can run a per-source jitter buffer. All copies
	// leave in one batched send (udp_audio_batch.go).
	r.SendOpusToMany(r.bridge.NativeDestsForSource(src.token), src.sourceID, pkt.Sequence, pkt.Timestamp, pkt.Payload)

	// Native -> WebRTC bridge. The MediaManager handles per-destination
	// gating and RTP repacking on its side.
	r.bridge.BridgeNativeOpusToWebRTC(src.token, pkt.Payload)
}

// SendOpus delivers a single Opus frame from the given source to a native
// destination. sequence and timestamp are the source's own RTP-style
// counters; v1 destinations get a per-destination sequence instead because
// they cannot tell sources apart anyway.
func (r *UDPAudioRelay) SendOpus(destToken string, sourceID uint32, sequence uint16, timestamp uint32, opus []byte) {
	r.mu.RLock()
	peer := r.peers[destToken]
	r.mu.RUnlock()
	if peer == nil {
		return
	}
	r.sendOpusToPeer(peer, sourceID, sequence, timestamp, opus)
}

var udpAudioSendBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, udpAudioHeaderLenV2+udpAudioMaxPacket)
		return &b
	},
}

func (r *UDPAudioRelay) sendOpusToPeer(peer *udpPeer, sourceID uint32, sequence uint16, timestamp uint32, opus []byte) {
	if r.conn == nil {
		return
	}
	peer.mu.Lock()
	addr := peer.addr
	peer.mu.Unlock()
	if addr == nil {
		return
	}
	pkt := UDPAudioPacket{
		Version:   byte(peer.version.Load()),
		Flags:     udpFlagAudio,
		Sequence:  sequence,
		Timestamp: timestamp,
		TokenHash: peer.tokenHash,
		SourceID:  sourceID,
		Payload:   opus,
	}
	if pkt.Version != udpAudioVersion2 {
		pkt.Sequence = uint16(peer.txSequence.Add(1))
		pkt.Timestamp = 0
	}
	bufPtr := udpAudioSendBufPool.Get().(*[]byte)
	defer udpAudioSendBufPool.Put(bufPtr)
	n, err := EncodeUDPAudioPacket(*bufPtr, pkt)
	if err != nil {
		return
	}
	if _, err := r.conn.WriteTo((*bufPtr)[:n], addr); err != nil {
		r.txErrors.Add(1)
		r.logger.Debug("udp audio send failed", "token_hash", peer.tokenHash, "error", err)
		return
	}
	peer.txFrames.Add(1)
	r.txTotal.Add(1)
}

// LocalAddr exposes the bound listen address (mainly for tests and for the
// Endpoint info that the hub sends to native clients).
func (r *UDPAudioRelay) LocalAddr() net.Addr {
	if r.conn == nil {
		return nil
	}
	return r.conn.LocalAddr()
}

// PeerStats is a snapshot used in /api/realtime-stats.
type UDPAudioStats struct {
	Peers    int    `json:"peers"`
	RxFrames uint64 `json:"rxFrames"`
	TxFrames uint64 `json:"txFrames"`
	// Diagnostics for latency spikes: inbound gaps during continuous audio
	// and the slowest single frame fan-out.
	InboundGapsOver20ms uint64  `json:"inboundGapsOver20ms"`
	MaxInboundGapMs     float64 `json:"maxInboundGapMs"`
	MaxRouteMs          float64 `json:"maxRouteMs"`
	TxErrors            uint64  `json:"txErrors"`
	// QueueDrops counts inbound frames dropped because their fan-out worker
	// was backed up (relay overloaded).
	QueueDrops uint64 `json:"queueDrops"`
	Workers    int    `json:"workers"`
}

// relayGapLogThreshold: inbound gaps longer than this are logged. Native
// clients send a frame every 2.5-10 ms while talking and nothing while
// silent, so gaps up to one second are stalls rather than talk pauses.
const (
	relayGapLogThreshold = 40 * time.Millisecond
	relayGapPauseCutoff  = time.Second
)

func (r *UDPAudioRelay) noteInboundGap(peer *udpPeer, now time.Time) {
	nowNanos := now.UnixNano()
	prev := peer.lastAudioNanos
	peer.lastAudioNanos = nowNanos
	if prev == 0 {
		return
	}
	gap := time.Duration(nowNanos - prev)
	if gap >= relayGapPauseCutoff {
		return // talk pause
	}
	updateMax(&r.maxInboundGapNanos, uint64(gap))
	if gap > 20*time.Millisecond {
		r.inboundGaps.Add(1)
	}
	if gap > relayGapLogThreshold {
		r.logger.Warn("udp audio inbound gap", "token_hash", peer.tokenHash, "gap_ms", float64(gap)/1e6)
	}
}

// Stats returns aggregated counters for monitoring.
func (r *UDPAudioRelay) Stats() UDPAudioStats {
	r.mu.RLock()
	peers := len(r.peers)
	r.mu.RUnlock()
	// Totals are kept relay-wide (not summed over current peers) so they
	// never go backwards when a peer leaves.
	return UDPAudioStats{
		Peers:               peers,
		RxFrames:            r.rxTotal.Load(),
		TxFrames:            r.txTotal.Load(),
		QueueDrops:          r.queueDrops.Load(),
		Workers:             len(r.workers),
		InboundGapsOver20ms: r.inboundGaps.Load(),
		MaxInboundGapMs:     float64(r.maxInboundGapNanos.Load()) / 1e6,
		MaxRouteMs:          float64(r.maxRouteNanos.Load()) / 1e6,
		TxErrors:            r.txErrors.Load(),
	}
}
