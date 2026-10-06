// Command loadsim simulates a full intercom crowd against one kesher server
// and measures what every participant receives.
//
// Desktop-app clients are simulated on the native UDP path (KSHR v2), browser
// clients on the real WebRTC path (Pion). Audio is not encoded: each packet
// carries a valid Opus TOC byte followed by its send time and sender index,
// which the server forwards untouched. Every receiver therefore measures
// one-way latency through the server (same process, same clock), loss
// against what its rooms should deliver, and deliveries it should not get.
//
// Phases:
//
//	realistic  4 party lines, everyone listens to its home line and FOH, a
//	           few always-on talkers plus random PTT calls (~3 at once);
//	           a probe measures how long a room switch takes to bring audio.
//	stress     everyone on FOH, N talkers at once.
//	extreme    (-extreme) everyone talks at once.
//
// The server must allow several sessions per role (lab servers set
// LAB_MULTI_SESSION=true). Admin stats need the admin PIN (-pin).
//
//	go run ./cmd/loadsim -url http://127.0.0.1:8180 -native 35 -browser 15
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	framePeriod  = 5 * time.Millisecond
	rtpTSStep    = 240 // 5 ms at 48 kHz
	payloadBytes = 40  // about a 5 ms Opus frame at 48 kbit/s
	opusTOC5ms   = 17 << 3
	probeRoom    = "livestream"
	foh          = "foh"
	histBucketUS = 100 // latency histogram resolution
	histMaxMS    = 2000
)

var partyLines = []string{"foh", "stage", "video-control", "lighting-booth"}

type kind int

const (
	kindNative kind = iota
	kindBrowser
)

func (k kind) String() string {
	if k == kindNative {
		return "app"
	}
	return "browser"
}

// ── latency histogram ───────────────────────────────────────────────────

type histogram struct {
	buckets []atomic.Uint64
	count   atomic.Uint64
}

func newHistogram() *histogram {
	return &histogram{buckets: make([]atomic.Uint64, histMaxMS*1000/histBucketUS+1)}
}

func (h *histogram) add(d time.Duration) {
	i := int(d.Microseconds() / histBucketUS)
	if i < 0 {
		i = 0
	}
	if i >= len(h.buckets) {
		i = len(h.buckets) - 1
	}
	h.buckets[i].Add(1)
	h.count.Add(1)
}

func (h *histogram) quantile(q float64) float64 {
	n := h.count.Load()
	if n == 0 {
		return math.NaN()
	}
	target := uint64(math.Ceil(q * float64(n)))
	var seen uint64
	for i := range h.buckets {
		seen += h.buckets[i].Load()
		if seen >= target {
			return float64(i*histBucketUS) / 1000
		}
	}
	return histMaxMS
}

func (h *histogram) max() float64 {
	for i := len(h.buckets) - 1; i >= 0; i-- {
		if h.buckets[i].Load() > 0 {
			return float64(i*histBucketUS) / 1000
		}
	}
	return math.NaN()
}

// ── per-phase accounting ────────────────────────────────────────────────

type pathKey struct{ from, to kind }

type phaseStats struct {
	name      string
	n         int
	start     atomic.Int64 // unix nanos; window for counting
	end       atomic.Int64
	sent      []atomic.Uint64   // per sender, sent inside window
	recv      [][]atomic.Uint64 // [src][dst], received with send time inside window
	unexpect  atomic.Uint64
	hists     map[pathKey]*histogram
	hear      [][]bool // [src][dst] should hear
	exclude   []bool   // senders excluded from loss accounting (probe)
	routeHist *histogram
}

func newPhaseStats(name string, n int) *phaseStats {
	p := &phaseStats{
		name:      name,
		n:         n,
		sent:      make([]atomic.Uint64, n),
		recv:      make([][]atomic.Uint64, n),
		hists:     map[pathKey]*histogram{},
		hear:      make([][]bool, n),
		exclude:   make([]bool, n),
		routeHist: newHistogram(),
	}
	for i := range p.recv {
		p.recv[i] = make([]atomic.Uint64, n)
		p.hear[i] = make([]bool, n)
	}
	for _, a := range []kind{kindNative, kindBrowser} {
		for _, b := range []kind{kindNative, kindBrowser} {
			p.hists[pathKey{a, b}] = newHistogram()
		}
	}
	return p
}

