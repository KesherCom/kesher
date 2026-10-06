package app

import (
	"net"
	"runtime"
	"sync"

	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// Batched fan-out. Every inbound frame becomes one packet per listener; in
// the 50-client load test, sending each with its own sendto() was 58 % of
// the server's CPU. On Linux all copies of a frame leave with a single
// sendmmsg() via WriteBatch; elsewhere (and behind the lab's network
// emulator) packets are written one by one.

// batchWriter is implemented by ipv4.PacketConn and ipv6.PacketConn; both
// use the same message type.
type batchWriter interface {
	WriteBatch(ms []ipv6.Message, flags int) (int, error)
}

// newBatchWriter returns a sendmmsg-capable view of conn on Linux, else nil.
func newBatchWriter(conn *net.UDPConn) batchWriter {
	if runtime.GOOS != "linux" || conn == nil {
		return nil
	}
	if a, ok := conn.LocalAddr().(*net.UDPAddr); ok && a.IP.To4() != nil && !a.IP.IsUnspecified() {
		return ipv4.NewPacketConn(conn)
	}
	// Dual-stack ("[::]") socket; Linux accepts IPv4 destinations on it.
	return ipv6.NewPacketConn(conn)
}

// fanOut collects the packets for one inbound frame. Pooled; not safe for
// concurrent use.
type fanOut struct {
	slab  []byte
	msgs  []ipv6.Message
	peers []*udpPeer
}

var fanOutPool = sync.Pool{New: func() any { return &fanOut{} }}

func (f *fanOut) reset(dests, payload int) {
	need := dests * (udpAudioHeaderLenV2 + payload)
	if cap(f.slab) < need {
		f.slab = make([]byte, 0, need)
	}
	f.slab = f.slab[:0]
	f.msgs = f.msgs[:0]
	f.peers = f.peers[:0]
}

// add encodes one packet for peer into the slab.
func (r *UDPAudioRelay) addToFanOut(f *fanOut, peer *udpPeer, sourceID uint32, sequence uint16, timestamp uint32, opus []byte) {
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
	start := len(f.slab)
	end := start + udpAudioHeaderLenFor(pkt.Version) + len(opus)
	if end > cap(f.slab) {
		// reset() sized the slab for all destinations; never grow it in
		// place, earlier messages point into it.
		return
	}
	f.slab = f.slab[:end]
	n, err := EncodeUDPAudioPacket(f.slab[start:end], pkt)
	if err != nil {
		f.slab = f.slab[:start]
		return
	}
	f.msgs = append(f.msgs, ipv6.Message{Buffers: [][]byte{f.slab[start : start+n]}, Addr: addr})
	f.peers = append(f.peers, peer)
}

// flush sends everything collected in f.
func (r *UDPAudioRelay) flush(f *fanOut) {
	sent := 0
	if r.batch != nil {
		for sent < len(f.msgs) {
			n, err := r.batch.WriteBatch(f.msgs[sent:], 0)
			if err != nil {
				if r.batchFailed.CompareAndSwap(false, true) {
					r.logger.Warn("udp audio: batched send failed, sending packets one by one", "error", err)
				}
				break
			}
			if n <= 0 {
				break
			}
			sent += n
		}
	}
	// Fallback / non-Linux: one write per packet.
	for i := sent; i < len(f.msgs); i++ {
		if _, err := r.conn.WriteTo(f.msgs[i].Buffers[0], f.msgs[i].Addr); err != nil {
			r.txErrors.Add(1)
			continue
		}
		sent++
	}
	for i := 0; i < len(f.peers) && i < sent; i++ {
		f.peers[i].txFrames.Add(1)
	}
	r.txTotal.Add(uint64(sent))
}

// SendOpusToMany fans one frame out to several native destinations with a
// single batched send (used for browser sources -> app listeners).
func (r *UDPAudioRelay) SendOpusToMany(destTokens []string, sourceID uint32, sequence uint16, timestamp uint32, opus []byte) {
	if r.conn == nil || len(destTokens) == 0 {
		return
	}
	f := fanOutPool.Get().(*fanOut)
	defer fanOutPool.Put(f)
	f.reset(len(destTokens), len(opus))
	r.mu.RLock()
	for _, t := range destTokens {
		if peer := r.peers[t]; peer != nil {
			r.addToFanOut(f, peer, sourceID, sequence, timestamp, opus)
		}
	}
	r.mu.RUnlock()
	r.flush(f)
}
