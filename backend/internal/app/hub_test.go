package app

import (
	"context"
	"log/slog"
	"os"
	"testing"
)

func drain(ch chan WSOutbound) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

func TestHubDirectRouting(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	c1 := &client{session: Session{Token: "a"}, user: User{ID: "u1", Username: "a", RoleID: "audio"}, send: make(chan WSOutbound, 2), activeRoom: "foh"}
	c2 := &client{session: Session{Token: "b"}, user: User{ID: "u2", Username: "b", RoleID: "video"}, send: make(chan WSOutbound, 2), activeRoom: "foh"}
	hub.Add(c1)
	hub.Add(c2)
	drain(c1.send)
	drain(c2.send)

	hub.RouteEvent("a", "chat", RoutedEvent{Scope: "direct", TargetID: "u2", Body: "hello"})

	select {
	case got := <-c2.send:
		if got.Type != "chat" {
			t.Fatalf("expected chat, got %s", got.Type)
		}
	default:
		t.Fatal("expected routed chat for target user")
	}
}

func TestHubBroadcastRouting(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	c1 := &client{session: Session{Token: "a"}, user: User{ID: "u1", Username: "a", RoleID: "audio"}, send: make(chan WSOutbound, 2), activeRoom: "foh"}
	c2 := &client{session: Session{Token: "b"}, user: User{ID: "u2", Username: "b", RoleID: "video"}, send: make(chan WSOutbound, 2), activeRoom: "stage"}
	hub.Add(c1)
	hub.Add(c2)
	drain(c1.send)
	drain(c2.send)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_groups (id,name) VALUES ('test-bg','Test BG')`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('test-bg','foh')`)
	hub.RouteEvent("a", "signal", RoutedEvent{Scope: "broadcast", TargetID: "test-bg", Signal: "attention"})
	select {
	case got := <-c1.send:
		if got.Type != "signal" {
			t.Fatalf("expected signal, got %s", got.Type)
		}
	default:
		t.Fatal("expected sender room to receive broadcast")
	}
	select {
	case got := <-c2.send:
		if got.Type == "signal" {
			t.Fatal("did not expect room outside broadcast group to receive broadcast")
		}
	default:
	}
}
