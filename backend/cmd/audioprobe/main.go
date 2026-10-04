// Command audioprobe is a headless kesher audio client used by the netlab
// test lab (make nettest / make netlab-up). It connects to one kesher
// instance, joins a room, streams real Opus audio (440 Hz sine from an
// embedded Ogg/Opus file) over WebRTC and measures the end-to-end audio
// path:
//
//   - setup latency (login, WS, offer, peer connect, first audio)
//   - WebSocket RTT (ping/pong) and room chat control-plane latency
//   - RTP loss / duplicate / reorder / RFC3550 jitter / inter-arrival
//   - jitter-buffer playout simulation (glitch rate for 60/100/160 ms)
//   - Opus decode error rate + decoded PCM energy sanity
//   - approximate E-model R-factor quality score
//   - server-side realtime stats snapshot
//
// The result is printed as a single JSON line prefixed with PROBEJSON on
// stdout; all logging goes to stderr.
package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/opus"
	"github.com/pion/opus/pkg/oggreader"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

//go:embed testdata/sine440.ogg
var sineOgg []byte

const (
	defaultAdminPIN = "123456"
	pingInterval    = 1 * time.Second
	chatInterval    = 2 * time.Second
	frameDuration   = 20 * time.Millisecond
	rtpClockRate    = 48000
	rtpPT           = 111
)

// ── config ────────────────────────────────────────────────────────────────

type config struct {
	instance     string
	role         string // "a" or "b"
	transport    string // "webrtc" (default) or "native" (Tauri UDP relay)
	room         string // room ID override ("" = bootstrap default room)
	username     string
	roleID       string
	duration     time.Duration
	nackOn       bool
	adminPIN     string
	startTimeout time.Duration
	reportDir    string
}

func configFromEnv() (config, error) {
	cfg := config{
		instance:     os.Getenv("PROBE_INSTANCE"),
		role:         os.Getenv("PROBE_ROLE"),
		transport:    envString("PROBE_TRANSPORT", "webrtc"),
		room:         os.Getenv("PROBE_ROOM"),
		duration:     time.Duration(envInt("PROBE_DURATION_SECONDS", 30)) * time.Second,
		roleID:       envString("PROBE_ROLE_ID", "audio"),
		nackOn:       envString("PROBE_NACK", "1") != "0",
		adminPIN:     envString("PROBE_ADMIN_PIN", defaultAdminPIN),
		startTimeout: time.Duration(envInt("PROBE_START_TIMEOUT_SECONDS", 120)) * time.Second,
		reportDir:    os.Getenv("PROBE_REPORT_DIR"),
	}
	if cfg.instance == "" {
		return cfg, errors.New("PROBE_INSTANCE is required (e.g. http://instance-1:8080)")
	}
	if cfg.role == "" {
		cfg.role = "a"
	}
	if cfg.role != "a" && cfg.role != "b" {
		return cfg, fmt.Errorf("PROBE_ROLE must be 'a' or 'b', got %q", cfg.role)
	}
	if cfg.transport != "webrtc" && cfg.transport != "native" {
		return cfg, fmt.Errorf("PROBE_TRANSPORT must be 'webrtc' or 'native', got %q", cfg.transport)
	}
	cfg.instance = strings.TrimRight(cfg.instance, "/")
	host := strings.TrimPrefix(strings.TrimPrefix(cfg.instance, "http://"), "https://")
	host = strings.Split(host, ":")[0]
	suffix := ""
	if cfg.transport == "native" {
		suffix = "-native"
	}
	cfg.username = "probe-" + host + "-" + cfg.role + suffix
	return cfg, nil
}

// ── mirrored kesher API types ─────────────────────────────────────────────

