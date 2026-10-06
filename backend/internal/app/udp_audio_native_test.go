package app

import (
	"io"
	"log/slog"
	"net"
	"testing"
	"time"
)

func TestUDPAudioPacketV2RoundTrip(t *testing.T) {
	want := UDPAudioPacket{
		Version:   udpAudioVersion2,
		Flags:     udpFlagAudio | udpFlagLoopback,
		Sequence:  0x1234,
		Timestamp: 0x89ABCDEF,
		TokenHash: 0xDEADBEEF,
		SourceID:  0xCAFEF00D,
		Payload:   []byte{0x88, 1, 2, 3},
	}
	buf := make([]byte, udpAudioHeaderLenV2+len(want.Payload))
	n, err := EncodeUDPAudioPacket(buf, want)
	if err != nil {
		t.Fatal(err)
	}
	if n != udpAudioHeaderLenV2+len(want.Payload) {
		t.Fatalf("encoded length %d, want %d", n, udpAudioHeaderLenV2+len(want.Payload))
	}
	got, err := DecodeUDPAudioPacket(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != want.Version || got.Flags != want.Flags || got.Sequence != want.Sequence ||
		got.Timestamp != want.Timestamp || got.TokenHash != want.TokenHash || got.SourceID != want.SourceID {
		t.Fatalf("header mismatch got=%+v want=%+v", got, want)
	}
	if string(got.Payload) != string(want.Payload) {
		t.Fatalf("payload mismatch")
	}
	if _, err := DecodeUDPAudioPacket(buf[:udpAudioHeaderLenV2-1]); err == nil {
		t.Fatal("expected truncated v2 header to fail")
	}
}

func TestNativeSourceIDDoesNotLeakTokenHash(t *testing.T) {
	if NativeSourceID("tok") == HashSessionToken("tok") {
		t.Fatal("source id must not equal the authenticating token hash")
	}
	if NativeSourceID("a") == NativeSourceID("b") {
		t.Fatal("source ids should differ per token")
	}
}

func TestOpusPacketDuration(t *testing.T) {
	cases := []struct {
		name   string
		packet []byte
		want   time.Duration
	}{
		{"celt 2.5ms", []byte{16 << 3}, 2500 * time.Microsecond},
		{"celt 5ms", []byte{17 << 3}, 5 * time.Millisecond},
		{"celt 10ms", []byte{18 << 3}, 10 * time.Millisecond},
		{"celt fullband 20ms", []byte{31 << 3}, 20 * time.Millisecond},
		{"silk 20ms", []byte{1 << 3}, 20 * time.Millisecond},
		{"hybrid 10ms", []byte{12 << 3}, 10 * time.Millisecond},
		{"two 5ms frames", []byte{17<<3 | 1}, 10 * time.Millisecond},
		{"code 3, four 2.5ms frames", []byte{16<<3 | 3, 4}, 10 * time.Millisecond},
		{"empty", nil, 0},
	}
	for _, c := range cases {
		if got := opusPacketDuration(c.packet); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestWebRTCSourcePublishesNativeDestinations(t *testing.T) {
	hub, media, cleanup := newNativeTestHub(t)
	defer cleanup()
	addTestClient(hub, "w", "uw", "webrtc", []string{"foh"})
	addTestClient(hub, "n", "un", "native", []string{"foh"})
	addTestClient(hub, "n-other-room", "uo", "native", []string{"stage"})

	media.mu.Lock()
	src := &mediaSourceTrack{userID: "uw", dests: map[string]*routedDest{}, sourceID: NativeSourceID("w")}
	empty := []string{}
	src.nativeDests.Store(&empty)
	media.sources["w"] = src
	media.recomputeSourceRoutingLocked("w")
	media.mu.Unlock()

	got := *src.nativeDests.Load()
	if len(got) != 1 || got[0] != "n" {
		t.Fatalf("expected browser source to reach native listener n only, got %v", got)
	}
}

func TestUDPRelayNativeToNativeCarriesSourceIdentity(t *testing.T) {
	hub, media, cleanup := newNativeTestHub(t)
	defer cleanup()
	relay := NewUDPAudioRelay(hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	media.SetUDPAudioRelay(relay)
	if err := relay.Start("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	relayAddr := relay.LocalAddr()

	addTestClient(hub, "a", "ua", "native", []string{"foh"})
	addTestClient(hub, "b", "ub", "native", []string{"foh"})
	addTestClient(hub, "c", "uc", "native", []string{"foh"})

	a := dialRelay(t, relayAddr)
	b := dialRelay(t, relayAddr)
	c := dialRelay(t, relayAddr)
	registerNative(t, relay, a, "a", udpAudioVersion2)
	registerNative(t, relay, b, "b", udpAudioVersion2)
	registerNative(t, relay, c, "c", udpAudioVersion) // legacy client

	frame := []byte{17 << 3, 0xAA, 0xBB} // 5 ms CELT TOC + payload
	sendNativeAudio(t, a, "a", 7, 1234, 0, frame)

	gotB := readRelayPacket(t, b)
	if gotB.Version != udpAudioVersion2 || gotB.SourceID != NativeSourceID("a") ||
		gotB.Sequence != 7 || gotB.Timestamp != 1234 || string(gotB.Payload) != string(frame) {
		t.Fatalf("v2 receiver got %+v", gotB)
	}
	gotC := readRelayPacket(t, c)
	if gotC.Version != udpAudioVersion || string(gotC.Payload) != string(frame) {
		t.Fatalf("v1 receiver got %+v", gotC)
	}

	// Routing changes are pushed explicitly; b stops listening.
	hub.SetRoomMatrix("b", nil, nil)
	media.SyncRouting()
	waitFor(t, func() bool {
		for _, d := range media.NativeDestsForSource("a") {
			if d == "b" {
				return false
			}
		}
		return true
	})
	sendNativeAudio(t, a, "a", 8, 1474, 0, frame)
	if pkt, ok := tryReadRelayPacket(b, 100*time.Millisecond); ok {
		t.Fatalf("b should no longer receive a, got %+v", pkt)
	}
	_ = readRelayPacket(t, c) // c still listens

	// Latency test: loopback flag echoes the frame to its sender only.
	sendNativeAudio(t, a, "a", 9, 1714, udpFlagLoopback, frame)
	echo := readRelayPacket(t, a)
	if echo.SourceID != NativeSourceID("a") || echo.Sequence != 9 {
		t.Fatalf("loopback echo got %+v", echo)
	}
	if pkt, ok := tryReadRelayPacket(c, 100*time.Millisecond); ok {
		t.Fatalf("loopback frame must not reach other listeners, c got %+v", pkt)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

func newNativeTestHub(t *testing.T) (*Hub, *MediaManager, func()) {
	t.Helper()
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	media := NewMediaManager(hub, logger)
	hub.SetMediaManager(media)
	return hub, media, func() { store.Close() }
}

func addTestClient(hub *Hub, token, userID, transport string, rooms []string) {
	hub.Add(&client{
		session:     Session{Token: token, RoleID: "audio"},
		user:        User{ID: userID, Username: token, RoleID: "audio"},
		send:        make(chan WSOutbound, 256),
		listenRooms: toRoomSet(rooms),
		talkRooms:   toRoomSet(rooms),
		transport:   transport,
	})
}

func dialRelay(t *testing.T, addr net.Addr) *net.UDPConn {
	t.Helper()
	conn, err := net.DialUDP("udp", nil, addr.(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func registerNative(t *testing.T, relay *UDPAudioRelay, conn *net.UDPConn, token string, version byte) {
	t.Helper()
	buf := make([]byte, udpAudioHeaderLenV2+len(token))
	n, _ := EncodeUDPAudioPacket(buf, UDPAudioPacket{
		Version:   version,
		Flags:     udpFlagRegister,
		TokenHash: HashSessionToken(token),
		Payload:   []byte(token),
	})
	if _, err := conn.Write(buf[:n]); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return relay.PeerByToken(token) != nil })
}

func sendNativeAudio(t *testing.T, conn *net.UDPConn, token string, seq uint16, ts uint32, extraFlags byte, payload []byte) {
	t.Helper()
	buf := make([]byte, udpAudioHeaderLenV2+len(payload))
	n, _ := EncodeUDPAudioPacket(buf, UDPAudioPacket{
		Version:   udpAudioVersion2,
		Flags:     udpFlagAudio | extraFlags,
		Sequence:  seq,
		Timestamp: ts,
		TokenHash: HashSessionToken(token),
		Payload:   payload,
	})
	if _, err := conn.Write(buf[:n]); err != nil {
		t.Fatal(err)
	}
}

func tryReadRelayPacket(conn *net.UDPConn, timeout time.Duration) (UDPAudioPacket, bool) {
	buf := make([]byte, 1500)
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	n, err := conn.Read(buf)
	if err != nil {
		return UDPAudioPacket{}, false
	}
	pkt, err := DecodeUDPAudioPacket(buf[:n])
	if err != nil {
		return UDPAudioPacket{}, false
	}
	pkt.Payload = append([]byte(nil), pkt.Payload...)
	return pkt, true
}

func readRelayPacket(t *testing.T, conn *net.UDPConn) UDPAudioPacket {
	t.Helper()
	pkt, ok := tryReadRelayPacket(conn, time.Second)
	if !ok {
		t.Fatal("timed out waiting for relay packet")
	}
	return pkt
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met within 1s")
}

func TestUDPRelayRecordsInboundGaps(t *testing.T) {
	r := NewUDPAudioRelay(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	peer := &udpPeer{tokenHash: 1}
	base := time.Now()
	r.noteInboundGap(peer, base)                            // first frame: no gap yet
	r.noteInboundGap(peer, base.Add(5*time.Millisecond))    // normal cadence
	r.noteInboundGap(peer, base.Add(55*time.Millisecond))   // 50 ms stall
	r.noteInboundGap(peer, base.Add(2055*time.Millisecond)) // talk pause, ignored
	stats := r.Stats()
	if stats.InboundGapsOver20ms != 1 {
		t.Fatalf("gaps over 20ms = %d, want 1", stats.InboundGapsOver20ms)
	}
	if stats.MaxInboundGapMs < 49 || stats.MaxInboundGapMs > 51 {
		t.Fatalf("max gap = %.1f ms, want ~50", stats.MaxInboundGapMs)
	}
}
