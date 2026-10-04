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
	"container/heap"
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
	return newEmuTCPConn(conn, l.cfg), nil
}

// emuTCPConn delays both directions of a TCP connection (±jitter) without
// limiting its throughput: a background reader timestamps incoming chunks
// and Read hands them out after their release time; Write queues and
// returns at once (like the kernel send buffer) and a background writer
// sends on schedule. Byte order is preserved, so jitter acts as queueing.
// (Sleeping inside every Read/Write instead would cap a WebSocket at a few
// messages per second on high-latency profiles and starve the control
// plane.) Loss is intentionally NOT applied to TCP: retransmission turns it
// into extra delay, and dropped bytes would corrupt streams.
type emuTCPConn struct {
	net.Conn
	cfg       *netemConfig
	in, out   *delayLine
	quit      chan struct{}
	closeOnce sync.Once
	pending   []byte // rest of a chunk not yet returned by Read
	readErr   error
	writeErr  atomic.Pointer[error]
	unsent    atomic.Int64 // queued writes not yet on the wire
	deadline  atomic.Pointer[time.Time]
	// Wakes a blocked Read when the deadline changes: net/http aborts its
	// background read on WebSocket upgrade by setting a past deadline.
	deadlineChanged chan struct{}
	// One long-lived timer per conn for read deadlines (Reset/Stop per Read)
	// rather than a fresh timer per call.
	readTimer *time.Timer
}

func newEmuTCPConn(conn net.Conn, cfg *netemConfig) *emuTCPConn {
	c := &emuTCPConn{Conn: conn, cfg: cfg, quit: make(chan struct{}), deadlineChanged: make(chan struct{}, 1), readTimer: time.NewTimer(time.Hour)}
	c.readTimer.Stop()
	c.in = newLosslessDelayLine(c.quit)
	c.out = newLosslessDelayLine(c.quit)
	go c.readLoop()
	go c.writeLoop()
	return c
}

func (c *emuTCPConn) readLoop() {
	for {
		buf := make([]byte, 32*1024)
		n, err := c.Conn.Read(buf)
		if n > 0 {
			c.in.push(queuedPacket{b: buf[:n], release: time.Now().Add(c.cfg.delayFor(false))})
		}
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				// Caller deadlines are enforced in Read, not on the socket.
				_ = c.Conn.SetReadDeadline(time.Time{})
				continue
			}
			// EOF / reset reaches the reader after the data still in flight.
			c.in.push(queuedPacket{err: err, release: time.Now().Add(c.cfg.delayFor(false))})
			return
		}
	}
}

func (c *emuTCPConn) writeLoop() {
	for {
		select {
		case <-c.quit:
			return
		case p := <-c.out.out:
			_, err := c.Conn.Write(p.b)
			c.unsent.Add(-1)
			if err != nil {
				c.writeErr.Store(&err)
				return
			}
		}
	}
}