func (p *phaseStats) inWindow(t int64) bool {
	s, e := p.start.Load(), p.end.Load()
	return s != 0 && t >= s && (e == 0 || t < e)
}

// ── clients ─────────────────────────────────────────────────────────────

type sim struct {
	base    string
	pin     string
	clients []*client
	phase   atomic.Pointer[phaseStats]
	httpc   *http.Client
	logf    func(string, ...any)
}

type client struct {
	sim     *sim
	idx     int
	kind    kind
	name    string
	token   string
	userID  string
	ws      *websocket.Conn
	wsMu    sync.Mutex
	listen  []string
	talk    []string
	talking atomic.Bool
	// native
	udp       *net.UDPConn
	tokenHash uint32
	udpSeq    uint16
	udpTS     uint32
	// browser
	pc     *webrtc.PeerConnection
	track  *webrtc.TrackLocalStaticRTP
	rtpSeq uint16
	rtpTS  uint32
	pcMu   sync.Mutex
	remote bool
	ice    []webrtc.ICECandidateInit
	// room-switch probe
	joinAt atomic.Int64
}

type wsEnvelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func (c *client) send(typ string, data any) error {
	b, err := json.Marshal(map[string]any{"type": typ, "data": data})
	if err != nil {
		return err
	}
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteMessage(websocket.TextMessage, b)
}

func (c *client) setMatrix(listen, talk []string) error {
	c.listen, c.talk = listen, talk
	return c.send("set_room_matrix", map[string]any{"listenRoomIds": listen, "talkRoomIds": talk})
}

func (c *client) setTalking(on bool) {
	if c.talking.Swap(on) == on {
		return
	}
	body := "ptt_stop"
	if on {
		body = "ptt_start"
	}
	room := foh
	if len(c.talk) > 0 {
		room = c.talk[0]
	}
	_ = c.send("voice_state", map[string]any{"scope": "room", "targetId": room, "body": body})
}

// payload: TOC | send unix nanos (8) | sender index (2) | padding
func makePayload(idx int, now time.Time) []byte {
	p := make([]byte, payloadBytes)
	p[0] = opusTOC5ms
	binary.BigEndian.PutUint64(p[1:9], uint64(now.UnixNano()))
	binary.BigEndian.PutUint16(p[9:11], uint16(idx))
	return p
}

func (s *sim) onReceive(dst *client, payload []byte) {
	if len(payload) < 11 || payload[0] != opusTOC5ms {
		return
	}
	sentAt := int64(binary.BigEndian.Uint64(payload[1:9]))
	src := int(binary.BigEndian.Uint16(payload[9:11]))
	if src < 0 || src >= len(s.clients) || src == dst.idx {
		return
	}
	now := time.Now()
	if join := dst.joinAt.Load(); join != 0 && src == len(s.clients)-1 {
		// First audio from the probe after this client joined its room.
		if dst.joinAt.CompareAndSwap(join, 0) {
			if p := s.phase.Load(); p != nil {
				p.routeHist.add(now.Sub(time.Unix(0, join)))
			}
		}
	}
	p := s.phase.Load()
	if p == nil || !p.inWindow(sentAt) || p.exclude[src] {
		return
	}
	if !p.hear[src][dst.idx] {
		p.unexpect.Add(1)
		return
	}
	p.recv[src][dst.idx].Add(1)
	p.hists[pathKey{s.clients[src].kind, dst.kind}].add(now.Sub(time.Unix(0, sentAt)))
}

func (s *sim) login(name string) (token, userID string, err error) {
	body, _ := json.Marshal(map[string]string{"username": name, "roleId": "audio"})
	for attempt := 0; attempt < 5; attempt++ {
		resp, e := s.httpc.Post(s.base+"/api/login", "application/json", bytes.NewReader(body))
		if e != nil {
			err = e
			time.Sleep(200 * time.Millisecond)
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			err = fmt.Errorf("login %s: %d %s", name, resp.StatusCode, strings.TrimSpace(string(b)))
			time.Sleep(200 * time.Millisecond)
			continue
		}
		var out struct {
			Token string `json:"token"`
			User  struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		if e := json.Unmarshal(b, &out); e != nil {
			return "", "", e
		}
		return out.Token, out.User.ID, nil
	}
	return "", "", err
}

func (s *sim) connect(c *client) error {
	token, userID, err := s.login(c.name)
	if err != nil {
		return err
	}
	c.token, c.userID = token, userID
	u, _ := url.Parse(s.base)
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	u.Path = "/ws"
	q := url.Values{"token": {token}}
	if c.kind == kindNative {
		q.Set("transport", "native")
	}
	u.RawQuery = q.Encode()
	ws, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return fmt.Errorf("%s ws: %w", c.name, err)
	}
	c.ws = ws
	endpoint := make(chan json.RawMessage, 1)
	go c.readLoop(endpoint)
	if c.kind == kindBrowser {
		if err := c.startWebRTC(); err != nil {
			return err
		}
		return c.send("webrtc_ready", map[string]any{})
	}
	select {
	case raw := <-endpoint:
		return c.startNative(raw)
	case <-time.After(10 * time.Second):
		return fmt.Errorf("%s: no native_audio_endpoint (UDP relay off?)", c.name)
	}
}

