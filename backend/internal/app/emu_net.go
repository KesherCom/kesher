// emu_net.go — lab-only userspace network emulator (tc-netem equivalent).
//
// Docker Desktop's WSL2 kernel ships no traffic-control qdisc modules
// (CONFIG_NET_SCH_NETEM etc. are unset), so `tc netem` cannot run inside
// containers. Instead, when the NETLAB_* environment variables below are
// set, the server wraps its own sockets: every accepted HTTP/WS connection
// and the WebRTC UDP socket go through delay / loss / duplicate / reorder
// emulation in both directions (read side = uplink, write side = downlink).
// With no NETLAB_* variables set, none of this code activates.

package app

import (
	"math/rand"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// netemConfig holds the parsed emulation profile.
type netemConfig struct {
	delay        time.Duration
	jitter       time.Duration
	lossPct      float64 // 0..100, independent per direction
	duplicatePct float64
	reorderPct   float64
	udpPort      string
}

// netemFromEnv reads the NETLAB_* profile. Returns nil when nothing is
// configured, so production behavior is untouched.
func netemFromEnv() *netemConfig {
	delayMs, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("NETLAB_LATENCY_MS")))
	jitterMs, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("NETLAB_JITTER_MS")))
	lossPct, _ := strconv.ParseFloat(strings.TrimSpace(os.Getenv("NETLAB_LOSS_PCT")), 64)
	dupPct, _ := strconv.ParseFloat(strings.TrimSpace(os.Getenv("NETLAB_DUPLICATE_PCT")), 64)
	reorderPct, _ := strconv.ParseFloat(strings.TrimSpace(os.Getenv("NETLAB_REORDER_PCT")), 64)
	if delayMs <= 0 && jitterMs <= 0 && lossPct <= 0 && dupPct <= 0 && reorderPct <= 0 {
		return nil
	}
	udpPort := strings.TrimSpace(os.Getenv("NETLAB_UDP_PORT"))
	if udpPort == "" {
		udpPort = "8082"
	}
	return &netemConfig{
		delay:        time.Duration(delayMs) * time.Millisecond,
		jitter:       time.Duration(jitterMs) * time.Millisecond,
		lossPct:      lossPct,
		duplicatePct: dupPct,
		reorderPct:   reorderPct,
		udpPort:      udpPort,
	}
}

func (c *netemConfig) roll(pct float64) bool {
	return pct > 0 && rand.Float64()*100 < pct
}

// delayFor returns the per-packet hold time: base delay plus uniform jitter,
// extended for packets flagged as reordered (they arrive late, like netem).
func (c *netemConfig) delayFor(reordered bool) time.Duration {
	d := c.delay
	if c.jitter > 0 {
		d += time.Duration(rand.Float64() * float64(c.jitter))
	}
	if reordered && c.delay > 0 {
		d += 2 * c.delay
	}
	return d
}

// ── TCP wrapper (HTTP + WebSocket) ────────────────────────────────────────

// netemListener wraps a net.Listener so every accepted conn is shaped.
type netemListener struct {
	net.Listener
	cfg *netemConfig
}

func (l *netemListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return conn, err
	}
	return &emuTCPConn{Conn: conn, cfg: l.cfg}, nil
}

// emuTCPConn adds one-way delay (±jitter) on each read and write. Loss is
// intentionally NOT applied to TCP (retransmission makes it a latency change
// and byte drops would corrupt streams); RTP is where loss matters.
type emuTCPConn struct {
	net.Conn
	cfg *netemConfig
}

func (c *emuTCPConn) Read(b []byte) (int, error) {
	if d := c.cfg.delayFor(false); d > 0 {
		time.Sleep(d)
	}
	return c.Conn.Read(b)
}

func (c *emuTCPConn) Write(b []byte) (int, error) {
	if d := c.cfg.delayFor(false); d > 0 {
		time.Sleep(d)
	}
	return c.Conn.Write(b)
}

// ── UDP wrapper (WebRTC / RTP) ────────────────────────────────────────────

// queuedPacket is a datagram plus the wall-clock time at which it becomes
// visible on the emulated path.
type queuedPacket struct {
	b       []byte
	addr    net.Addr
	release time.Time
}