type loginRequest struct {
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type loginResponse struct {
	Token string `json:"token"`
}

type bootstrapResponse struct {
	Rooms []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"rooms"`
}

type roomMatrixEvent struct {
	ListenRoomIDs []string `json:"listenRoomIds"`
	TalkRoomIDs   []string `json:"talkRoomIds"`
}

type routedEvent struct {
	Scope    string `json:"scope"`
	TargetID string `json:"targetId"`
	Body     string `json:"body"`
	FromUser struct {
		Username string `json:"username"`
	} `json:"fromUser"`
}

type envelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type outbound struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type webrtcOffer struct {
	SDP string `json:"sdp"`
}

type webrtcAnswer struct {
	SDP string `json:"sdp"`
}

type webrtcIceCandidate struct {
	Candidate     string `json:"candidate"`
	SDPMid        string `json:"sdpMid,omitempty"`
	SDPMLineIndex uint16 `json:"sdpMLineIndex,omitempty"`
}

type realtimeStatsResponse struct {
	Hub struct {
		ConnectedClients        int    `json:"connectedClients"`
		NormalQueueDepthMax     int    `json:"normalQueueDepthMax"`
		PriorityQueueDepthMax   int    `json:"priorityQueueDepthMax"`
		DroppedCriticalMessages uint64 `json:"droppedCriticalMessages"`
		DroppedNormalMessages   uint64 `json:"droppedNormalMessages"`
		PresenceBroadcasts      uint64 `json:"presenceBroadcasts"`
	} `json:"hub"`
	Media struct {
		Peers                 int    `json:"peers"`
		Sources               int    `json:"sources"`
		SyncRuns              uint64 `json:"syncRuns"`
		SyncRunAvgMs          uint64 `json:"syncRunAvgMs"`
		SyncRunMaxMs          uint64 `json:"syncRunMaxMs"`
		VoiceStateToSyncAvgMs uint64 `json:"voiceStateToSyncAvgMs"`
		Renegotiations        uint64 `json:"renegotiations"`
		RenegotiationAvgMs    uint64 `json:"renegotiationAvgMs"`
	} `json:"media"`
}

// ── metrics collection ────────────────────────────────────────────────────

type dist struct {
	Samples int     `json:"samples"`
	Mean    float64 `json:"mean_ms"`
	P50     float64 `json:"p50_ms"`
	P90     float64 `json:"p90_ms"`
	P99     float64 `json:"p99_ms"`
	Max     float64 `json:"max_ms"`
}

func makeDist(samples []float64) dist {
	if len(samples) == 0 {
		return dist{}
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	pct := func(p float64) float64 {
		idx := int(math.Ceil(p*float64(len(sorted)))) - 1
		if idx < 0 {
			idx = 0
		}
		if idx >= len(sorted) {
			idx = len(sorted) - 1
		}
		return sorted[idx]
	}
	return dist{
		Samples: len(sorted),
		Mean:    sum / float64(len(sorted)),
		P50:     pct(0.50),
		P90:     pct(0.90),
		P99:     pct(0.99),
		Max:     sorted[len(sorted)-1],
	}
}

type metrics struct {
	mu            sync.Mutex
	wsRTTMS       []float64
	ctrlLatencyMS []float64
	sendGapsMS    []float64
	sentPackets   int64
	sentBytes     int64
	pingSentAt    map[string]time.Time
}

func (m *metrics) recordPong(seq string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.pingSentAt[seq]; ok {
		m.wsRTTMS = append(m.wsRTTMS, float64(time.Since(t).Microseconds())/1000.0)
		delete(m.pingSentAt, seq)
	}
}

func (m *metrics) recordControlLatency(ms float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ctrlLatencyMS = append(m.ctrlLatencyMS, ms)
}

func (m *metrics) recordSendGap(ms float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sendGapsMS = append(m.sendGapsMS, ms)
}

type rxSample struct {
	seq uint16
	ts  uint32
	arr time.Time
}

// rxAnalyzer measures the received RTP stream quality.
type rxAnalyzer struct {
	mu sync.Mutex

	seen       map[uint16]struct{}
	duplicates int
	reordered  int
	maxSeq     uint16
	maxSeqSet  bool

	hasPrev       bool
	prevArrival   time.Time
	prevTS        uint32
	jitterMS      float64
	interArrivals []float64

	samples []rxSample // arrival order

	decoder      *opus.Decoder
	hasDecoder   bool
	decodeOK     int
	decodeErrs   int
	pcmRMS       float64
	decodedPCM   int
	firstArrival time.Time

	// Native (5 ms) streams use a different sample step and frame duration.
	// Defaults (WebRTC): 960 samples / 20 ms per RTP packet.
	tsStep   uint32
	frameDur time.Duration
}

func newRXAnalyzer() *rxAnalyzer {
	return newRXAnalyzerWith(960, frameDuration)
}

// newRXAnalyzerNative builds an analyzer for the native UDP relay's 5 ms
// framing (240 samples @ 48 kHz per frame).
func newRXAnalyzerNative() *rxAnalyzer {
	return newRXAnalyzerWith(240, 5*time.Millisecond)
}

func newRXAnalyzerWith(tsStep uint32, frameDur time.Duration) *rxAnalyzer {
	a := &rxAnalyzer{seen: make(map[uint16]struct{}), tsStep: tsStep, frameDur: frameDur}
	if a.tsStep == 0 {
		a.tsStep = 960
	}
	if a.frameDur <= 0 {
		a.frameDur = frameDuration
	}
	dec, err := opus.NewDecoderWithOutput(rtpClockRate, 2)
	if err != nil {
		return a
	}
	a.decoder = &dec
	a.hasDecoder = true
	return a
}

func (a *rxAnalyzer) record(pkt *rtp.Packet) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.firstArrival.IsZero() {
		a.firstArrival = time.Now()
	}
	if _, ok := a.seen[pkt.SequenceNumber]; ok {
		a.duplicates++
		return
	}
	a.seen[pkt.SequenceNumber] = struct{}{}

	now := time.Now()
	if a.maxSeqSet {
		if int16(pkt.SequenceNumber-a.maxSeq) < 0 {
			a.reordered++
		}
		if int16(pkt.SequenceNumber-a.maxSeq) > 0 {
			a.maxSeq = pkt.SequenceNumber
		}
	} else {
		a.maxSeq = pkt.SequenceNumber
		a.maxSeqSet = true
	}

	if a.hasPrev {
		arrDiffMS := now.Sub(a.prevArrival).Seconds() * 1000
		tsDiffMS := float64(int32(pkt.Timestamp-a.prevTS)) / (rtpClockRate / 1000.0)
		d := math.Abs(arrDiffMS - tsDiffMS)
		a.jitterMS += (d - a.jitterMS) / 16.0
		a.interArrivals = append(a.interArrivals, arrDiffMS)
	} else {
		a.hasPrev = true
	}
	a.prevArrival = now
	a.prevTS = pkt.Timestamp

	a.samples = append(a.samples, rxSample{seq: pkt.SequenceNumber, ts: pkt.Timestamp, arr: now})

	if a.hasDecoder {
		pcm := make([]int16, 960*2)
		n, err := a.decoder.DecodeToInt16(pkt.Payload, pcm)
		if err != nil {
			a.decodeErrs++
			return
		}
		a.decodeOK++
		sumSq := 0.0
		for i := 0; i < n; i++ {
			v := float64(pcm[i])
			sumSq += v * v
		}
		if n > 0 {
			a.pcmRMS = math.Sqrt(sumSq / float64(n))
		}
		a.decodedPCM += n
	}
}

// playoutGlitchPct simulates a jitter buffer with the given playout delay:
// playout starts at firstArrival+buffer, then advances 20 ms per RTP frame;
// a frame counts as glitch if it has not arrived by its deadline
// (slot boundary + one frame duration).
func (a *rxAnalyzer) playoutGlitchPct(bufferMS float64) (glitchPct, latePct float64) {
	if len(a.samples) < 2 {
		return 0, 0
	}
	byTS := make(map[uint32]time.Time, len(a.samples))
	for _, s := range a.samples {
		if _, ok := byTS[s.ts]; !ok {
			byTS[s.ts] = s.arr
		}
	}
	ts0 := a.samples[0].ts
	t0 := byTS[ts0]
	lastTS := a.samples[len(a.samples)-1].ts
	expected := int((lastTS-ts0)/a.tsStep) + 1
	if expected <= 0 {
		return 0, 0
	}
	buf := time.Duration(bufferMS * float64(time.Millisecond))
	glitch, late := 0, 0
	for i := 0; i < expected; i++ {
		ts := ts0 + uint32(i)*a.tsStep
		deadline := t0.Add(buf).Add(time.Duration(i) * a.frameDur).Add(a.frameDur)
		arr, ok := byTS[ts]
		if !ok {
			glitch++
			continue
		}
		if arr.After(deadline) {
			glitch++
			late++
		}
	}
	return 100.0 * float64(glitch) / float64(expected), 100.0 * float64(late) / float64(expected)
}

// ── report ────────────────────────────────────────────────────────────────

type reportTimings struct {
	LoginMS       float64 `json:"login_ms"`
	WSConnectMS   float64 `json:"ws_connect_ms"`
	OfferRecvMS   float64 `json:"offer_received_ms"`
	PeerConnectMS float64 `json:"peer_connected_ms"`
	FirstAudioMS  float64 `json:"first_audio_ms"`
}

type sendStats struct {
	Packets  int64   `json:"packets"`
	Bytes    int64   `json:"bytes"`
	GapP99MS float64 `json:"gap_p99_ms"`
	GapMaxMS float64 `json:"gap_max_ms"`
}

type receiveStats struct {
	Packets        int                `json:"packets"`
	Lost           int                `json:"lost"`
	LostPct        float64            `json:"lost_pct"`
	Duplicates     int                `json:"duplicates"`
	Reordered      int                `json:"reordered"`
	ReorderedPct   float64            `json:"reordered_pct"`
	LatePct        float64            `json:"late_pct"`
	JitterMS       float64            `json:"jitter_ms"`
	InterArrival   dist               `json:"interarrival_ms"`
	PlayoutGlitch  map[string]float64 `json:"playout_glitch_pct"`
	OpusDecodeOK   int                `json:"opus_decode_ok"`
	OpusDecodeErrs int                `json:"opus_decode_err"`
	PCMRMS         float64            `json:"pcm_rms"`
}

type report struct {
	Instance    string                 `json:"instance"`
	Role        string                 `json:"role"`
	Transport   string                 `json:"transport"`
	OK          bool                   `json:"ok"`
	Error       string                 `json:"error,omitempty"`
	Opus        bool                   `json:"opus"`
	DurationSec float64                `json:"duration_sec"`
	Timings     reportTimings          `json:"timings"`
	WSRTT       dist                   `json:"ws_rtt_ms"`
	CtrlLatency dist                   `json:"control_latency_ms"`
	Send        sendStats              `json:"send"`
	Receive     receiveStats           `json:"receive"`
	Quality     float64                `json:"quality_score"`
	Server      realtimeStatsResponse  `json:"server_stats"`
}

// qualityScore approximates the ITU-T G.107 R-factor from one-way delay,
// jitter and end-to-end loss. It is a rough comparative score, not a
// certified MOS measurement.
func qualityScore(oneWayMS, jitterMS, lossPct float64) float64 {
	r := 94.2
	id := 0.024*oneWayMS + 0.11*math.Max(0, oneWayMS-177.3) + 0.05*jitterMS
	ie := 5 + 18*math.Log(1+0.1*lossPct)
	r -= id + ie
	if r < 0 {
		r = 0
	}
	if r > 100 {
		r = 100
	}
	return math.Round(r*10) / 10
}

// ── kesher client ─────────────────────────────────────────────────────────

type probeClient struct {
	cfg      config
	baseHTTP string
	baseWS   string
	httpc    *http.Client
	conn     *websocket.Conn
	writeMu  sync.Mutex
	msgCh    chan envelope
	errCh    chan error

	m   *metrics
	rep *report

	room string
}

func newProbeClient(cfg config) *probeClient {
	baseWS := "ws" + strings.TrimPrefix(cfg.instance, "http")
	return &probeClient{
		cfg:      cfg,
		baseHTTP: cfg.instance,
		baseWS:   baseWS,
		httpc:    &http.Client{Timeout: 30 * time.Second},
		msgCh:    make(chan envelope, 256),
		errCh:    make(chan error, 1),
		m:        &metrics{pingSentAt: make(map[string]time.Time)},
		rep:      &report{Instance: instanceName(cfg), Role: cfg.role, Opus: true},
	}
}

func instanceName(cfg config) string {
	host := strings.TrimPrefix(strings.TrimPrefix(cfg.instance, "http://"), "https://")
	return strings.Split(host, ":")[0]
}

func (c *probeClient) sendWS(ctx context.Context, msg outbound) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

func (c *probeClient) readLoop() {
	c.conn.SetPongHandler(func(appData string) error {
		c.m.recordPong(appData)
		return nil
	})
	for {
		c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		_, payload, err := c.conn.ReadMessage()
		if err != nil {
			c.errCh <- err
			return
		}
		var env envelope
		if err := json.Unmarshal(payload, &env); err != nil {
			continue
		}
		select {
		case c.msgCh <- env:
		default:
			// control messages must never be dropped
			if env.Type == "webrtc_offer" || env.Type == "webrtc_ice_candidate" {
				c.msgCh <- env
			}
		}
	}
}

func (c *probeClient) pingLoop(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	seq := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			seq++
			id := strconv.Itoa(seq)
			c.m.mu.Lock()
			c.m.pingSentAt[id] = time.Now()
			c.m.mu.Unlock()
			_ = c.conn.WriteControl(websocket.PingMessage, []byte(id), time.Now().Add(5*time.Second))
		}
	}
}

func (c *probeClient) chatLoop(ctx context.Context) {
	ticker := time.NewTicker(chatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			msg := outbound{
				Type: "chat",
				Data: routedEvent{
					Scope:    "room",
					TargetID: c.room,
					Body:     fmt.Sprintf("latprobe|%d", time.Now().UnixNano()),
				},
			}
			_ = c.sendWS(ctx, msg)
		}
	}
}

// ── WebRTC ────────────────────────────────────────────────────────────────

type webrtcSession struct {
	pc           *webrtc.PeerConnection
	track        *webrtc.TrackLocalStaticRTP
	pendingICE   []webrtc.ICECandidateInit
	remoteSet    bool
	mu           sync.Mutex
	offerRecvAt  time.Time
	connectedAt  time.Time
	firstRTPAt   time.Time
	connectedOne sync.Once
	analyzer     *rxAnalyzer
}

func (s *webrtcSession) markConnected() {
	s.mu.Lock()
	if s.connectedAt.IsZero() {
		s.connectedAt = time.Now()
	}
	s.mu.Unlock()
}

func (s *webrtcSession) connected() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connectedAt
}

func (s *webrtcSession) markFirstRTP() {
	s.mu.Lock()
	if s.firstRTPAt.IsZero() {
		s.firstRTPAt = time.Now()
	}
	s.mu.Unlock()
}

func (s *webrtcSession) firstRTP() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.firstRTPAt
}

func (c *probeClient) newSession(ctx context.Context) (*webrtcSession, error) {
	se := webrtc.SettingEngine{}
	se.SetICEMulticastDNSMode(0)
	se.SetSRTPReplayProtectionWindow(128)
	se.SetReceiveMTU(1200)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	if !c.cfg.nackOn {
		api = webrtc.NewAPI(
			webrtc.WithSettingEngine(se),
			webrtc.WithInterceptorRegistry(&interceptor.Registry{}),
		)
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: rtpClockRate,
			Channels:  2,
		},
		"audio-"+c.cfg.username,
		"netlab",
	)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, rtcpErr := sender.Read(buf); rtcpErr != nil {
				return
			}
		}
	}()

	sess := &webrtcSession{track: track, analyzer: newRXAnalyzer()}

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			sess.connectedOne.Do(sess.markConnected)
		}
	})
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		init := candidate.ToJSON()
		msg := webrtcIceCandidate{Candidate: init.Candidate}
		if init.SDPMid != nil {
			msg.SDPMid = *init.SDPMid
		}
		if init.SDPMLineIndex != nil {
			msg.SDPMLineIndex = *init.SDPMLineIndex
		}
		_ = c.sendWS(ctx, outbound{Type: "webrtc_ice_candidate", Data: msg})
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				pkt, _, readErr := remote.ReadRTP()
				if readErr != nil {
					return
				}
				sess.markFirstRTP()
				sess.analyzer.record(pkt)
			}
		}()
	})

	sess.pc = pc
	return sess, nil
}

func (c *probeClient) handleOffer(ctx context.Context, sess *webrtcSession, offer webrtcOffer) error {
	if err := sess.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offer.SDP,
	}); err != nil {
		return err
	}
	sess.remoteSet = true
	for _, candidate := range sess.pendingICE {
		if err := sess.pc.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	sess.pendingICE = nil
	answer, err := sess.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := sess.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	return c.sendWS(ctx, outbound{Type: "webrtc_answer", Data: webrtcAnswer{SDP: answer.SDP}})
}

func (c *probeClient) handleICECandidate(sess *webrtcSession, candidate webrtcIceCandidate) error {
	var mid *string
	if candidate.SDPMid != "" {
		mid = &candidate.SDPMid
	}
	line := candidate.SDPMLineIndex
	init := webrtc.ICECandidateInit{
		Candidate:     candidate.Candidate,
		SDPMid:        mid,
		SDPMLineIndex: &line,
	}
	if !sess.remoteSet {
		sess.pendingICE = append(sess.pendingICE, init)
		return nil
	}
	return sess.pc.AddICECandidate(init)
}

// ── native UDP relay transport (Tauri performance mode) ───────────────────

const (
	nativeHeaderLen = 16
	nativeMagic     = "KSHR"
	nativeVersion   = 0x01

	flagAudio     byte = 1 << 0
	flagRegister  byte = 1 << 1
	flagHeartbeat byte = 1 << 2

	nativeClockRate = 48000
	udpMaxPacket    = 1200
)

type nativeAudioEndpoint struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	TokenHash uint32 `json:"tokenHash"`
	Channels  int    `json:"channels"`
}

func nativeTokenHash(token string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte("KSHR-AUD"))
	_, _ = h.Write([]byte(token))
	return h.Sum32()
}

func encodeNativePacket(dst []byte, flags byte, seq uint16, ts uint32, tokenHash uint32, payload []byte) int {
	copy(dst[0:4], nativeMagic)
	dst[4] = nativeVersion
	dst[5] = flags
	binary.BigEndian.PutUint16(dst[6:8], seq)
	binary.BigEndian.PutUint32(dst[8:12], ts)
	binary.BigEndian.PutUint32(dst[12:16], tokenHash)
	copy(dst[nativeHeaderLen:], payload)
	return nativeHeaderLen + len(payload)
}

// nativeSession drives a native (UDP relay) audio client.
type nativeSession struct {
	mu           sync.Mutex
	conn         *net.UDPConn
	tokenHash    uint32
	seq          uint16
	ts           uint32
	firstAudioAt time.Time
	anchorAt     time.Time
	analyzer     *rxAnalyzer
}

func (s *nativeSession) markFirstAudio() {
	s.mu.Lock()
	if s.firstAudioAt.IsZero() {
		s.firstAudioAt = time.Now()
	}
	s.mu.Unlock()
}

func (s *nativeSession) firstAudio() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.firstAudioAt
}

func (s *nativeSession) sendPacket(flags byte, payload []byte) error {
	s.mu.Lock()
	buf := make([]byte, nativeHeaderLen+len(payload))
	n := encodeNativePacket(buf, flags, s.seq, s.ts, s.tokenHash, payload)
	s.seq++
	if flags&flagAudio != 0 {
		s.ts += nativeClockRate / 200 // 5 ms @ 48 kHz
	}
	s.mu.Unlock()
	_, err := s.conn.Write(buf[:n])
	return err
}

func (s *nativeSession) sendRegister(token string) error {
	s.mu.Lock()
	s.tokenHash = nativeTokenHash(token)
	s.anchorAt = time.Now()
	s.mu.Unlock()
	return s.sendPacket(flagRegister, []byte(token))
}

func (s *nativeSession) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = s.sendPacket(flagHeartbeat, nil)
		}
	}
}

func (s *nativeSession) sendAudioLoop(ctx context.Context, src *audioSource, m *metrics) {
	t := time.NewTicker(5 * time.Millisecond)
	defer t.Stop()
	last := time.Now()
	first := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now()
			if !first {
				m.recordSendGap(now.Sub(last).Seconds() * 1000)
			}
			first = false
			last = now
			payload := src.next()
			if payload == nil {
				payload = make([]byte, 80)
			}
			if err := s.sendPacket(flagAudio, payload); err != nil {
				return
			}
			m.mu.Lock()
			m.sentPackets++
			m.sentBytes += int64(len(payload))
			m.mu.Unlock()
		}
	}
}

// recvLoop reads datagrams from the relay and feeds the analyzer. The relay
// re-encodes every forwarded frame with its own sequence/timestamp, so loss
// and jitter measurements are of the relay's output stream.
func (s *nativeSession) recvLoop() {
	buf := make([]byte, udpMaxPacket)
	for {
		n, err := s.conn.Read(buf)
		if err != nil {
			return
		}
		if n < nativeHeaderLen {
			continue
		}
		if string(buf[0:4]) != nativeMagic || buf[4] != nativeVersion {
			continue
		}
		if buf[5]&flagAudio == 0 {
			continue
		}
		pkt := &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				PayloadType:    rtpPT,
				SequenceNumber: binary.BigEndian.Uint16(buf[6:8]),
				Timestamp:      binary.BigEndian.Uint32(buf[8:12]),
				SSRC:           0x4e4154, // "NAT"
			},
			Payload: buf[nativeHeaderLen:n],
		}
		s.markFirstAudio()
		s.analyzer.record(pkt)
	}
}

// collectReceive computes the receive-side stats shared by both transports.
func collectReceive(an *rxAnalyzer) receiveStats {
	var st receiveStats
	an.mu.Lock()
	defer an.mu.Unlock()
	unique := len(an.seen)
	lost := packetsLost(an.samples)
	expected := unique + lost
	if expected < 1 {
		expected = 1
	}
	st.Packets = unique
	st.Lost = lost
	st.LostPct = 100.0 * float64(lost) / float64(expected)
	st.Duplicates = an.duplicates
	st.Reordered = an.reordered
	if unique > 0 {
		st.ReorderedPct = 100.0 * float64(an.reordered) / float64(unique)
	}
	st.JitterMS = an.jitterMS
	st.InterArrival = makeDist(an.interArrivals)
	st.OpusDecodeOK = an.decodeOK
	st.OpusDecodeErrs = an.decodeErrs
	st.PCMRMS = an.pcmRMS
	glitch60, _ := an.playoutGlitchPct(60)
	glitch100, late100 := an.playoutGlitchPct(100)
	glitch160, _ := an.playoutGlitchPct(160)
	st.LatePct = late100
	st.PlayoutGlitch = map[string]float64{
		"buf60ms":  round1(glitch60),
		"buf100ms": round1(glitch100),
		"buf160ms": round1(glitch160),
	}
	return st
}

func computeQuality(rep *report, unique int) {
	rep.Quality = qualityScore(rep.WSRTT.Mean/2.0, rep.Receive.JitterMS, rep.Receive.LostPct)
	if rep.WSRTT.Samples == 0 || unique == 0 {
		rep.Quality = 0
	}
}

// ── audio source ──────────────────────────────────────────────────────────

type audioSource struct {
	frames  [][]byte // opus frames from embedded ogg
	idx     int
	useOpus bool
}

func loadAudioSource() (*audioSource, error) {
	src := &audioSource{useOpus: true}
	reader, _, err := oggreader.NewWith(bytes.NewReader(sineOgg))
	if err != nil {
		return nil, fmt.Errorf("open embedded ogg: %w", err)
	}
	for {
		pkt, _, err := reader.ParseNextPacket()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse ogg packet: %w", err)
		}
		src.frames = append(src.frames, pkt)
	}
	if len(src.frames) == 0 {
		return nil, errors.New("no opus frames found in embedded ogg")
	}
	return src, nil
}

func (s *audioSource) next() []byte {
	if len(s.frames) == 0 {
		return nil
	}
	f := s.frames[s.idx]
	s.idx = (s.idx + 1) % len(s.frames)
	return f
}

func (c *probeClient) sendAudioLoop(ctx context.Context, sess *webrtcSession, src *audioSource) {
	ticker := time.NewTicker(frameDuration)
	defer ticker.Stop()
	seq := uint16(time.Now().UnixNano() % 65535)
	ts := uint32(time.Now().UnixNano() % (1 << 30))
	ssrc := uint32(1000 + time.Now().UnixNano()%9000)

	last := time.Now()
	first := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			if !first {
				c.m.recordSendGap(now.Sub(last).Seconds() * 1000)
			}
			first = false
			last = now
			payload := src.next()
			if payload == nil {
				payload = make([]byte, 120)
			}
			pkt := &rtp.Packet{
				Header: rtp.Header{
					Version:        2,
					PayloadType:    rtpPT,
					SequenceNumber: seq,
					Timestamp:      ts,
					SSRC:           ssrc,
				},
				Payload: payload,
			}
			if err := sess.track.WriteRTP(pkt); err != nil {
				return
			}
			c.m.mu.Lock()
			c.m.sentPackets++
			c.m.sentBytes += int64(len(payload))
			c.m.mu.Unlock()
			seq++
			ts += 960
		}
	}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

func (c *probeClient) login(ctx context.Context) (string, error) {
	body, _ := json.Marshal(loginRequest{Username: c.cfg.username, RoleID: c.cfg.roleID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseHTTP+"/api/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("login status=%d body=%s", resp.StatusCode, string(b))
	}
	var out loginResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", errors.New("empty login token")
	}
	return out.Token, nil
}

func (c *probeClient) bootstrap(ctx context.Context, token string) (string, error) {
	// The instance may briefly return 500 right after startup while the
	// SQLite store is busy (concurrent logins); retry a few times.
	var lastErr error
	for attempt := 1; attempt <= 5; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseHTTP+"/api/bootstrap", nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := c.httpc.Do(req)
		if err != nil {
			return "", err
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			var out bootstrapResponse
			if err := json.Unmarshal(b, &out); err != nil {
				return "", err
			}
			if len(out.Rooms) == 0 {
				return "foh", nil
			}
			return out.Rooms[0].ID, nil
		}
		lastErr = fmt.Errorf("bootstrap status=%d body=%s", resp.StatusCode, string(b))
		if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized {
			return "", lastErr
		}
		select {
		case <-ctx.Done():
			return "", lastErr
		case <-time.After(500 * time.Millisecond):
		}
	}
	return "", lastErr
}

func (c *probeClient) serverStats(ctx context.Context, token string) (realtimeStatsResponse, error) {
	var out realtimeStatsResponse
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseHTTP+"/api/realtime-stats", nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Admin-Pin", c.cfg.adminPIN)
	resp, err := c.httpc.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("realtime stats status=%d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, err
	}
	return out, nil
}

// ── main flow ─────────────────────────────────────────────────────────────

func runProbe(ctx context.Context, cfg config) *report {
	rep := &report{
		Instance:  instanceName(cfg),
		Role:      cfg.role,
		Transport: cfg.transport,
		Opus:      true,
	}
	client := newProbeClient(cfg)
	logf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "audioprobe[%s-%s]: %s\n", rep.Instance, rep.Role, fmt.Sprintf(format, args...))
	}

	// login with retry (also serves as health wait)
	loginStart := time.Now()
	token := ""
	var err error
	deadline := time.Now().Add(cfg.startTimeout)
	for time.Now().Before(deadline) {
		token, err = client.login(ctx)
		if err == nil {
			break
		}
		logf("login failed (%v), retrying...", err)
		time.Sleep(1 * time.Second)
	}
	if err != nil {
		rep.OK = false
		rep.Error = "login: " + err.Error()
		return rep
	}
	rep.Timings.LoginMS = msSince(loginStart)
	logf("login ok (%d ms)", int(rep.Timings.LoginMS))

	room, err := client.bootstrap(ctx, token)
	if err != nil {
		rep.OK = false
		rep.Error = "bootstrap: " + err.Error()
		return rep
	}
	if cfg.room != "" {
		room = cfg.room
	}
	client.room = room
	logf("bootstrap ok, room=%s (transport=%s)", room, cfg.transport)

	wsStart := time.Now()
	wsURL := client.baseWS + "/ws?token=" + token
	if cfg.transport == "native" {
		wsURL += "&transport=native"
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		rep.OK = false
		rep.Error = "ws dial: " + err.Error()
		return rep
	}
	client.conn = conn
	rep.Timings.WSConnectMS = msSince(wsStart)
	logf("ws connected (%d ms)", int(rep.Timings.WSConnectMS))

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	go client.readLoop()
	go client.pingLoop(runCtx)
	go client.chatLoop(runCtx)
	defer func() { _ = conn.Close() }()

	if err := client.sendWS(ctx, outbound{Type: "set_room_matrix", Data: roomMatrixEvent{
		ListenRoomIDs: []string{room},
		TalkRoomIDs:   []string{room},
	}}); err != nil {
		rep.OK = false
		rep.Error = "matrix: " + err.Error()
		return rep
	}
	if err := client.sendWS(ctx, outbound{Type: "voice_state", Data: routedEvent{
		Scope: "room", TargetID: room, Body: "ptt_start",
	}}); err != nil {
		rep.OK = false
		rep.Error = "voice_state: " + err.Error()
		return rep
	}
	readySentAt := time.Now()
	if cfg.transport == "webrtc" {
		if err := client.sendWS(ctx, outbound{Type: "webrtc_ready"}); err != nil {
			rep.OK = false
			rep.Error = "webrtc_ready: " + err.Error()
			return rep
		}
	}
	logf("ready, waiting for offer...")

	if cfg.transport == "native" {
		return client.runNativeProbe(ctx, rep, cfg, token, readySentAt, logf)
	}

	sess, err := client.newSession(ctx)
	if err != nil {
		rep.OK = false
		rep.Error = "webrtc: " + err.Error()
		return rep
	}
	defer func() { _ = sess.pc.Close() }()

	src, err := loadAudioSource()
	if err != nil {
		logf("opus source unavailable, falling back to synthetic payloads: %v", err)
		rep.Opus = false
		src = &audioSource{}
	}

	go client.sendAudioLoop(runCtx, sess, src)

	measureDone := make(chan struct{})
	go func() {
		// start the measurement window once the peer connection is up
		for sess.connected().IsZero() {
			select {
			case <-runCtx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
		select {
		case <-runCtx.Done():
			return
		case <-time.After(cfg.duration):
			close(measureDone)
		}
	}()

	partner := "b"
	if cfg.role == "b" {
		partner = "a"
	}
	partnerName := "probe-" + instanceName(cfg) + "-" + partner

loop:
	for {
		select {
		case <-ctx.Done():
			rep.OK = false
			rep.Error = "context cancelled: " + ctx.Err().Error()
			return rep
		case <-measureDone:
			break loop
		case err := <-client.errCh:
			rep.OK = false
			rep.Error = "ws read: " + err.Error()
			return rep
		case env := <-client.msgCh:
			switch env.Type {
			case "webrtc_offer":
				var offer webrtcOffer
				if err := json.Unmarshal(env.Data, &offer); err != nil {
					continue
				}
				if sess.offerRecvAt.IsZero() {
					sess.offerRecvAt = time.Now()
					rep.Timings.OfferRecvMS = msSince(readySentAt)
					logf("offer received (%d ms)", int(rep.Timings.OfferRecvMS))
				}
				if err := client.handleOffer(ctx, sess, offer); err != nil {
					rep.OK = false
					rep.Error = "handle offer: " + err.Error()
					return rep
				}
			case "webrtc_ice_candidate":
				var ice webrtcIceCandidate
				if err := json.Unmarshal(env.Data, &ice); err != nil {
					continue
				}
				if err := client.handleICECandidate(sess, ice); err != nil {
					logf("add ice candidate failed: %v", err)
				}
			case "chat":
				var ev routedEvent
				if err := json.Unmarshal(env.Data, &ev); err != nil {
					continue
				}
				if ev.FromUser.Username == partnerName && strings.HasPrefix(ev.Body, "latprobe|") {
					if ts, err := strconv.ParseInt(strings.TrimPrefix(ev.Body, "latprobe|"), 10, 64); err == nil {
						client.m.recordControlLatency(float64(time.Since(time.Unix(0, ts)).Microseconds()) / 1000.0)
					}
				}
			}
		}
	}

	// ── measurement window finished: collect stats ─────────────────────────
	rep.DurationSec = cfg.duration.Seconds()
	if connTime := sess.connected(); !connTime.IsZero() {
		rep.Timings.PeerConnectMS = connTime.Sub(sess.offerRecvAt).Seconds() * 1000
		if first := sess.firstRTP(); !first.IsZero() {
			rep.Timings.FirstAudioMS = first.Sub(sess.offerRecvAt).Seconds() * 1000
		} else {
			rep.Timings.FirstAudioMS = -1
		}
	} else {
		rep.OK = false
		rep.Error = "peer connection never became connected"
		return rep
	}

	client.m.mu.Lock()
	rep.WSRTT = makeDist(client.m.wsRTTMS)
	rep.CtrlLatency = makeDist(client.m.ctrlLatencyMS)
	sendGaps := makeDist(client.m.sendGapsMS)
	rep.Send = sendStats{
		Packets:  client.m.sentPackets,
		Bytes:    client.m.sentBytes,
		GapP99MS: sendGaps.P99,
		GapMaxMS: sendGaps.Max,
	}
	client.m.mu.Unlock()

	an := sess.analyzer
	unique := len(an.seen)
	rep.Receive = collectReceive(an)

	if stats, err := client.serverStats(ctx, token); err == nil {
		rep.Server = stats
	} else {
		logf("server stats unavailable: %v", err)
	}

	computeQuality(rep, unique)
	rep.OK = true
	logf("done: rtt_p50=%.1fms loss=%.2f%% jitter=%.2fms glitch@100ms=%.2f%% score=%.1f",
		rep.WSRTT.P50, rep.Receive.LostPct, rep.Receive.JitterMS, rep.Receive.PlayoutGlitch["buf100ms"], rep.Quality)
	return rep
}

// runNativeProbe drives the native (Tauri) UDP relay transport: it waits for
// the native_audio_endpoint message, REGISTERs with the relay, streams Opus
// frames over raw UDP at 5 ms cadence and measures the same quality metrics
// as the WebRTC probe so both transports can be compared side by side.
func (c *probeClient) runNativeProbe(ctx context.Context, rep *report, cfg config, token string, readySentAt time.Time, logf func(format string, args ...any)) *report {
	ns := &nativeSession{analyzer: newRXAnalyzerNative()}

	// 1. wait for native_audio_endpoint (sent right after WS connect)
	waitCtx, cancelWait := context.WithTimeout(ctx, 30*time.Second)
	defer cancelWait()
	var endpoint nativeAudioEndpoint
	gotEndpoint := false
	for !gotEndpoint {
		select {
		case <-waitCtx.Done():
			rep.OK = false
			rep.Error = "native: timed out waiting for native_audio_endpoint"
			return rep
		case err := <-c.errCh:
			rep.OK = false
			rep.Error = "ws read: " + err.Error()
			return rep
		case env := <-c.msgCh:
			if env.Type != "native_audio_endpoint" {
				continue
			}
			if err := json.Unmarshal(env.Data, &endpoint); err != nil {
				continue
			}
			gotEndpoint = true
		}
	}
	rep.Timings.OfferRecvMS = msSince(readySentAt)
	logf("native endpoint %s:%d received (%d ms)", endpoint.Host, endpoint.Port, int(rep.Timings.OfferRecvMS))

	// 2. connect UDP socket + REGISTER with the relay
	raddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", endpoint.Host, endpoint.Port))
	if err != nil {
		rep.OK = false
		rep.Error = "native: resolve endpoint: " + err.Error()
		return rep
	}
	uconn, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		rep.OK = false
		rep.Error = "native: dial relay: " + err.Error()
		return rep
	}
	ns.conn = uconn
	defer func() { _ = uconn.Close() }()
	if err := ns.sendRegister(endpoint.Token); err != nil {
		rep.OK = false
		rep.Error = "native: register: " + err.Error()
		return rep
	}
	regAt := ns.anchorAt
	rep.Timings.PeerConnectMS = msSince(regAt)
	logf("registered with relay (%d ms)", int(rep.Timings.PeerConnectMS))

	// 3. start heartbeat, send and receive loops
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	go ns.heartbeatLoop(runCtx)
	src, err := loadAudioSource()
	if err != nil {
		logf("opus source unavailable, falling back to synthetic payloads: %v", err)
		rep.Opus = false
		src = &audioSource{}
	}
	go ns.sendAudioLoop(runCtx, src, c.m)
	go ns.recvLoop()

	// 4. wait for the first received audio frame (pipeline up)
	firstCtx, cancelFirst := context.WithTimeout(ctx, 30*time.Second)
	defer cancelFirst()
	for ns.firstAudio().IsZero() {
		select {
		case <-firstCtx.Done():
			rep.OK = false
			rep.Error = "native: no audio received (partner not routing?)"
			return rep
		case err := <-c.errCh:
			rep.OK = false
			rep.Error = "ws read: " + err.Error()
			return rep
		case env := <-c.msgCh:
			if env.Type == "chat" {
				consumeChat(c, cfg, env)
			}
		case <-time.After(50 * time.Millisecond):
		}
	}
	rep.Timings.FirstAudioMS = ns.firstAudio().Sub(ns.anchorAt).Seconds() * 1000
	logf("first audio after %d ms", int(rep.Timings.FirstAudioMS))

	// 5. measurement window
	measureDone := make(chan struct{})
	go func() {
		select {
		case <-runCtx.Done():
			return
		case <-time.After(cfg.duration):
			close(measureDone)
		}
	}()

loop:
	for {
		select {
		case <-ctx.Done():
			rep.OK = false
			rep.Error = "context cancelled: " + ctx.Err().Error()
			return rep
		case <-measureDone:
			break loop
		case err := <-c.errCh:
			rep.OK = false
			rep.Error = "ws read: " + err.Error()
			return rep
		case env := <-c.msgCh:
			if env.Type == "chat" {
				consumeChat(c, cfg, env)
			}
		}
	}

	// ── measurement window finished: collect stats ─────────────────────────
	rep.DurationSec = cfg.duration.Seconds()
	c.m.mu.Lock()
	rep.WSRTT = makeDist(c.m.wsRTTMS)
	rep.CtrlLatency = makeDist(c.m.ctrlLatencyMS)
	sendGaps := makeDist(c.m.sendGapsMS)
	rep.Send = sendStats{
		Packets:  c.m.sentPackets,
		Bytes:    c.m.sentBytes,
		GapP99MS: sendGaps.P99,
		GapMaxMS: sendGaps.Max,
	}
	c.m.mu.Unlock()

	unique := len(ns.analyzer.seen)
	rep.Receive = collectReceive(ns.analyzer)

	if stats, err := c.serverStats(ctx, token); err == nil {
		rep.Server = stats
	} else {
		logf("server stats unavailable: %v", err)
	}

	computeQuality(rep, unique)
	rep.OK = true
	logf("done: rtt_p50=%.1fms loss=%.2f%% jitter=%.2fms glitch@100ms=%.2f%% score=%.1f",
		rep.WSRTT.P50, rep.Receive.LostPct, rep.Receive.JitterMS, rep.Receive.PlayoutGlitch["buf100ms"], rep.Quality)
	return rep
}

// consumeChat records the partner's latprobe control-plane latency.
func consumeChat(c *probeClient, cfg config, env envelope) {
	var ev routedEvent
	if err := json.Unmarshal(env.Data, &ev); err != nil {
		return
	}
	partner := "b"
	if cfg.role == "b" {
		partner = "a"
	}
	partnerName := strings.Replace(cfg.username, "-"+cfg.role, "-"+partner, 1)
	if ev.FromUser.Username == partnerName && strings.HasPrefix(ev.Body, "latprobe|") {
		if ts, err := strconv.ParseInt(strings.TrimPrefix(ev.Body, "latprobe|"), 10, 64); err == nil {
			c.m.recordControlLatency(float64(time.Since(time.Unix(0, ts)).Microseconds()) / 1000.0)
		}
	}
}

// packetsLost counts missing sequence numbers between the first and last
// observed sample (forward-only estimate, unaffected by reordering).
func packetsLost(samples []rxSample) int {
	if len(samples) == 0 {
		return 0
	}
	first := samples[0].seq
	last := samples[len(samples)-1].seq
	if last == first {
		return 0
	}
	span := int(uint16(last - first))
	seenMap := make(map[uint16]struct{}, len(samples))
	for _, s := range samples {
		if _, ok := seenMap[s.seq]; !ok {
			seenMap[s.seq] = struct{}{}
		}
	}
	lost := span - len(seenMap) + 1
	if lost < 0 {
		return 0
	}
	return lost
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

// ── entry ─────────────────────────────────────────────────────────────────

func msSince(t time.Time) float64 {
	if t.IsZero() {
		return 0
	}
	return float64(time.Since(t).Microseconds()) / 1000.0
}

func main() {
	cfg, err := configFromEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "audioprobe: %v\n", err)
		writeReport(&report{Instance: "?", Role: "?", OK: false, Error: err.Error()})
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), cfg.duration+3*time.Minute)
	defer cancel()
	rep := runProbe(ctx, cfg)
	writeReport(rep)
	if !rep.OK {
		os.Exit(1)
	}
}

func writeReport(rep *report) {
	sanitizeReport(rep)
	payload, err := json.Marshal(rep)
	if err != nil {
		fmt.Fprintf(os.Stderr, "audioprobe: marshal report: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("PROBEJSON " + string(payload))
}

// sanitizeReport replaces NaN / ±Inf float values with 0 and logs which
// field carried them, so a bad computation can never corrupt the report.
func sanitizeReport(rep *report) {
	var walk func(v reflect.Value, path string)
	walk = func(v reflect.Value, path string) {
		switch v.Kind() {
		case reflect.Pointer:
			if !v.IsNil() {
				walk(v.Elem(), path)
			}
		case reflect.Struct:
			for i := 0; i < v.NumField(); i++ {
				f := v.Field(i)
				child := path + "." + v.Type().Field(i).Name
				if !f.CanInterface() {
					continue
				}
				if f.Kind() == reflect.Float64 {
					val := f.Float()
					if math.IsNaN(val) || math.IsInf(val, 0) {
						fmt.Fprintf(os.Stderr, "audioprobe: sanitized non-finite value in %s\n", child)
						f.SetFloat(0)
					}
					continue
				}
				walk(f, child)
			}
		case reflect.Map:
			iter := v.MapRange()
			for iter.Next() {
				k, mv := iter.Key(), iter.Value()
				if mv.CanInterface() && mv.Kind() == reflect.Float64 {
					val := mv.Float()
					if math.IsNaN(val) || math.IsInf(val, 0) {
						fmt.Fprintf(os.Stderr, "audioprobe: sanitized non-finite value in %s[%v]\n", path, k)
						mv.SetFloat(0)
					}
					continue
				}
				walk(mv, path)
			}
		}
	}
	walk(reflect.ValueOf(rep), "report")
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func envString(key, fallback string) string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	return raw
}
