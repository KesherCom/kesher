//go:build loadtest

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var errSimulatedDisconnect = errors.New("simulated network disconnect")

type loadStage struct {
	TargetClients int
	HoldDuration  time.Duration
}

type loadNetworkProfile struct {
	BaseLatency           time.Duration
	Jitter                time.Duration
	SpikeChance           float64
	SpikeLatency          time.Duration
	PacketLoss            float64
	MediaPacketLoss       float64
	DisconnectsPerMinute  float64
	SlowReceiverReadDelay time.Duration
}

type loadScenario struct {
	Stages          []loadStage
	RampInterval    time.Duration
	ActionInterval  time.Duration
	MonitorInterval time.Duration
	ConnectTimeout  time.Duration
	AdminPIN        string
	Roles           []string
	Network         loadNetworkProfile
}

type loadMetrics struct {
	loginsOK             atomic.Uint64
	loginErrors          atomic.Uint64
	bootstrapErrors      atomic.Uint64
	wsConnectsOK         atomic.Uint64
	wsConnectErrors      atomic.Uint64
	reconnects           atomic.Uint64
	sendAttempts         atomic.Uint64
	sendDroppedByLoss    atomic.Uint64
	sendErrors           atomic.Uint64
	receivedMessages     atomic.Uint64
	readErrors           atomic.Uint64
	simulatedDisconnects atomic.Uint64
	activeClients        atomic.Int64
	maxActiveClients     atomic.Int64

	mediaOffersReceived atomic.Uint64
	mediaAnswersSent    atomic.Uint64
	mediaICEReceived    atomic.Uint64
	mediaICESent        atomic.Uint64
	mediaPeersConnected atomic.Uint64
	mediaRTPSent        atomic.Uint64
	mediaRTPDropped     atomic.Uint64
	mediaRTPReceived    atomic.Uint64

	mu             sync.Mutex
	receivedByType map[string]uint64
}

func newLoadMetrics() *loadMetrics {
	return &loadMetrics{
		receivedByType: make(map[string]uint64),
	}
}

func (m *loadMetrics) incActive(delta int64) {
	current := m.activeClients.Add(delta)
	for {
		maxSeen := m.maxActiveClients.Load()
		if current <= maxSeen {
			return
		}
		if m.maxActiveClients.CompareAndSwap(maxSeen, current) {
			return
		}
	}
}

func (m *loadMetrics) recordReceivedType(msgType string) {
	m.mu.Lock()
	m.receivedByType[msgType]++
	m.mu.Unlock()
}

func (m *loadMetrics) snapshotTypes() map[string]uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]uint64, len(m.receivedByType))
	for k, v := range m.receivedByType {
		out[k] = v
	}
	return out
}

type stageObservedMax struct {
	hubConnectedClients int
	hubNormalQueueMax   int
	hubPriorityQueueMax int
	hubDroppedCritical  uint64
	hubDroppedNormal    uint64
	mediaPeers          int
	mediaRenegotiations uint64
}

type simulatedClient struct {
	id       int
	username string
	role     string
	baseHTTP string
	baseWS   string
	httpc    *http.Client
	wsDialer *websocket.Dialer
	scenario loadScenario
	metrics  *loadMetrics
	rng      *rand.Rand
	rngMu    sync.Mutex
}

type wsEnvelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type mediaSession struct {
	pc                   *webrtc.PeerConnection
	localTrack           *webrtc.TrackLocalStaticRTP
	pendingRemoteICE     []webrtc.ICECandidateInit
	remoteDescriptionSet bool
	cancelAudio          context.CancelFunc
	connectedOnce        sync.Once
}

