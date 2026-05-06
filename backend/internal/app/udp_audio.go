package app

// UDPAudioRelay implements the native low-latency audio transport for the
// performance mode. It runs alongside the WebRTC SFU (see media.go) and is
// used by native (Tauri) desktop clients that send/receive Opus frames via
// raw UDP at 5 ms framing for sub-20-ms latency.
//
// Wire format (all multi-byte fields big-endian):
//
//	bytes  0..4   magic         "KSHR"
//	byte   4      version       0x01
//	byte   5      flags         bit0=AUDIO, bit1=REGISTER, bit2=HEARTBEAT
//	bytes  6..8   sequence      uint16 (per-source monotonic, wraps)
//	bytes  8..12  timestamp     uint32 sample counter @ 48 kHz
//	bytes 12..16  token_hash    fnv32a("KSHR-AUD"+session_token)
//	(payload follows the 16-byte header)
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
	"sync"
	"sync/atomic"
	"time"
)

const (
	udpAudioMagic       = "KSHR"
	udpAudioVersion     = 0x01
	udpAudioHeaderLen   = 16
	udpAudioMaxPacket   = 1200
	udpAudioPeerExpiry  = 8 * time.Second
	udpAudioReapEvery   = 1 * time.Second
	udpAudioReadTimeout = 1 * time.Second
)

const (
	udpFlagAudio     byte = 1 << 0
	udpFlagRegister  byte = 1 << 1
	udpFlagHeartbeat byte = 1 << 2
)

// UDPAudioPacket is the parsed view of a single relay datagram.
type UDPAudioPacket struct {
	Flags     byte
	Sequence  uint16
	Timestamp uint32
	TokenHash uint32
	Payload   []byte
}

