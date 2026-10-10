package app

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

func newChatRoutingServer(t *testing.T) (*Server, Session) {
	t.Helper()
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ctx := context.Background()
	if err := store.CreateRole(ctx, "sound", "Sound", "", "ptt", false); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateRole(ctx, "stage-crew", "Stage Crew", "", "ptt", false); err != nil {
		t.Fatal(err)
	}
	// The seed already has the party line "Lighting Booth" (lighting-booth).
	if err := store.CreateRoom(ctx, "light", "Lighting", []string{"sound"}, []string{"sound"}, nil); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	sender := &client{
		session: Session{Token: "sender", UserID: "u1", RoleID: "sound", Username: "sender"},
		user:    User{ID: "u1", Username: "sender", RoleID: "sound"},
		send:    make(chan WSOutbound, 8),
	}
	crew := &client{
		session: Session{Token: "crew", UserID: "u2", RoleID: "stage-crew", Username: "Tim"},
		user:    User{ID: "u2", Username: "Tim", RoleID: "stage-crew"},
		send:    make(chan WSOutbound, 8),
	}
	hub.Add(sender)
	hub.Add(crew)
	return &Server{store: store, hub: hub}, sender.session
}

func TestChatRoutingMatchesNamesWithSpaces(t *testing.T) {
	s, sender := newChatRoutingServer(t)
	ctx := context.Background()

	e, status, ok := s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "#Lighting Booth focus on stage"})
	if !ok || status != nil || e.TargetID != "lighting-booth" || e.Body != "focus on stage" {
		t.Fatalf("room with a space: got %+v / %+v", e, status)
	}
	e, _, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "#lighting go"})
	if !ok || e.TargetID != "light" {
		t.Fatalf("shorter room name: got %+v", e)
	}
	e, _, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "@Tim camera 2 please"})
	if !ok || e.Scope != "direct" || e.TargetType != "user" || e.TargetID != "u2" || e.Body != "camera 2 please" {
		t.Fatalf("person: got %+v", e)
	}
	e, _, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "@Stage Crew doors open"})
	if !ok || e.TargetType != "role" || e.TargetID != "stage-crew" {
		t.Fatalf("role with a space: got %+v", e)
	}
	_, status, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "#Nowhere hello"})
	if ok || status == nil || status.Code != "not_delivered" || status.Message != "Not delivered: party line not found." {
		t.Fatalf("unknown room: got %+v", status)
	}
}

func TestChatRoutingUsesTheChosenRecipient(t *testing.T) {
	s, sender := newChatRoutingServer(t)
	ctx := context.Background()

	e, _, ok := s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "hello", TargetType: "room", TargetID: "lighting-booth"})
	if !ok || e.Scope != "room" || e.TargetID != "lighting-booth" {
		t.Fatalf("chosen room: got %+v", e)
	}
	e, _, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "hello", Scope: "direct", TargetType: "role", TargetID: "stage-crew"})
	if !ok || e.Scope != "direct" || e.TargetType != "role" {
		t.Fatalf("chosen role: got %+v", e)
	}
	if _, err := s.store.UpsertUser(ctx, "Tim", "stage-crew"); err != nil {
		t.Fatal(err)
	}
	tim, err := s.store.FindUserByUsername(ctx, "Tim")
	if err != nil {
		t.Fatal(err)
	}
	e, _, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "hello", TargetType: "user", TargetID: tim.ID})
	if !ok || e.Scope != "direct" || e.TargetType != "user" || e.TargetID != tim.ID {
		t.Fatalf("chosen person: got %+v", e)
	}
	_, status, ok := s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "hello", TargetType: "user", TargetID: sender.UserID})
	if ok || status == nil || status.Message != "Not delivered: you cannot write to yourself." {
		t.Fatalf("writing to yourself: got %+v", status)
	}
	// A typed prefix still wins over the chosen recipient.
	e, _, ok = s.resolveChatRouting(ctx, sender, RoutedEvent{Body: "#Lighting now", TargetType: "role", TargetID: "stage-crew"})
	if !ok || e.TargetID != "light" {
		t.Fatalf("prefix over chosen recipient: got %+v", e)
	}
}

func TestRoomChatReachesASenderWhoDoesNotListen(t *testing.T) {
	s, sender := newChatRoutingServer(t)
	s.hub.mu.RLock()
	c := s.hub.clients[sender.Token]
	s.hub.mu.RUnlock()
	drain(c.send)

	s.hub.RouteEvent(sender.Token, "chat", RoutedEvent{Scope: "room", TargetType: "room", TargetID: "light", Body: "spot 3"})

	select {
	case out := <-c.send:
		if routed, ok := out.Data.(RoutedEvent); !ok || routed.Body != "spot 3" {
			t.Fatalf("unexpected echo: %+v", out)
		}
	default:
		t.Fatal("expected the sender to get their own message")
	}
}