func TestRealWorldLoadRamp(t *testing.T) {
	if os.Getenv("LOADTEST_RUN") != "1" {
		t.Skip("set LOADTEST_RUN=1 to run load test")
	}
	if testing.Short() {
		t.Skip("skipping load test in -short mode")
	}
	scenario := loadScenarioFromEnv(t)

	cfg := defaultConfig()
	cfg.DBPath = t.TempDir() + "/loadtest.db"
	cfg.AllowCORS = true
	cfg.TrustedLANHTTP = true
	cfg.StaticDir = ""
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	defer srv.store.Close()

	testHTTP := httptest.NewServer(srv.httpSrv.Handler)
	defer testHTTP.Close()
	baseHTTP := testHTTP.URL
	baseWS := "ws" + strings.TrimPrefix(testHTTP.URL, "http")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	monitorClient := &http.Client{Timeout: scenario.ConnectTimeout}
	monitorToken, err := login(ctx, monitorClient, baseHTTP, "loadtest-monitor", "producer")
	if err != nil {
		t.Fatalf("monitor login failed: %v", err)
	}

	metrics := newLoadMetrics()
	var clients []*simulatedClient
	lastTarget := 0
	stageStart := time.Now()

	for stageIndex, stage := range scenario.Stages {
		if stage.TargetClients < lastTarget {
			t.Fatalf("stages must be non-decreasing, stage %d target %d < previous %d", stageIndex+1, stage.TargetClients, lastTarget)
		}

		for len(clients) < stage.TargetClients {
			clientID := len(clients) + 1
			role := scenario.Roles[(clientID-1)%len(scenario.Roles)]
			client := &simulatedClient{
				id:       clientID,
				username: fmt.Sprintf("loadtest-%04d", clientID),
				role:     role,
				baseHTTP: baseHTTP,
				baseWS:   baseWS,
				httpc: &http.Client{
					Timeout: scenario.ConnectTimeout,
				},
				wsDialer: &websocket.Dialer{
					HandshakeTimeout: scenario.ConnectTimeout,
				},
				scenario: scenario,
				metrics:  metrics,
				rng:      rand.New(rand.NewSource(int64(1000 + clientID*77))),
			}
			clients = append(clients, client)
			go client.run(ctx)
			time.Sleep(scenario.RampInterval)
		}

		stageMax, err := monitorStage(ctx, scenario, stage, monitorClient, baseHTTP, monitorToken, scenario.AdminPIN)
		if err != nil {
			t.Fatalf("monitor stage %d failed: %v", stageIndex+1, err)
		}
		lastTarget = stage.TargetClients
		t.Logf(
			"stage %d complete target=%d hold=%s observed hubConnectedMax=%d normalQueueMax=%d priorityQueueMax=%d droppedCritical=%d droppedNormal=%d mediaPeers=%d renegotiations=%d",
			stageIndex+1,
			stage.TargetClients,
			stage.HoldDuration,
			stageMax.hubConnectedClients,
			stageMax.hubNormalQueueMax,
			stageMax.hubPriorityQueueMax,
			stageMax.hubDroppedCritical,
			stageMax.hubDroppedNormal,
			stageMax.mediaPeers,
			stageMax.mediaRenegotiations,
		)
	}

	cancel()
	time.Sleep(350 * time.Millisecond)

	totalDuration := time.Since(stageStart)
	types := metrics.snapshotTypes()

	t.Logf(
		"loadtest summary duration=%s logins_ok=%d login_errors=%d bootstrap_errors=%d ws_connects_ok=%d ws_connect_errors=%d reconnects=%d send_attempts=%d send_dropped_loss=%d send_errors=%d received_messages=%d read_errors=%d simulated_disconnects=%d max_active_clients=%d media_offers=%d media_answers_sent=%d media_ice_recv=%d media_ice_sent=%d media_peers_connected=%d media_rtp_sent=%d media_rtp_dropped=%d media_rtp_recv=%d",
		totalDuration,
		metrics.loginsOK.Load(),
		metrics.loginErrors.Load(),
		metrics.bootstrapErrors.Load(),
		metrics.wsConnectsOK.Load(),
		metrics.wsConnectErrors.Load(),
		metrics.reconnects.Load(),
		metrics.sendAttempts.Load(),
		metrics.sendDroppedByLoss.Load(),
		metrics.sendErrors.Load(),
		metrics.receivedMessages.Load(),
		metrics.readErrors.Load(),
		metrics.simulatedDisconnects.Load(),
		metrics.maxActiveClients.Load(),
		metrics.mediaOffersReceived.Load(),
		metrics.mediaAnswersSent.Load(),
		metrics.mediaICEReceived.Load(),
		metrics.mediaICESent.Load(),
		metrics.mediaPeersConnected.Load(),
		metrics.mediaRTPSent.Load(),
		metrics.mediaRTPDropped.Load(),
		metrics.mediaRTPReceived.Load(),
	)
	t.Logf("received message type counts: %+v", types)

	if len(clients) == 0 {
		t.Fatal("expected at least one simulated client")
	}
	if metrics.wsConnectsOK.Load() == 0 {
		t.Fatal("no websocket connections succeeded")
	}
	if metrics.sendAttempts.Load() == 0 {
		t.Fatal("no events were sent")
	}
	if metrics.receivedMessages.Load() == 0 {
		t.Fatal("no websocket messages were received by clients")
	}
	if metrics.mediaOffersReceived.Load() == 0 {
		t.Fatal("no webrtc offers were received")
	}
	if metrics.mediaAnswersSent.Load() == 0 {
		t.Fatal("no webrtc answers were sent")
	}
	if metrics.mediaRTPSent.Load() == 0 {
		t.Fatal("no RTP packets were sent")
	}

	lastStageTarget := scenario.Stages[len(scenario.Stages)-1].TargetClients
	minExpectedActive := int64(lastStageTarget / 2)
	if minExpectedActive < 1 {
		minExpectedActive = 1
	}
	if metrics.maxActiveClients.Load() < minExpectedActive {
		t.Fatalf("max active clients too low: got %d want at least %d", metrics.maxActiveClients.Load(), minExpectedActive)
	}
}