func (c *emuTCPConn) Read(b []byte) (int, error) {
	for len(c.pending) == 0 {
		if c.readErr != nil {
			return 0, c.readErr
		}
		var timeout <-chan time.Time
		if dl := c.deadline.Load(); dl != nil && !dl.IsZero() {
			wait := time.Until(*dl)
			if wait <= 0 {
				return 0, os.ErrDeadlineExceeded
			}
			c.readTimer.Reset(wait)
			timeout = c.readTimer.C
		}
		select {
		case p := <-c.in.out:
			if p.err != nil {
				c.readErr = p.err
			} else {
				c.pending = p.b
			}
		case <-timeout:
			return 0, os.ErrDeadlineExceeded
		case <-c.deadlineChanged:
			// re-evaluate the new deadline
		case <-c.quit:
			c.readTimer.Stop()
			return 0, net.ErrClosed
		}
		c.readTimer.Stop()
	}
	n := copy(b, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *emuTCPConn) Write(b []byte) (int, error) {
	if err := c.writeErr.Load(); err != nil {
		return 0, *err
	}
	c.unsent.Add(1)
	p := queuedPacket{b: append([]byte(nil), b...), release: time.Now().Add(c.cfg.delayFor(false))}
	select {
	case c.out.in <- p:
		return len(b), nil
	case <-c.quit:
		c.unsent.Add(-1)
		return 0, net.ErrClosed
	}
}

func (c *emuTCPConn) SetDeadline(t time.Time) error {
	_ = c.SetReadDeadline(t)
	return c.Conn.SetWriteDeadline(t)
}

func (c *emuTCPConn) SetReadDeadline(t time.Time) error {
	c.deadline.Store(&t)
	select {
	case c.deadlineChanged <- struct{}{}:
	default:
	}
	return nil
}

// Close sends what is still queued (e.g. an HTTP response or a WebSocket
// close frame), bounded, then closes the socket.
func (c *emuTCPConn) Close() error {
	deadline := time.Now().Add(2 * time.Second)
	for c.unsent.Load() > 0 && c.writeErr.Load() == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	c.closeOnce.Do(func() { close(c.quit) })
	return c.Conn.Close()
}

// ── UDP wrapper (WebRTC / RTP) ────────────────────────────────────────────

// queuedPacket is a datagram plus the wall-clock time at which it becomes
// visible on the emulated path.
type queuedPacket struct {
	b       []byte
	addr    net.Addr
	release time.Time
	seq     uint64 // FIFO tie-break for equal release times
	// reordered packets leave the in-order stream: they neither wait for
	// earlier packets nor hold back later ones.
	reordered bool
	err       error // TCP only: read error delivered after the data before it
}

// delayLine schedules packets by release time. Normal packets stay in
// order (jitter behaves like queueing on a real link: a slow packet delays
// the ones behind it, nothing overtakes). Packets rolled as "reordered" get
// their extra delay on their own and are overtaken by later packets — they
// must not hold back the whole stream, which a plain FIFO would do,
// inflating latency far beyond the configured profile.
type delayLine struct {
	in          chan queuedPacket
	out         chan queuedPacket
	quit        <-chan struct{}
	seq         uint64
	lastInOrder time.Time
	// lossless lines (TCP) apply backpressure instead of dropping.
	lossless bool
	timer    *time.Timer
}

func newLosslessDelayLine(quit <-chan struct{}) *delayLine {
	d := &delayLine{
		in:       make(chan queuedPacket, emuQueueCap),
		out:      make(chan queuedPacket),
		quit:     quit,
		lossless: true,
	}
	go d.run()
	return d
}

func newDelayLine(quit <-chan struct{}) *delayLine {
	d := &delayLine{
		in:   make(chan queuedPacket, emuQueueCap),
		out:  make(chan queuedPacket, emuQueueCap),
		quit: quit,
	}
	go d.run()
	return d
}

// push schedules a packet; drops it when the line is full, like a
// bottleneck buffer overflowing.
func (d *delayLine) push(p queuedPacket) {
	if d.lossless {
		select {
		case d.in <- p:
		case <-d.quit:
		}
		return
	}
	select {
	case d.in <- p:
	default:
	}
}

func (d *delayLine) run() {
	var pending packetHeap
	d.timer = time.NewTimer(time.Hour)
	d.timer.Stop()
	timer := d.timer
	for {
		var due <-chan time.Time
		if len(pending) > 0 {
			timer.Reset(time.Until(pending[0].release))
			due = timer.C
		}
		select {
		case <-d.quit:
			timer.Stop()
			return
		case p := <-d.in:
			d.seq++
			p.seq = d.seq
			if !p.reordered {
				if p.release.Before(d.lastInOrder) {
					p.release = d.lastInOrder
				}
				d.lastInOrder = p.release
			}
			heap.Push(&pending, p)
		case <-due:
		}
		now := time.Now()
		for len(pending) > 0 && !pending[0].release.After(now) {
			p := heap.Pop(&pending).(queuedPacket)
			if d.lossless {
				select {
				case d.out <- p:
				case <-d.quit:
					timer.Stop()
					return
				}
				continue
			}
			select {
			case d.out <- p:
			default: // consumer stalled: drop
			}
		}
	}
}

// packetHeap is a min-heap on release time (container/heap).
type packetHeap []queuedPacket

func (h packetHeap) Len() int { return len(h) }
func (h packetHeap) Less(i, j int) bool {
	if h[i].release.Equal(h[j].release) {
		return h[i].seq < h[j].seq
	}
	return h[i].release.Before(h[j].release)
}
func (h packetHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *packetHeap) Push(x any)   { *h = append(*h, x.(queuedPacket)) }
func (h *packetHeap) Pop() any {
	old := *h
	p := old[len(old)-1]
	*h = old[:len(old)-1]
	return p
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
	readQ   *delayLine
	writeQ  *delayLine
	quit    chan struct{}
	closeQ  sync.Once
	initQ   sync.Once
	closed  atomic.Bool
	writeMu sync.Mutex
}

const emuQueueCap = 4096

func (c *emuPacketConn) startQueues() {
	c.initQ.Do(func() {
		c.quit = make(chan struct{})
		c.readQ = newDelayLine(c.quit)
		c.writeQ = newDelayLine(c.quit)
		go c.backgroundReader()
		go c.backgroundWriter()
	})
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
		reordered := c.cfg.roll(c.cfg.reorderPct)
		pkt := queuedPacket{b: append([]byte(nil), buf[:n]...), addr: addr, release: time.Now().Add(c.cfg.delayFor(reordered)), reordered: reordered}
		c.readQ.push(pkt)
		if c.cfg.roll(c.cfg.duplicatePct) {
			dup := queuedPacket{b: append([]byte(nil), buf[:n]...), addr: addr, release: time.Now().Add(c.cfg.delayFor(false))}
			c.readQ.push(dup)
		}
	}
}

func (c *emuPacketConn) backgroundWriter() {
	for {
		select {
		case <-c.quit:
			return
		case pkt := <-c.writeQ.out:
			_, _ = c.PacketConn.WriteTo(pkt.b, pkt.addr)
		}
	}
}

func (c *emuPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	c.startQueues()
	select {
	case <-c.quit:
		return 0, nil, net.ErrClosed
	case pkt := <-c.readQ.out:
		n := copy(p, pkt.b)
		return n, pkt.addr, nil
	}
}

func (c *emuPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	c.startQueues()
	if c.cfg.roll(c.cfg.lossPct) {
		return len(p), nil // downlink loss: packet never sent
	}
	reordered := c.cfg.roll(c.cfg.reorderPct)
	pkt := queuedPacket{b: append([]byte(nil), p...), addr: addr, release: time.Now().Add(c.cfg.delayFor(reordered)), reordered: reordered}
	c.writeQ.push(pkt)
	if c.cfg.roll(c.cfg.duplicatePct) {
		dup := queuedPacket{b: append([]byte(nil), p...), addr: addr, release: time.Now().Add(c.cfg.delayFor(false))}
		c.writeQ.push(dup)
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