func (c *client) readLoop(endpoint chan<- json.RawMessage) {
	for {
		_ = c.ws.SetReadDeadline(time.Now().Add(120 * time.Second))
		_, msg, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		var env wsEnvelope
		if json.Unmarshal(msg, &env) != nil {
			continue
		}
		switch env.Type {
		case "native_audio_endpoint":
			select {
			case endpoint <- env.Data:
			default:
			}
		case "webrtc_offer":
			var o struct {
				SDP string `json:"sdp"`
			}
			if json.Unmarshal(env.Data, &o) == nil {
				if err := c.handleOffer(o.SDP); err != nil {
					c.sim.logf("%s: offer: %v", c.name, err)
				}
			}
		case "webrtc_ice_candidate":
			var cand struct {
				Candidate     string `json:"candidate"`
				SDPMid        string `json:"sdpMid"`
				SDPMLineIndex uint16 `json:"sdpMLineIndex"`
			}
			if json.Unmarshal(env.Data, &cand) == nil {
				init := webrtc.ICECandidateInit{Candidate: cand.Candidate, SDPMLineIndex: &cand.SDPMLineIndex}
				if cand.SDPMid != "" {
					init.SDPMid = &cand.SDPMid
				}
				c.pcMu.Lock()
				if c.remote {
					_ = c.pc.AddICECandidate(init)
				} else {
					c.ice = append(c.ice, init)
				}
				c.pcMu.Unlock()
			}
		}
	}
}

// ── native (desktop app) path ───────────────────────────────────────────

func kshrHeader(dst []byte, flags byte, seq uint16, ts, tokenHash uint32) {
	copy(dst[0:4], "KSHR")
	dst[4] = 2
	dst[5] = flags
	binary.BigEndian.PutUint16(dst[6:8], seq)
	binary.BigEndian.PutUint32(dst[8:12], ts)
	binary.BigEndian.PutUint32(dst[12:16], tokenHash)
	binary.BigEndian.PutUint32(dst[16:20], 0)
}

func (c *client) startNative(raw json.RawMessage) error {
	var ep struct {
		Host      string `json:"host"`
		Port      int    `json:"port"`
		TokenHash uint32 `json:"tokenHash"`
	}
	if err := json.Unmarshal(raw, &ep); err != nil {
		return err
	}
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(ep.Host, fmt.Sprint(ep.Port)))
	if err != nil {
		return err
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return err
	}
	_ = conn.SetReadBuffer(1 << 20)
	c.udp, c.tokenHash = conn, ep.TokenHash
	reg := make([]byte, 20+len(c.token))
	kshrHeader(reg, 1<<1, 0, 0, c.tokenHash)
	copy(reg[20:], c.token)
	if _, err := conn.Write(reg); err != nil {
		return err
	}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for range t.C {
			if _, err := conn.Write(reg); err != nil {
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, 1500)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			if n > 20 && string(buf[0:4]) == "KSHR" && buf[4] == 2 && buf[5]&1 != 0 {
				c.sim.onReceive(c, buf[20:n])
			}
		}
	}()
	return nil
}

func (c *client) sendNative(now time.Time) {
	pkt := make([]byte, 20+payloadBytes)
	c.udpSeq++
	c.udpTS += rtpTSStep
	kshrHeader(pkt, 1, c.udpSeq, c.udpTS, c.tokenHash)
	copy(pkt[20:], makePayload(c.idx, now))
	_, _ = c.udp.Write(pkt)
}

// ── browser (WebRTC) path ───────────────────────────────────────────────