func monitorStage(ctx context.Context, scenario loadScenario, stage loadStage, monitorClient *http.Client, baseHTTP, monitorToken, adminPIN string) (stageObservedMax, error) {
	deadline := time.Now().Add(stage.HoldDuration)
	ticker := time.NewTicker(scenario.MonitorInterval)
	defer ticker.Stop()

	var max stageObservedMax
	for {
		if time.Now().After(deadline) {
			return max, nil
		}
		select {
		case <-ctx.Done():
			return max, ctx.Err()
		case <-ticker.C:
			stats, err := realtimeStats(ctx, monitorClient, baseHTTP, monitorToken, adminPIN)
			if err != nil {
				continue
			}
			if stats.Hub.ConnectedClients > max.hubConnectedClients {
				max.hubConnectedClients = stats.Hub.ConnectedClients
			}
			if stats.Hub.NormalQueueDepthMax > max.hubNormalQueueMax {
				max.hubNormalQueueMax = stats.Hub.NormalQueueDepthMax
			}
			if stats.Hub.PriorityQueueDepthMax > max.hubPriorityQueueMax {
				max.hubPriorityQueueMax = stats.Hub.PriorityQueueDepthMax
			}
			if stats.Hub.DroppedCriticalMessages > max.hubDroppedCritical {
				max.hubDroppedCritical = stats.Hub.DroppedCriticalMessages
			}
			if stats.Hub.DroppedNormalMessages > max.hubDroppedNormal {
				max.hubDroppedNormal = stats.Hub.DroppedNormalMessages
			}
			if stats.Media.Peers > max.mediaPeers {
				max.mediaPeers = stats.Media.Peers
			}
			if stats.Media.Renegotiations > max.mediaRenegotiations {
				max.mediaRenegotiations = stats.Media.Renegotiations
			}
		}
	}
}

func (c *simulatedClient) run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := c.sleepWithNetwork(ctx, 0); err != nil {
			return
		}
		token, err := login(ctx, c.httpc, c.baseHTTP, c.username, c.role)
		if err != nil {
			c.metrics.loginErrors.Add(1)
			c.sleepWithNetwork(context.Background(), 450*time.Millisecond)
			continue
		}
		c.metrics.loginsOK.Add(1)

		rooms, groups, err := bootstrap(ctx, c.httpc, c.baseHTTP, token)
		if err != nil {
			c.metrics.bootstrapErrors.Add(1)
			c.sleepWithNetwork(context.Background(), 450*time.Millisecond)
			continue
		}

		wsURL := c.baseWS + "/ws?token=" + token
		conn, _, err := c.wsDialer.DialContext(ctx, wsURL, nil)
		if err != nil {
			c.metrics.wsConnectErrors.Add(1)
			c.sleepWithNetwork(context.Background(), 500*time.Millisecond)
			continue
		}
		c.metrics.wsConnectsOK.Add(1)
		c.metrics.incActive(1)

		runErr := c.runSession(ctx, conn, rooms, groups)
		_ = conn.Close()
		c.metrics.incActive(-1)

		if ctx.Err() != nil {
			return
		}
		if errors.Is(runErr, errSimulatedDisconnect) {
			c.metrics.simulatedDisconnects.Add(1)
		} else if runErr != nil && !isExpectedCloseErr(runErr) {
			c.metrics.readErrors.Add(1)
		}
		c.metrics.reconnects.Add(1)
		c.sleepWithNetwork(context.Background(), 250*time.Millisecond)
	}
}

