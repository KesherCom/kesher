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

func TestHubRoomRoutingRespectsReceiverRoleRestrictions(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{}, []string{"video"}); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{
		session:     Session{Token: "sender", RoleID: "audio"},
		user:        User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:        make(chan WSOutbound, 4),
		activeRoom:  "foh",
		listenRooms: toRoomSet([]string{"foh"}),
	}
	allowedReceiver := &client{
		session:     Session{Token: "allowed", RoleID: "video"},
		user:        User{ID: "u2", Username: "allowed", RoleID: "video"},
		send:        make(chan WSOutbound, 4),
		activeRoom:  "foh",
		listenRooms: toRoomSet([]string{"foh"}),
	}
	blockedReceiver := &client{
		session:     Session{Token: "blocked", RoleID: "lighting"},
		user:        User{ID: "u3", Username: "blocked", RoleID: "lighting"},
		send:        make(chan WSOutbound, 4),
		activeRoom:  "foh",
		listenRooms: toRoomSet([]string{"foh"}),
	}
	hub.Add(sender)
	hub.Add(allowedReceiver)
	hub.Add(blockedReceiver)
	drain(sender.send)
	drain(allowedReceiver.send)
	drain(blockedReceiver.send)

	hub.RouteEvent("sender", "chat", RoutedEvent{Scope: "room", TargetID: "foh", Body: "hello"})

	select {
	case <-allowedReceiver.send:
	default:
		t.Fatal("expected allowed receiver to get room event")
	}
	select {
	case <-blockedReceiver.send:
		t.Fatal("did not expect blocked receiver to get room event")
	default:
	}
	select {
	case <-sender.send:
		t.Fatal("did not expect sender to receive room event when sender role is not in receiver allowlist")
	default:
	}
}

func TestHubBroadcastRoutingFiltersRoomsBySenderRole(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio"}, []string{}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateRoom(context.Background(), "stage", "Stage", []string{"video"}, []string{}); err != nil {
		t.Fatal(err)
	}
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_groups (id,name) VALUES ('split-bg','Split BG')`)
	_, _ = store.db.ExecContext(context.Background(), `DELETE FROM broadcast_group_rooms WHERE broadcast_group_id = 'split-bg'`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('split-bg','foh')`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('split-bg','stage')`)

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	audioSender := &client{
		session:     Session{Token: "sender", RoleID: "audio"},
		user:        User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:        make(chan WSOutbound, 4),
		activeRoom:  "foh",
		listenRooms: toRoomSet([]string{"foh"}),
	}
	fohReceiver := &client{
		session:     Session{Token: "foh", RoleID: "lighting"},
		user:        User{ID: "u2", Username: "foh", RoleID: "lighting"},
		send:        make(chan WSOutbound, 4),
		activeRoom:  "foh",
		listenRooms: toRoomSet([]string{"foh"}),
	}
	stageReceiver := &client{
		session:     Session{Token: "stage", RoleID: "lighting"},
		user:        User{ID: "u3", Username: "stage", RoleID: "lighting"},
		send:        make(chan WSOutbound, 4),
		activeRoom:  "stage",
		listenRooms: toRoomSet([]string{"stage"}),
	}
	hub.Add(audioSender)
	hub.Add(fohReceiver)
	hub.Add(stageReceiver)
	drain(audioSender.send)
	drain(fohReceiver.send)
	drain(stageReceiver.send)

	hub.RouteEvent("sender", "signal", RoutedEvent{Scope: "broadcast", TargetID: "split-bg", Signal: "attention"})

	select {
	case <-fohReceiver.send:
	default:
		t.Fatal("expected receiver in sender-allowed room to get broadcast")
	}
	select {
	case <-stageReceiver.send:
		t.Fatal("did not expect receiver in sender-disallowed room to get broadcast")
	default:
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