func (c *client) startWebRTC() error {
	se := webrtc.SettingEngine{}
	se.SetICEMulticastDNSMode(0)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithInterceptorRegistry(&interceptor.Registry{}))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio-"+c.name, "loadsim")
	if err != nil {
		return err
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		return err
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		init := cand.ToJSON()
		msg := map[string]any{"candidate": init.Candidate}
		if init.SDPMid != nil {
			msg["sdpMid"] = *init.SDPMid
		}
		if init.SDPMLineIndex != nil {
			msg["sdpMLineIndex"] = *init.SDPMLineIndex
		}
		_ = c.send("webrtc_ice_candidate", msg)
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				pkt, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				c.sim.onReceive(c, pkt.Payload)
			}
		}()
	})
	c.pc, c.track = pc, track
	return nil
}

func (c *client) handleOffer(sdp string) error {
	c.pcMu.Lock()
	defer c.pcMu.Unlock()
	if err := c.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	c.remote = true
	for _, cand := range c.ice {
		_ = c.pc.AddICECandidate(cand)
	}
	c.ice = nil
	answer, err := c.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := c.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	return c.send("webrtc_answer", map[string]any{"sdp": answer.SDP})
}

func (c *client) sendBrowser(now time.Time) {
	c.rtpSeq++
	c.rtpTS += rtpTSStep
	_ = c.track.WriteRTP(&rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: c.rtpSeq, Timestamp: c.rtpTS, SSRC: uint32(c.idx + 1)},
		Payload: makePayload(c.idx, now),
	})
}

// ── sending ─────────────────────────────────────────────────────────────

func (s *sim) sendLoop(ctx context.Context) {
	t := time.NewTicker(framePeriod)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := time.Now()
		p := s.phase.Load()
		for _, c := range s.clients {
			if !c.talking.Load() {
				continue
			}
			if c.kind == kindNative {
				c.sendNative(now)
			} else {
				c.sendBrowser(now)
			}
			if p != nil && p.inWindow(now.UnixNano()) {
				p.sent[c.idx].Add(1)
			}
		}
	}
}

// ── server stats ────────────────────────────────────────────────────────

type serverStats struct {
	UDPAudio *struct {
		RxFrames            uint64  `json:"rxFrames"`
		TxFrames            uint64  `json:"txFrames"`
		TxErrors            uint64  `json:"txErrors"`
		InboundGapsOver20ms uint64  `json:"inboundGapsOver20ms"`
		MaxInboundGapMs     float64 `json:"maxInboundGapMs"`
		MaxRouteMs          float64 `json:"maxRouteMs"`
		QueueDrops          uint64  `json:"queueDrops"`
		Workers             int     `json:"workers"`
	} `json:"udpAudio"`
	Media struct {
		SyncRunMaxMs       float64 `json:"syncRunMaxMs"`
		Renegotiations     uint64  `json:"renegotiations"`
		RenegotiationMaxMs float64 `json:"renegotiationMaxMs"`
	} `json:"media"`
	Process struct {
		CPUSeconds float64 `json:"cpuSeconds"`
		NumCPU     int     `json:"numCpu"`
		Goroutines int     `json:"goroutines"`
		HeapMB     float64 `json:"heapMb"`
	} `json:"process"`
	TimestampUnixMs int64 `json:"timestampUnixMs"`
}

func (s *sim) serverStats() *serverStats {
	req, _ := http.NewRequest(http.MethodGet, s.base+"/api/realtime-stats", nil)
	req.Header.Set("Authorization", "Bearer "+s.clients[0].token)
	req.Header.Set("X-Admin-Pin", s.pin)
	resp, err := s.httpc.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var st serverStats
	if json.NewDecoder(resp.Body).Decode(&st) != nil {
		return nil
	}
	return &st
}

// ── phases ──────────────────────────────────────────────────────────────

type phaseResult struct {
	Name             string             `json:"name"`
	Seconds          float64            `json:"seconds"`
	AvgTalkers       float64            `json:"avgTalkers"`
	ExpectedPackets  uint64             `json:"expectedPackets"`
	ReceivedPackets  uint64             `json:"receivedPackets"`
	LossPct          float64            `json:"lossPct"`
	WorstPairLossPct float64            `json:"worstPairLossPct"`
	Unexpected       uint64             `json:"unexpectedDeliveries"`
	Paths            map[string]pathOut `json:"paths"`
	RoomSwitchMs     *pathOut           `json:"roomSwitchMs,omitempty"`
	Server           map[string]any     `json:"server,omitempty"`
}