func (c *simulatedClient) runSession(ctx context.Context, conn *websocket.Conn, roomIDs []string, groups []string) error {
	if len(roomIDs) == 0 {
		roomIDs = []string{"foh"}
	}

	writeMu := &sync.Mutex{}
	msgCh := make(chan wsEnvelope, 512)
	readErrCh := make(chan error, 1)
	go c.readLoop(conn, msgCh, readErrCh)

	var media *mediaSession
	cleanupMedia := func() {
		if media == nil {
			return
		}
		if media.cancelAudio != nil {
			media.cancelAudio()
		}
		_ = media.pc.Close()
		media = nil
	}
	defer cleanupMedia()

	matrix := RoomMatrixEvent{
		ListenRoomIDs: []string{roomIDs[0]},
		TalkRoomIDs:   []string{roomIDs[0]},
	}
	if err := c.sendInbound(ctx, conn, writeMu, WSInbound{Type: "set_room_matrix", Data: matrix}); err != nil {
		return err
	}
	if err := c.sendInbound(ctx, conn, writeMu, WSInbound{Type: "webrtc_ready"}); err != nil {
		return err
	}

	actionTicker := time.NewTicker(c.scenario.ActionInterval)
	defer actionTicker.Stop()

	matrixTicker := time.NewTicker(c.scenario.ActionInterval * 8)
	defer matrixTicker.Stop()

	broadcastActive := false

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErrCh:
			return err
		case out := <-msgCh:
			switch out.Type {
			case "webrtc_offer":
				var offer WebRTCOffer
				if err := json.Unmarshal(out.Data, &offer); err != nil {
					continue
				}
				c.metrics.mediaOffersReceived.Add(1)
				if media == nil {
					mediaCandidate, err := c.newMediaSession(ctx, conn, writeMu)
					if err != nil {
						return err
					}
					media = mediaCandidate
				}
				if err := c.handleWebRTCOffer(ctx, conn, writeMu, media, offer); err != nil {
					return err
				}
			case "webrtc_ice_candidate":
				var ice WebRTCIceCandidate
				if err := json.Unmarshal(out.Data, &ice); err != nil {
					continue
				}
				c.metrics.mediaICEReceived.Add(1)
				if media == nil {
					mediaCandidate, err := c.newMediaSession(ctx, conn, writeMu)
					if err != nil {
						return err
					}
					media = mediaCandidate
				}
				if err := c.handleRemoteICECandidate(media, ice); err != nil {
					return err
				}
			}
		case <-actionTicker.C:
			if c.shouldDisconnectThisTick() {
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "simulated-network"), time.Now().Add(2*time.Second))
				return errSimulatedDisconnect
			}
			event := c.randomRealtimeEvent(roomIDs, groups, &broadcastActive)
			if err := c.sendInbound(ctx, conn, writeMu, event); err != nil {
				return err
			}
		case <-matrixTicker.C:
			updated := c.randomRoomMatrix(roomIDs)
			if err := c.sendInbound(ctx, conn, writeMu, WSInbound{Type: "set_room_matrix", Data: updated}); err != nil {
				return err
			}
		}
	}
}

