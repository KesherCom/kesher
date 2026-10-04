package app

import (
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func receiveWithin(t *testing.T, d *delayLine, limit time.Duration) queuedPacket {
	t.Helper()
	select {
	case p := <-d.out:
		return p
	case <-time.After(limit):
		t.Fatalf("no packet released within %v", limit)
		return queuedPacket{}
	}
}

func TestDelayLineReorderedPacketDoesNotHoldBackStream(t *testing.T) {
	quit := make(chan struct{})
	defer close(quit)
	d := newDelayLine(quit)
	start := time.Now()
	d.push(queuedPacket{b: []byte{1}, release: start.Add(400 * time.Millisecond), reordered: true})
	d.push(queuedPacket{b: []byte{2}, release: start.Add(20 * time.Millisecond)})

	first := receiveWithin(t, d, time.Second)
	if first.b[0] != 2 {
		t.Fatalf("expected the in-order packet to overtake the reordered one, got %d first", first.b[0])
	}
	if waited := time.Since(start); waited > 200*time.Millisecond {
		t.Fatalf("in-order packet was held back for %v by the reordered one", waited)
	}
	if second := receiveWithin(t, d, time.Second); second.b[0] != 1 {
		t.Fatalf("expected reordered packet second, got %d", second.b[0])
	}
}

func TestDelayLineKeepsInOrderPacketsInOrder(t *testing.T) {
	quit := make(chan struct{})
	defer close(quit)
	d := newDelayLine(quit)
	start := time.Now()
	// Jitter gave the later packet a shorter delay; like a real queue it
	// must still leave after the earlier one.
	d.push(queuedPacket{b: []byte{1}, release: start.Add(60 * time.Millisecond)})
	d.push(queuedPacket{b: []byte{2}, release: start.Add(10 * time.Millisecond)})

	if p := receiveWithin(t, d, time.Second); p.b[0] != 1 {
		t.Fatalf("expected packet 1 first, got %d", p.b[0])
	}
	if p := receiveWithin(t, d, time.Second); p.b[0] != 2 {
		t.Fatalf("expected packet 2 second, got %d", p.b[0])
	}
	if elapsed := time.Since(start); elapsed < 55*time.Millisecond {
		t.Fatalf("packets released after %v, before the first packet's delay", elapsed)
	}
}

func TestEmuTCPConnDelaysWithoutThrottling(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	conn := newEmuTCPConn(server, &netemConfig{delay: 100 * time.Millisecond})
	defer conn.Close()

	const messages = 50
	go func() {
		for i := 0; i < messages; i++ {
			_, _ = client.Write([]byte{byte(i)})
		}
	}()
	start := time.Now()
	buf := make([]byte, 1)
	for i := 0; i < messages; i++ {
		if _, err := io.ReadFull(conn, buf); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if buf[0] != byte(i) {
			t.Fatalf("message %d arrived out of order (%d)", i, buf[0])
		}
	}
	elapsed := time.Since(start)
	if elapsed < 90*time.Millisecond {
		t.Fatalf("expected ~100 ms delay, got %v", elapsed)
	}
	// Sleeping per read would take messages × delay = 5 s.
	if elapsed > time.Second {
		t.Fatalf("delay throttled throughput: %d messages took %v", messages, elapsed)
	}
}

func TestEmuTCPConnHonorsReadDeadline(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	conn := newEmuTCPConn(server, &netemConfig{delay: 10 * time.Millisecond})
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	_, err := conn.Read(make([]byte, 1))
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("expected deadline error, got %v", err)
	}
}

// net/http aborts a pending background read (WebSocket upgrade) by setting a
// past deadline from another goroutine; the blocked Read must return.
func TestEmuTCPConnDeadlineWakesBlockedRead(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	conn := newEmuTCPConn(server, &netemConfig{delay: 10 * time.Millisecond})
	defer conn.Close()
	done := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	_ = conn.SetReadDeadline(time.Unix(1, 0))
	select {
	case err := <-done:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("expected deadline error, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked Read did not wake up on SetReadDeadline")
	}
}

// End to end through net/http + WebSocket upgrade on an emulated listener.
func TestNetemListenerServesWebSocketUpgrade(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := &netemConfig{delay: 30 * time.Millisecond, jitter: 10 * time.Millisecond}
	upgrader := websocket.Upgrader{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			mt, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			_ = c.WriteMessage(mt, msg)
		}
	})}
	go func() { _ = srv.Serve(&netemListener{Listener: ln, cfg: cfg}) }()
	defer srv.Close()

	ws, _, err := websocket.DefaultDialer.Dial("ws://"+ln.Addr().String()+"/", nil)
	if err != nil {
		t.Fatalf("dial through emulated listener: %v", err)
	}
	defer ws.Close()
	start := time.Now()
	for i := 0; i < 20; i++ {
		if err := ws.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
			t.Fatal(err)
		}
	}
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 20; i++ {
		if _, _, err := ws.ReadMessage(); err != nil {
			t.Fatalf("echo %d: %v", i, err)
		}
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("20 echoes took %v; emulation throttles the WebSocket", elapsed)
	}
}