type pathOut struct {
	Count uint64  `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

func histOut(h *histogram) pathOut {
	r := func(v float64) float64 { return math.Round(v*10) / 10 }
	return pathOut{Count: h.count.Load(), P50: r(h.quantile(0.5)), P95: r(h.quantile(0.95)), P99: r(h.quantile(0.99)), Max: r(h.max())}
}

// runPhase applies room matrices, lets routing settle, then measures for d
// while `drive` changes who talks. Returns the accounting.
func (s *sim) runPhase(name string, d time.Duration, setup func(), drive func(ctx context.Context)) phaseResult {
	n := len(s.clients)
	p := newPhaseStats(name, n)
	for _, c := range s.clients {
		c.talking.Store(false)
	}
	setup()
	// Expected deliveries from the static matrices.
	for _, src := range s.clients {
		for _, dst := range s.clients {
			if src == dst {
				continue
			}
			p.hear[src.idx][dst.idx] = shares(src.talk, dst.listen)
		}
	}
	p.exclude[n-1] = true // room-switch probe
	s.phase.Store(p)
	time.Sleep(3 * time.Second) // routing + WebRTC renegotiation settle
	before := s.serverStats()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	talkerSamples := make(chan float64, 1)
	go func() {
		var sum, cnt float64
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				talkerSamples <- sum / math.Max(cnt, 1)
				return
			case <-t.C:
				k := 0
				for _, c := range s.clients[:n-1] {
					if c.talking.Load() {
						k++
					}
				}
				sum += float64(k)
				cnt++
			}
		}
	}()
	p.start.Store(time.Now().UnixNano())
	go drive(ctx)
	<-ctx.Done()
	cancel()
	p.end.Store(time.Now().UnixNano())
	avgTalkers := <-talkerSamples
	for _, c := range s.clients {
		c.setTalking(false)
	}
	time.Sleep(1500 * time.Millisecond) // packets in flight
	after := s.serverStats()

	res := phaseResult{Name: name, Seconds: d.Seconds(), AvgTalkers: math.Round(avgTalkers*10) / 10, Paths: map[string]pathOut{}}
	for src := 0; src < n; src++ {
		if p.exclude[src] {
			continue
		}
		sent := p.sent[src].Load()
		for dst := 0; dst < n; dst++ {
			if !p.hear[src][dst] || sent == 0 {
				continue
			}
			got := p.recv[src][dst].Load()
			res.ExpectedPackets += sent
			res.ReceivedPackets += got
			if sent >= 50 {
				loss := 100 * (1 - float64(got)/float64(sent))
				res.WorstPairLossPct = math.Max(res.WorstPairLossPct, loss)
			}
		}
	}
	if res.ExpectedPackets > 0 {
		res.LossPct = math.Round(10000*(1-float64(res.ReceivedPackets)/float64(res.ExpectedPackets))) / 100
	}
	res.WorstPairLossPct = math.Round(res.WorstPairLossPct*100) / 100
	res.Unexpected = p.unexpect.Load()
	for k, h := range p.hists {
		if h.count.Load() > 0 {
			res.Paths[k.from.String()+"→"+k.to.String()] = histOut(h)
		}
	}
	if p.routeHist.count.Load() > 0 {
		o := histOut(p.routeHist)
		res.RoomSwitchMs = &o
	}
	if before != nil && after != nil {
		wall := float64(after.TimestampUnixMs-before.TimestampUnixMs) / 1000
		srv := map[string]any{
			"cpuPctOfOneCore": math.Round(100 * (after.Process.CPUSeconds - before.Process.CPUSeconds) / wall),
			"numCpu":          after.Process.NumCPU,
			"goroutines":      after.Process.Goroutines,
			"heapMb":          math.Round(after.Process.HeapMB*10) / 10,
			"syncRunMaxMs":    after.Media.SyncRunMaxMs,
			"renegotiations":  after.Media.Renegotiations - before.Media.Renegotiations,
		}
		if before.UDPAudio != nil && after.UDPAudio != nil {
			srv["relayRxPerSec"] = math.Round(float64(after.UDPAudio.RxFrames-before.UDPAudio.RxFrames) / wall)
			srv["relayTxPerSec"] = math.Round(float64(after.UDPAudio.TxFrames-before.UDPAudio.TxFrames) / wall)
			srv["relayTxErrors"] = after.UDPAudio.TxErrors - before.UDPAudio.TxErrors
			srv["relayInboundGaps"] = after.UDPAudio.InboundGapsOver20ms - before.UDPAudio.InboundGapsOver20ms
			srv["relayMaxRouteMsEver"] = math.Round(after.UDPAudio.MaxRouteMs*10) / 10
			srv["relayQueueDrops"] = after.UDPAudio.QueueDrops - before.UDPAudio.QueueDrops
			srv["relayWorkers"] = after.UDPAudio.Workers
		}
		res.Server = srv
	}
	s.phase.Store(nil)
	return res
}

func shares(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}

func main() {
	base := flag.String("url", "http://127.0.0.1:8180", "server base URL")
	nNative := flag.Int("native", 35, "simulated desktop-app clients")
	nBrowser := flag.Int("browser", 15, "simulated browser clients")
	realistic := flag.Duration("realistic", 60*time.Second, "realistic phase length")
	stress := flag.Duration("stress", 30*time.Second, "stress phase length")
	stressTalkers := flag.Int("stress-talkers", 20, "talkers at once in the stress phase")
	alwaysOn := flag.Int("always-on", 5, "always-on talkers in the realistic phase")
	pttAvg := flag.Float64("ptt-talkers", 3, "average extra PTT talkers in the realistic phase")
	extreme := flag.Bool("extreme", false, "add a phase where everyone talks at once")
	pin := flag.String("pin", envOr("ADMIN_PIN", "123456"), "admin PIN for /api/realtime-stats")
	jsonOut := flag.String("json", "", "write the full result as JSON to this file")
	flag.Parse()

	s := &sim{base: strings.TrimRight(*base, "/"), pin: *pin, httpc: &http.Client{Timeout: 10 * time.Second}}
	s.logf = func(f string, a ...any) { fmt.Fprintf(os.Stderr, "loadsim: "+f+"\n", a...) }
	total := *nNative + *nBrowser
	if total < 4 {
		s.logf("need at least 4 clients")
		os.Exit(2)
	}
	run := fmt.Sprintf("%x", fnv.New32a().Sum32()^uint32(time.Now().UnixNano()))
	// Interleave kinds so every party line has both.
	kinds := make([]kind, 0, total)
	for i := 0; i < total; i++ {
		if len(kinds) < total && float64(countKind(kinds, kindBrowser)) < float64(*nBrowser)*float64(i+1)/float64(total) {
			kinds = append(kinds, kindBrowser)
		} else {
			kinds = append(kinds, kindNative)
		}
	}
	// The last client is the room-switch probe; keep it native.
	if kinds[total-1] == kindBrowser {
		for i := total - 2; i >= 0; i-- {
			if kinds[i] == kindNative {
				kinds[i], kinds[total-1] = kindBrowser, kindNative
				break
			}
		}
	}
	s.logf("connecting %d clients (%d app, %d browser) to %s", total, *nNative, *nBrowser, s.base)
	for i := 0; i < total; i++ {
		c := &client{sim: s, idx: i, kind: kinds[i], name: fmt.Sprintf("sim%s-%02d", run, i)}
		if err := s.connect(c); err != nil {
			s.logf("connect %d: %v", i, err)
			os.Exit(1)
		}
		s.clients = append(s.clients, c)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.sendLoop(ctx)
	time.Sleep(3 * time.Second) // ICE / DTLS for browser clients

	probe := s.clients[total-1]
	results := []phaseResult{}
	rng := rand.New(rand.NewSource(1))

	s.logf("phase realistic (%v): 4 party lines, %d always-on, ~%.0f PTT talkers", *realistic, *alwaysOn, *pttAvg)
	results = append(results, s.runPhase("realistic", *realistic, func() {
		for i, c := range s.clients[:total-1] {
			home := partyLines[i%len(partyLines)]
			listen := []string{home}
			if home != foh {
				listen = append(listen, foh)
			}
			_ = c.setMatrix(listen, []string{home})
		}
		_ = probe.setMatrix(nil, []string{probeRoom})
	}, func(ctx context.Context) {
		probe.setTalking(true)
		for _, c := range s.clients[:*alwaysOn] {
			c.setTalking(true)
		}
		// PTT: each candidate starts a 2-5 s call with a rate that keeps
		// about pttAvg extra talkers on air.
		candidates := s.clients[*alwaysOn : total-1]
		meanCall := 3.5
		rate := *pttAvg / meanCall / float64(len(candidates)) // calls per client per second
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		ends := map[*client]time.Time{}
		nextSwitch := time.Now().Add(2 * time.Second)
		var joined *client
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				for _, c := range candidates {
					if end, on := ends[c]; on {
						if now.After(end) {
							c.setTalking(false)
							delete(ends, c)
						}
					} else if rng.Float64() < rate*0.1 {
						c.setTalking(true)
						ends[c] = now.Add(time.Duration((2 + 3*rng.Float64()) * float64(time.Second)))
					}
				}
				// Room-switch probe: one listener joins the probe's room,
				// time to first audio is measured on receipt.
				if now.After(nextSwitch) {
					if joined != nil {
						_ = joined.setMatrix(without(joined.listen, probeRoom), joined.talk)
						joined = nil
						nextSwitch = now.Add(1 * time.Second)
					} else {
						joined = s.clients[rng.Intn(total-1)]
						joined.joinAt.Store(time.Now().UnixNano())
						_ = joined.setMatrix(append(append([]string{}, joined.listen...), probeRoom), joined.talk)
						nextSwitch = now.Add(2 * time.Second)
					}
				}
			}
		}
	}))

	runAll := func(name string, d time.Duration, talkers int) {
		s.logf("phase %s (%v): everyone on FOH, %d talking", name, d, talkers)
		results = append(results, s.runPhase(name, d, func() {
			for _, c := range s.clients[:total-1] {
				_ = c.setMatrix([]string{foh}, []string{foh})
			}
			_ = probe.setMatrix(nil, []string{probeRoom})
		}, func(ctx context.Context) {
			// Spread talkers over both kinds.
			order := rng.Perm(total - 1)
			for _, i := range order[:min(talkers, total-1)] {
				s.clients[i].setTalking(true)
			}
			<-ctx.Done()
		}))
	}
	runAll("stress", *stress, *stressTalkers)
	if *extreme {
		runAll("extreme", *stress, total-1)
	}

	printResults(results, *nNative, *nBrowser)
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(map[string]any{
			"createdAt": time.Now().Format(time.RFC3339),
			"server":    s.base,
			"native":    *nNative,
			"browser":   *nBrowser,
			"phases":    results,
		}, "", "  ")
		if err := os.WriteFile(*jsonOut, b, 0o644); err != nil {
			s.logf("write %s: %v", *jsonOut, err)
		}
	}
	for _, c := range s.clients {
		_ = c.ws.Close()
		if c.pc != nil {
			_ = c.pc.Close()
		}
		if c.udp != nil {
			_ = c.udp.Close()
		}
	}
}

func printResults(results []phaseResult, nNative, nBrowser int) {
	fmt.Printf("\nkesher load simulation: %d participants (%d app, %d browser)\n", nNative+nBrowser, nNative, nBrowser)
	for _, r := range results {
		fmt.Printf("\n== %s: %.0f s, avg %.1f talking, loss %.2f %% (worst pair %.2f %%), unexpected deliveries %d\n",
			r.Name, r.Seconds, r.AvgTalkers, r.LossPct, r.WorstPairLossPct, r.Unexpected)
		keys := make([]string, 0, len(r.Paths))
		for k := range r.Paths {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		fmt.Printf("   %-18s %9s %8s %8s %8s %8s\n", "path (via server)", "packets", "p50", "p95", "p99", "max")
		for _, k := range keys {
			p := r.Paths[k]
			fmt.Printf("   %-18s %9d %6.1fms %6.1fms %6.1fms %6.1fms\n", k, p.Count, p.P50, p.P95, p.P99, p.Max)
		}
		if r.RoomSwitchMs != nil {
			p := r.RoomSwitchMs
			fmt.Printf("   room switch → first audio: p50 %.1f ms, p95 %.1f ms, max %.1f ms (%d switches)\n", p.P50, p.P95, p.Max, p.Count)
		}
		if r.Server != nil {
			b, _ := json.Marshal(r.Server)
			fmt.Printf("   server: %s\n", b)
		}
	}
}

func without(list []string, x string) []string {
	out := []string{}
	for _, v := range list {
		if v != x {
			out = append(out, v)
		}
	}
	return out
}

func countKind(ks []kind, k kind) int {
	n := 0
	for _, v := range ks {
		if v == k {
			n++
		}
	}
	return n
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