func (c *simulatedClient) readLoop(conn *websocket.Conn, msgCh chan<- wsEnvelope, errCh chan<- error) {
	for {
		if c.scenario.Network.SlowReceiverReadDelay > 0 {
			time.Sleep(c.scenario.Network.SlowReceiverReadDelay)
		}
		conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		_, payload, err := conn.ReadMessage()
		if err != nil {
			errCh <- err
			return
		}
		var envelope wsEnvelope
		if err := json.Unmarshal(payload, &envelope); err != nil {
			c.metrics.recordReceivedType("unknown")
			c.metrics.receivedMessages.Add(1)
			continue
		}
		c.metrics.recordReceivedType(envelope.Type)
		c.metrics.receivedMessages.Add(1)

		select {
		case msgCh <- envelope:
		default:
			if envelope.Type == "webrtc_offer" || envelope.Type == "webrtc_ice_candidate" {
				msgCh <- envelope
			}
		}
	}
}

func (c *simulatedClient) newMediaSession(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex) (*mediaSession, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: 48000,
			Channels:  2,
		},
		fmt.Sprintf("audio-%d", c.id),
		"loadtest",
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

	session := &mediaSession{
		pc:         pc,
		localTrack: track,
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			session.connectedOnce.Do(func() {
				c.metrics.mediaPeersConnected.Add(1)
			})
		}
	})
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		init := candidate.ToJSON()
		msg := WebRTCIceCandidate{
			Candidate: init.Candidate,
		}
		if init.SDPMid != nil {
			msg.SDPMid = *init.SDPMid
		}
		if init.SDPMLineIndex != nil {
			msg.SDPMLineIndex = *init.SDPMLineIndex
		}
		c.metrics.mediaICESent.Add(1)
		_ = c.sendInbound(ctx, conn, writeMu, WSInbound{
			Type: "webrtc_ice_candidate",
			Data: msg,
		})
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				_, _, readErr := remote.ReadRTP()
				if readErr != nil {
					return
				}
				c.metrics.mediaRTPReceived.Add(1)
			}
		}()
	})

	audioCtx, cancelAudio := context.WithCancel(ctx)
	session.cancelAudio = cancelAudio
	go c.produceAudioRTP(audioCtx, track)

	return session, nil
}

func (c *simulatedClient) handleWebRTCOffer(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, media *mediaSession, offer WebRTCOffer) error {
	if err := media.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offer.SDP,
	}); err != nil {
		return err
	}
	media.remoteDescriptionSet = true

	for _, candidate := range media.pendingRemoteICE {
		if err := media.pc.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	media.pendingRemoteICE = nil

	answer, err := media.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := media.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	if err := c.sendInbound(ctx, conn, writeMu, WSInbound{
		Type: "webrtc_answer",
		Data: WebRTCAnswer{SDP: answer.SDP},
	}); err != nil {
		return err
	}
	c.metrics.mediaAnswersSent.Add(1)
	return nil
}

func (c *simulatedClient) handleRemoteICECandidate(media *mediaSession, candidate WebRTCIceCandidate) error {
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
	if !media.remoteDescriptionSet {
		media.pendingRemoteICE = append(media.pendingRemoteICE, init)
		return nil
	}
	return media.pc.AddICECandidate(init)
}

func (c *simulatedClient) produceAudioRTP(ctx context.Context, track *webrtc.TrackLocalStaticRTP) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	seq := uint16(c.randIntn(65535))
	ts := uint32(c.randIntn(1 << 30))
	ssrc := uint32(1000 + c.id)
	basePayload := make([]byte, 96)
	for i := range basePayload {
		basePayload[i] = byte((c.id + i) % 251)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if c.randFloat64() < c.scenario.Network.MediaPacketLoss {
				c.metrics.mediaRTPDropped.Add(1)
				seq++
				ts += 960
				continue
			}
			if c.scenario.Network.Jitter > 0 {
				sleep := time.Duration(c.randInt63n(int64(c.scenario.Network.Jitter / 3)))
				if sleep > 0 {
					timer := time.NewTimer(sleep)
					select {
					case <-ctx.Done():
						timer.Stop()
						return
					case <-timer.C:
					}
				}
			}
			if c.scenario.Network.SpikeChance > 0 && c.randFloat64() < c.scenario.Network.SpikeChance/4 {
				timer := time.NewTimer(c.scenario.Network.SpikeLatency / 2)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}

			payload := append([]byte(nil), basePayload...)
			payload[0] = byte(seq)
			packet := &rtp.Packet{
				Header: rtp.Header{
					Version:        2,
					PayloadType:    111,
					SequenceNumber: seq,
					Timestamp:      ts,
					SSRC:           ssrc,
				},
				Payload: payload,
			}
			if err := track.WriteRTP(packet); err != nil {
				return
			}
			c.metrics.mediaRTPSent.Add(1)
			seq++
			ts += 960
		}
	}
}