// emuPacketConn shapes a net.PacketConn without throttling the caller:
// a background reader drains the socket continuously (kernel buffer never
// overflows) and hands packets to ReadFrom after their release time;
// WriteTo enqueues and returns immediately, and a background writer emits
// packets on schedule. Drop / duplicate / reorder rolls are applied on
// both paths, so uplink (read side) and downlink (write side) are shaped
// independently. Wraps the socket handed to the pion ICE UDP mux, so all
// DTLS/STUN/RTCP/RTP traffic is emulated.
type emuPacketConn struct {
	net.PacketConn
	cfg     *netemConfig
	readQ   chan queuedPacket
	writeQ  chan queuedPacket
	quit    chan struct{}
	closeQ  sync.Once
	initQ   sync.Once
	closed  atomic.Bool
	writeMu sync.Mutex
}

const emuQueueCap = 4096

func (c *emuPacketConn) startQueues() {
	c.initQ.Do(func() {
		c.readQ = make(chan queuedPacket, emuQueueCap)
		c.writeQ = make(chan queuedPacket, emuQueueCap)
		c.quit = make(chan struct{})
		go c.backgroundReader()
		go c.backgroundWriter()
	})
}

// enqueue drops the packet when the queue is full, mirroring real buffer
// overflow behaviour on a bottleneck link.
func enqueue(q chan queuedPacket, p queuedPacket) {
	select {
	case q <- p:
	default:
	}
}

func (c *emuPacketConn) backgroundReader() {
	buf := make([]byte, 65535)
	for {
		n, addr, err := c.PacketConn.ReadFrom(buf)
		if err != nil {
			select {
			case <-c.quit:
				return
			default:
			}
			// Callers like the UDP audio relay re-arm a short read deadline
			// on every loop iteration. On the wrapped socket that would
			// poison this drain loop (immediate timeout, data never read),
			// so clear any deadline before retrying.
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				_ = c.PacketConn.SetReadDeadline(time.Time{})
			}
			continue
		}
		if c.cfg.roll(c.cfg.lossPct) {
			continue // uplink loss: packet consumed, never delivered
		}
		pkt := queuedPacket{b: append([]byte(nil), buf[:n]...), addr: addr, release: time.Now().Add(c.cfg.delayFor(false))}
		enqueue(c.readQ, pkt)
		if c.cfg.roll(c.cfg.duplicatePct) {
			dup := queuedPacket{b: append([]byte(nil), buf[:n]...), addr: addr, release: time.Now().Add(c.cfg.delayFor(false))}
			enqueue(c.readQ, dup)
		}
	}
}

func (c *emuPacketConn) backgroundWriter() {
	for {
		var pkt queuedPacket
		select {
		case <-c.quit:
			return
		case pkt = <-c.writeQ:
		}
		if d := time.Until(pkt.release); d > 0 {
			select {
			case <-time.After(d):
			case <-c.quit:
				return
			}
		}
		_, _ = c.PacketConn.WriteTo(pkt.b, pkt.addr)
	}
}

func (c *emuPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	c.startQueues()
	for {
		var pkt queuedPacket
		select {
		case <-c.quit:
			return 0, nil, net.ErrClosed
		case pkt = <-c.readQ:
		}
		if d := time.Until(pkt.release); d > 0 {
			select {
			case <-time.After(d):
			case <-c.quit:
				return 0, nil, net.ErrClosed
			}
		}
		n := copy(p, pkt.b)
		return n, pkt.addr, nil
	}
}

func (c *emuPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	c.startQueues()
	if c.cfg.roll(c.cfg.lossPct) {
		return len(p), nil // downlink loss: packet never sent
	}
	pkt := queuedPacket{b: append([]byte(nil), p...), addr: addr, release: time.Now().Add(c.cfg.delayFor(c.cfg.roll(c.cfg.reorderPct)))}
	enqueue(c.writeQ, pkt)
	if c.cfg.roll(c.cfg.duplicatePct) {
		dup := queuedPacket{b: append([]byte(nil), p...), addr: addr, release: time.Now().Add(c.cfg.delayFor(false))}
		enqueue(c.writeQ, dup)
	}
	return len(p), nil
}

// Close stops the queues and closes the underlying socket.
func (c *emuPacketConn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		c.closeQ.Do(func() {
			close(c.quit)
		})
	}
	return c.PacketConn.Close()
}

// labMultiSession allows several concurrent clients per role (used by the
// netlab audio probes, where probe a and b on one instance share the role).
func labMultiSession() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("LAB_MULTI_SESSION")), "true")
}