// EncodeUDPAudioPacket serialises a packet into dst. dst must be large enough
// (header + len(payload)). Returns the total encoded length.
func EncodeUDPAudioPacket(dst []byte, p UDPAudioPacket) (int, error) {
	if len(dst) < udpAudioHeaderLen+len(p.Payload) {
		return 0, errors.New("udp audio: dst too small")
	}
	copy(dst[0:4], udpAudioMagic)
	dst[4] = udpAudioVersion
	dst[5] = p.Flags
	binary.BigEndian.PutUint16(dst[6:8], p.Sequence)
	binary.BigEndian.PutUint32(dst[8:12], p.Timestamp)
	binary.BigEndian.PutUint32(dst[12:16], p.TokenHash)
	copy(dst[udpAudioHeaderLen:], p.Payload)
	return udpAudioHeaderLen + len(p.Payload), nil
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
	if buf[4] != udpAudioVersion {
		return p, errors.New("udp audio: unsupported version")
	}
	p.Flags = buf[5]
	p.Sequence = binary.BigEndian.Uint16(buf[6:8])
	p.Timestamp = binary.BigEndian.Uint32(buf[8:12])
	p.TokenHash = binary.BigEndian.Uint32(buf[12:16])
	p.Payload = buf[udpAudioHeaderLen:]
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

// udpPeer tracks a single native client (one per session token).
type udpPeer struct {
	token      string
	tokenHash  uint32
	userID     string
	mu         sync.Mutex
	addr       *net.UDPAddr
	lastSeen   time.Time
	rxFrames   atomic.Uint64
	txFrames   atomic.Uint64
	txSequence atomic.Uint32
}

// MediaBridge is the slim contract MediaManager (or any future SFU) implements
// so the relay can hand off native source frames to WebRTC destinations and
// query the routing snapshot.
type MediaBridge interface {
	// RoutingForSource returns the per-destination gate map for the given
	// source token. Implementations may return a nil map if the source is
	// unknown.
	RoutingForSource(sourceToken string) map[string]bool
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
	conn   *net.UDPConn

	mu         sync.RWMutex
	peers      map[string]*udpPeer // by session token
	peersByH   map[uint32]*udpPeer // by token hash (for fast inbound lookup)
	closeOnce  sync.Once
	closed     atomic.Bool
	cancelLoop context.CancelFunc
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

// Start binds to addr and launches the receive loop in a goroutine. addr
// must be in net.ListenPacket form (e.g. ":8081" or "0.0.0.0:8081").
func (r *UDPAudioRelay) Start(addr string) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return err
	}
	r.conn = conn

	ctx, cancel := context.WithCancel(context.Background())
	r.cancelLoop = cancel
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
		_ = r.conn.SetReadDeadline(time.Now().Add(udpAudioReadTimeout))
		n, addr, err := r.conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			if r.closed.Load() {
				return
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

func (r *UDPAudioRelay) handlePacket(addr *net.UDPAddr, pkt UDPAudioPacket) {
	switch {
	case pkt.Flags&udpFlagRegister != 0:
		token := string(pkt.Payload)
		if token == "" {
			return
		}
		r.registerPeer(token, addr)
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
		r.routeNativeAudio(peer, pkt)
	}
}

// registerPeer is invoked when a native client sends a REGISTER packet.
// We resolve the token through the hub to ensure it maps to a connected
// session, then bind it to the source address.
func (r *UDPAudioRelay) registerPeer(token string, addr *net.UDPAddr) {
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
		peer = &udpPeer{token: token, tokenHash: hash, userID: userID}
		r.peers[token] = peer
		r.peersByH[hash] = peer
	}
	r.mu.Unlock()
	peer.mu.Lock()
	peer.addr = addr
	peer.lastSeen = time.Now()
	peer.mu.Unlock()
	r.logger.Info("udp audio peer registered", "token_hash", hash, "user_id", userID, "remote", addr.String())
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
func (r *UDPAudioRelay) routeNativeAudio(src *udpPeer, pkt UDPAudioPacket) {
	if r.bridge == nil {
		return
	}
	gates := r.bridge.RoutingForSource(src.token)
	// Snapshot payload because pkt.Payload aliases the recv buffer.
	payloadCopy := make([]byte, len(pkt.Payload))
	copy(payloadCopy, pkt.Payload)

	// Native -> Native fan-out.
	r.mu.RLock()
	for destToken, open := range gates {
		if !open {
			continue
		}
		dest := r.peers[destToken]
		if dest == nil {
			continue
		}
		r.sendOpusLocked(dest, payloadCopy)
	}
	r.mu.RUnlock()

	// Native -> WebRTC bridge. The MediaManager handles per-destination
	// gating and RTP repacking on its side.
	r.bridge.BridgeNativeOpusToWebRTC(src.token, payloadCopy)
}

// SendOpusToToken delivers a single Opus frame to a specific native
// destination. Used by the WebRTC bridge to fan out browser-origin audio
// to native listeners.
func (r *UDPAudioRelay) SendOpusToToken(destToken string, opus []byte) {
	r.mu.RLock()
	peer := r.peers[destToken]
	r.mu.RUnlock()
	if peer == nil {
		return
	}
	r.sendOpusLocked(peer, opus)
}

func (r *UDPAudioRelay) sendOpusLocked(peer *udpPeer, opus []byte) {
	if r.conn == nil {
		return
	}
	peer.mu.Lock()
	addr := peer.addr
	peer.mu.Unlock()
	if addr == nil {
		return
	}
	seq := uint16(peer.txSequence.Add(1))
	buf := make([]byte, udpAudioHeaderLen+len(opus))
	if _, err := EncodeUDPAudioPacket(buf, UDPAudioPacket{
		Flags:     udpFlagAudio,
		Sequence:  seq,
		Timestamp: 0, // RTP-style timestamps are recreated on the receiver
		TokenHash: peer.tokenHash,
		Payload:   opus,
	}); err != nil {
		return
	}
	if _, err := r.conn.WriteToUDP(buf, addr); err != nil {
		r.logger.Debug("udp audio send failed", "token_hash", peer.tokenHash, "error", err)
		return
	}
	peer.txFrames.Add(1)
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
	Peers      int    `json:"peers"`
	RxFrames   uint64 `json:"rxFrames"`
	TxFrames   uint64 `json:"txFrames"`
}

// Stats returns aggregated counters for monitoring.
func (r *UDPAudioRelay) Stats() UDPAudioStats {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var rx, tx uint64
	for _, p := range r.peers {
		rx += p.rxFrames.Load()
		tx += p.txFrames.Load()
	}
	return UDPAudioStats{Peers: len(r.peers), RxFrames: rx, TxFrames: tx}
}