func (c *simulatedClient) randomRealtimeEvent(roomIDs []string, groupIDs []string, broadcastActive *bool) WSInbound {
	roll := c.randFloat64()
	if roll < 0.40 {
		roomID := roomIDs[c.randIntn(len(roomIDs))]
		return WSInbound{
			Type: "chat",
			Data: RoutedEvent{
				Scope:    "room",
				TargetID: roomID,
				Body:     fmt.Sprintf("loadtest-message-%d", time.Now().UnixNano()),
			},
		}
	}
	if roll < 0.70 {
		roomID := roomIDs[c.randIntn(len(roomIDs))]
		signal := "attention"
		if c.randFloat64() < 0.35 {
			signal = "call"
		}
		return WSInbound{
			Type: "signal",
			Data: RoutedEvent{
				Scope:    "room",
				TargetID: roomID,
				Signal:   signal,
			},
		}
	}
	if len(groupIDs) > 0 {
		groupID := groupIDs[c.randIntn(len(groupIDs))]
		body := "ptt_start"
		if *broadcastActive {
			body = "ptt_stop"
		}
		*broadcastActive = !*broadcastActive
		return WSInbound{
			Type: "voice_state",
			Data: RoutedEvent{
				Scope:    "broadcast",
				TargetID: groupID,
				Body:     body,
			},
		}
	}
	roomID := roomIDs[c.randIntn(len(roomIDs))]
	body := "ptt_start"
	if c.randFloat64() < 0.5 {
		body = "ptt_stop"
	}
	return WSInbound{
		Type: "voice_state",
		Data: RoutedEvent{
			Scope:    "room",
			TargetID: roomID,
			Body:     body,
		},
	}
}

func (c *simulatedClient) randomRoomMatrix(roomIDs []string) RoomMatrixEvent {
	if len(roomIDs) == 0 {
		return RoomMatrixEvent{}
	}
	listen := pickSubset(c.randIntn, roomIDs, 1, min(3, len(roomIDs)))
	talk := pickSubset(c.randIntn, roomIDs, 1, min(2, len(roomIDs)))
	return RoomMatrixEvent{
		ListenRoomIDs: listen,
		TalkRoomIDs:   talk,
	}
}

func (c *simulatedClient) sendInbound(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, in WSInbound) error {
	payload, err := json.Marshal(in)
	if err != nil {
		return err
	}
	c.metrics.sendAttempts.Add(1)
	if !isWebRTCSignalingType(in.Type) && c.randFloat64() < c.scenario.Network.PacketLoss {
		c.metrics.sendDroppedByLoss.Add(1)
		return nil
	}
	if err := c.sleepWithNetwork(ctx, time.Duration(len(payload))*100*time.Microsecond); err != nil {
		return err
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	conn.SetWriteDeadline(time.Now().Add(c.scenario.ConnectTimeout))
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		c.metrics.sendErrors.Add(1)
		return err
	}
	return nil
}

func isWebRTCSignalingType(messageType string) bool {
	switch messageType {
	case "webrtc_answer", "webrtc_ice_candidate", "webrtc_ready":
		return true
	default:
		return false
	}
}

func (c *simulatedClient) shouldDisconnectThisTick() bool {
	if c.scenario.Network.DisconnectsPerMinute <= 0 {
		return false
	}
	chance := c.scenario.Network.DisconnectsPerMinute * (c.scenario.ActionInterval.Seconds() / 60.0)
	return c.randFloat64() < chance
}

