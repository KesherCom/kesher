package app

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestMediaManagerWaitsForClientReadinessBeforeOffer(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	media := NewMediaManager(hub, logger)
	receiver := &client{
		session: Session{Token: "receiver", RoleID: "audio"},
		user:    User{ID: "u2", Username: "receiver", RoleID: "audio"},
		send:    make(chan WSOutbound, 8),
	}
	hub.Add(receiver)
	for {
		select {
		case <-receiver.send:
		default:
			goto receiverChannelDrained
		}
	}

receiverChannelDrained:

	if err := media.EnsurePeer("receiver", receiver.user); err != nil {
		t.Fatal(err)
	}

	peer := media.peers["receiver"]
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio-user-source",
		"intercom",
	)
	if err != nil {
		t.Fatal(err)
	}
	sender, err := peer.pc.AddTrack(localTrack)
	if err != nil {
		t.Fatal(err)
	}
	peer.senders["source"] = sender
	media.requestRenegotiationLocked(peer)

	select {
	case msg := <-receiver.send:
		t.Fatalf("unexpected offer before readiness: %#v", msg)
	case <-time.After(25 * time.Millisecond):
	}

	media.EnsureNegotiation("receiver")

	select {
	case msg := <-receiver.send:
		if msg.Type != "webrtc_offer" {
			t.Fatalf("expected webrtc_offer after readiness, got %q", msg.Type)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for webrtc_offer after readiness")
	}

	media.RemovePeer("receiver")
	hub.Remove("receiver")
}

func TestMediaManagerSuppressesIdleRoomFallbackAfterDirectRelease(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	media := NewMediaManager(hub, logger)
	source := &client{
		session: Session{Token: "source", RoleID: "audio"},
		user:    User{ID: "u1", Username: "source", RoleID: "audio"},
		send:    make(chan WSOutbound, 2),
	}
	hub.Add(source)
	hub.SetVoiceState("source", "ptt_stop")

	media.SetDirectTargetActive("source", "u2", true)
	media.SetDirectTargetActive("source", "u2", false)

	if _, ok := media.idleRoomFallbackSuppressed["source"]; !ok {
		t.Fatal("expected idle room fallback to be suppressed after direct release while mic is idle")
	}
}

func TestMediaManagerKeepsIdleRoomFallbackWhenMicStillEnabled(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	media := NewMediaManager(hub, logger)
	source := &client{
		session: Session{Token: "source", RoleID: "audio"},
		user:    User{ID: "u1", Username: "source", RoleID: "audio"},
		send:    make(chan WSOutbound, 2),
	}
	hub.Add(source)
	hub.SetVoiceState("source", "always_on")

	media.SetDirectTargetActive("source", "u2", true)
	media.SetDirectTargetActive("source", "u2", false)

	if _, ok := media.idleRoomFallbackSuppressed["source"]; ok {
		t.Fatal("did not expect idle room fallback suppression while mic stays enabled")
	}
}

func TestMediaManagerCanClearIdleRoomFallbackSuppression(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	media := NewMediaManager(hub, logger)

	media.idleRoomFallbackSuppressed["source"] = struct{}{}
	media.SetIdleRoomFallbackSuppressed("source", false)

	if _, ok := media.idleRoomFallbackSuppressed["source"]; ok {
		t.Fatal("expected idle room fallback suppression to be cleared")
	}
}
