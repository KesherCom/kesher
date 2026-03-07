package app

import (
	"io"
	"log/slog"
	"testing"
)

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