func (c *simulatedClient) sleepWithNetwork(ctx context.Context, extra time.Duration) error {
	delay := c.scenario.Network.BaseLatency + extra
	if c.scenario.Network.Jitter > 0 {
		delay += time.Duration(c.randInt63n(int64(c.scenario.Network.Jitter)))
	}
	if c.scenario.Network.SpikeChance > 0 && c.randFloat64() < c.scenario.Network.SpikeChance {
		delay += c.scenario.Network.SpikeLatency
	}
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *simulatedClient) randFloat64() float64 {
	c.rngMu.Lock()
	defer c.rngMu.Unlock()
	return c.rng.Float64()
}

func (c *simulatedClient) randIntn(n int) int {
	c.rngMu.Lock()
	defer c.rngMu.Unlock()
	return c.rng.Intn(n)
}

func (c *simulatedClient) randInt63n(n int64) int64 {
	c.rngMu.Lock()
	defer c.rngMu.Unlock()
	return c.rng.Int63n(n)
}

func login(ctx context.Context, client *http.Client, baseHTTP, username, role string) (string, error) {
	body, _ := json.Marshal(LoginRequest{
		Username: username,
		RoleID:   role,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseHTTP+"/api/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("login status=%d body=%s", resp.StatusCode, string(b))
	}
	var out LoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", errors.New("empty login token")
	}
	return out.Token, nil
}

func bootstrap(ctx context.Context, client *http.Client, baseHTTP, token string) ([]string, []string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseHTTP+"/api/bootstrap", nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, nil, fmt.Errorf("bootstrap status=%d body=%s", resp.StatusCode, string(b))
	}
	var out BootstrapResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, nil, err
	}
	roomIDs := make([]string, 0, len(out.Rooms))
	for _, room := range out.Rooms {
		roomIDs = append(roomIDs, room.ID)
	}
	groupIDs := make([]string, 0, len(out.BroadcastGroups))
	for _, group := range out.BroadcastGroups {
		groupIDs = append(groupIDs, group.ID)
	}
	return roomIDs, groupIDs, nil
}

func realtimeStats(ctx context.Context, client *http.Client, baseHTTP, token, adminPIN string) (RealtimeStatsResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseHTTP+"/api/realtime-stats", nil)
	if err != nil {
		return RealtimeStatsResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Admin-Pin", adminPIN)
	resp, err := client.Do(req)
	if err != nil {
		return RealtimeStatsResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return RealtimeStatsResponse{}, fmt.Errorf("realtime stats status=%d body=%s", resp.StatusCode, string(b))
	}
	var out RealtimeStatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return RealtimeStatsResponse{}, err
	}
	return out, nil
}

type loadProfileDefaults struct {
	stageClients     []int
	stageHoldSeconds []int
}

func defaultsForLoadProfile(t *testing.T, profile string) loadProfileDefaults {
	t.Helper()
	switch strings.ToLower(strings.TrimSpace(profile)) {
	case "", "default":
		return loadProfileDefaults{
			stageClients:     []int{20, 40, 60},
			stageHoldSeconds: []int{20, 30, 40},
		}
	case "20clients", "small20":
		return loadProfileDefaults{
			stageClients:     []int{10, 15, 20},
			stageHoldSeconds: []int{15, 20, 25},
		}
	default:
		t.Fatalf("unknown LOADTEST_PROFILE %q (supported: default, 20clients)", profile)
		return loadProfileDefaults{}
	}
}

func loadScenarioFromEnv(t *testing.T) loadScenario {
	t.Helper()
	profile := envString("LOADTEST_PROFILE", "default")
	defaults := defaultsForLoadProfile(t, profile)
	stageClients := parseIntListWithDefault(t, "LOADTEST_STAGE_CLIENTS", defaults.stageClients)
	stageHoldsSeconds := parseIntListWithDefault(t, "LOADTEST_STAGE_HOLD_SECONDS", defaults.stageHoldSeconds)
	if len(stageClients) != len(stageHoldsSeconds) {
		t.Fatalf("LOADTEST_STAGE_CLIENTS and LOADTEST_STAGE_HOLD_SECONDS length mismatch (%d != %d)", len(stageClients), len(stageHoldsSeconds))
	}
	stages := make([]loadStage, 0, len(stageClients))
	for i := range stageClients {
		if stageClients[i] <= 0 || stageHoldsSeconds[i] <= 0 {
			t.Fatalf("invalid stage values at index %d: clients=%d holdSeconds=%d", i, stageClients[i], stageHoldsSeconds[i])
		}
		stages = append(stages, loadStage{
			TargetClients: stageClients[i],
			HoldDuration:  time.Duration(stageHoldsSeconds[i]) * time.Second,
		})
	}

	roles := parseStringListWithDefault("LOADTEST_ROLES", []string{"audio", "video", "lighting", "broadcast", "camera", "pastor", "producer"})
	if len(roles) == 0 {
		roles = []string{"audio"}
	}

	controlLoss := envFloat("LOADTEST_NET_PACKET_LOSS", 0.03)
	mediaLoss := envFloat("LOADTEST_NET_MEDIA_PACKET_LOSS", controlLoss)

	return loadScenario{
		Stages:          stages,
		RampInterval:    time.Duration(envInt("LOADTEST_RAMP_INTERVAL_MS", 300)) * time.Millisecond,
		ActionInterval:  time.Duration(envInt("LOADTEST_ACTION_INTERVAL_MS", 900)) * time.Millisecond,
		MonitorInterval: time.Duration(envInt("LOADTEST_MONITOR_INTERVAL_MS", 2000)) * time.Millisecond,
		ConnectTimeout:  time.Duration(envInt("LOADTEST_CONNECT_TIMEOUT_MS", 9000)) * time.Millisecond,
		AdminPIN:        envString("LOADTEST_ADMIN_PIN", defaultAdminPIN),
		Roles:           roles,
		Network: loadNetworkProfile{
			BaseLatency:           time.Duration(envInt("LOADTEST_NET_BASE_LATENCY_MS", 35)) * time.Millisecond,
			Jitter:                time.Duration(envInt("LOADTEST_NET_JITTER_MS", 25)) * time.Millisecond,
			SpikeChance:           envFloat("LOADTEST_NET_SPIKE_CHANCE", 0.08),
			SpikeLatency:          time.Duration(envInt("LOADTEST_NET_SPIKE_LATENCY_MS", 180)) * time.Millisecond,
			PacketLoss:            controlLoss,
			MediaPacketLoss:       mediaLoss,
			DisconnectsPerMinute:  envFloat("LOADTEST_NET_DISCONNECTS_PER_MIN", 0.20),
			SlowReceiverReadDelay: time.Duration(envInt("LOADTEST_NET_SLOW_RECEIVER_MS", 35)) * time.Millisecond,
		},
	}
}

func parseIntListWithDefault(t *testing.T, key string, fallback []int) []int {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return append([]int(nil), fallback...)
	}
	parts := strings.Split(raw, ",")
	out := make([]int, 0, len(parts))
	for _, part := range parts {
		v := strings.TrimSpace(part)
		n, err := strconv.Atoi(v)
		if err != nil {
			t.Fatalf("%s has invalid integer value %q: %v", key, v, err)
		}
		out = append(out, n)
	}
	return out
}

func parseStringListWithDefault(key string, fallback []string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return append([]string(nil), fallback...)
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		v := strings.TrimSpace(part)
		if v != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return append([]string(nil), fallback...)
	}
	return out
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

func envFloat(key string, fallback float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return f
}

func envString(key, fallback string) string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	return raw
}

func pickSubset(randIntn func(int) int, values []string, minCount, maxCount int) []string {
	if len(values) == 0 {
		return nil
	}
	if maxCount < minCount {
		maxCount = minCount
	}
	if minCount < 1 {
		minCount = 1
	}
	if maxCount > len(values) {
		maxCount = len(values)
	}
	count := minCount
	if maxCount > minCount {
		count += randIntn(maxCount - minCount + 1)
	}
	selected := make([]string, 0, count)
	used := make(map[int]struct{}, count)
	for len(selected) < count {
		idx := randIntn(len(values))
		if _, ok := used[idx]; ok {
			continue
		}
		used[idx] = struct{}{}
		selected = append(selected, values[idx])
	}
	return selected
}

func isExpectedCloseErr(err error) bool {
	if err == nil {
		return false
	}
	if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "use of closed network connection") ||
		strings.Contains(msg, "websocket: close")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
