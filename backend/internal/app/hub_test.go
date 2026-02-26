package app

import (
	"context"
	"log/slog"
	"os"
	"reflect"
	"testing"
	"time"
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

func TestHubDirectPTTUpdatesReplyTargetForLatestConnection(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{session: Session{Token: "sender"}, user: User{ID: "u1", Username: "sender", RoleID: "audio"}, send: make(chan WSOutbound, 4)}
	oldConn := &client{session: Session{Token: "old"}, user: User{ID: "u2", Username: "target", RoleID: "video"}, send: make(chan WSOutbound, 4)}
	newConn := &client{session: Session{Token: "new"}, user: User{ID: "u2", Username: "target", RoleID: "video"}, send: make(chan WSOutbound, 4)}
	hub.Add(sender)
	hub.Add(oldConn)
	time.Sleep(2 * time.Millisecond)
	hub.Add(newConn)
	drain(sender.send)
	drain(oldConn.send)
	drain(newConn.send)

	hub.RouteEvent("sender", "voice_state", RoutedEvent{Scope: "direct", TargetID: "u2", Body: "ptt_start"})

	replyUserID, replyUsername, ok := hub.ReplyTargetForUsername("target")
	if !ok {
		t.Fatal("expected reply target to exist")
	}
	if replyUserID != "u1" || replyUsername != "sender" {
		t.Fatalf("unexpected reply target: (%s, %s)", replyUserID, replyUsername)
	}
}

func TestHubSignalStateForUsernameExpires(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{session: Session{Token: "sender"}, user: User{ID: "u1", Username: "sender", RoleID: "audio"}, send: make(chan WSOutbound, 4)}
	target := &client{session: Session{Token: "target"}, user: User{ID: "u2", Username: "target", RoleID: "video"}, send: make(chan WSOutbound, 4)}
	hub.Add(sender)
	hub.Add(target)

	hub.markDirectSignalIncoming("u2", sender.user, "call")
	from, message, active := hub.SignalStateForUsername("target")
	if !active {
		t.Fatal("expected active signal state")
	}
	if from != "sender" || message != "call" {
		t.Fatalf("unexpected signal state: from=%q message=%q", from, message)
	}

	hub.mu.Lock()
	target.signalUntil = time.Now().Add(-time.Second)
	hub.mu.Unlock()
	if _, _, ok := hub.SignalStateForUsername("target"); ok {
		t.Fatal("expected expired signal state to be inactive")
	}
}

func TestHubSetVoiceStateTransitions(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	c := &client{session: Session{Token: "a"}, user: User{ID: "u1", Username: "a", RoleID: "audio"}, send: make(chan WSOutbound, 4)}
	hub.Add(c)

	hub.SetVoiceState("a", "always_on")
	presence, ok := hub.PresenceForUsername("a")
	if !ok || presence.VoiceMode != "always_on" || !presence.MicEnabled {
		t.Fatalf("unexpected always_on presence: %+v", presence)
	}
	hub.SetVoiceState("a", "ptt_stop")
	presence, ok = hub.PresenceForUsername("a")
	if !ok || presence.VoiceMode != "ptt" || presence.MicEnabled {
		t.Fatalf("unexpected ptt_stop presence: %+v", presence)
	}
}

func TestHubRoomSelectionsReturnsSortedValues(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	c := &client{
		session: Session{Token: "t1"},
		user:    User{ID: "u1", Username: "user", RoleID: "audio"},
		send:    make(chan WSOutbound, 4),
	}
	hub.Add(c)
	hub.SetRoomMatrix("t1", []string{"stage", "foh"}, []string{"video-control", "foh"})

	listen, talk := hub.roomSelections("t1")
	if !reflect.DeepEqual(listen, []string{"foh", "stage"}) {
		t.Fatalf("unexpected listen room selection: %v", listen)
	}
	if !reflect.DeepEqual(talk, []string{"foh", "video-control"}) {
		t.Fatalf("unexpected talk room selection: %v", talk)
	}
}

func TestHubSubscribeChatReceivesRoutedChatEvents(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{
		session:     Session{Token: "s1", RoleID: "audio"},
		user:        User{ID: "u1", Username: "alice", RoleID: "audio"},
		send:        make(chan WSOutbound, 4),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	hub.Add(sender)
	drain(sender.send)

	chatCh, unsubscribe := hub.SubscribeChat()
	defer unsubscribe()

	hub.RouteEvent("s1", "chat", RoutedEvent{Scope: "direct", TargetID: "u1", Body: "hello"})

	select {
	case e := <-chatCh:
		if e.Body != "hello" {
			t.Fatalf("unexpected chat body: %q", e.Body)
		}
		if e.FromUser.Username != "alice" {
			t.Fatalf("unexpected fromUser: %q", e.FromUser.Username)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for chat event on subscriber channel")
	}
}

func TestHubSubscribeChatDoesNotReceiveNonChatEvents(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{
		session: Session{Token: "s1", RoleID: "audio"},
		user:    User{ID: "u1", Username: "alice", RoleID: "audio"},
		send:    make(chan WSOutbound, 4),
	}
	hub.Add(sender)
	drain(sender.send)

	chatCh, unsubscribe := hub.SubscribeChat()
	defer unsubscribe()

	hub.RouteEvent("s1", "signal", RoutedEvent{Scope: "direct", TargetID: "u1", Signal: "call"})

	select {
	case <-chatCh:
		t.Fatal("did not expect non-chat event to appear on chat subscriber channel")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestHubBroadcastChatToRoomDeliveresToListeners(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	listener := &client{
		session:     Session{Token: "l1", RoleID: "audio"},
		user:        User{ID: "u1", Username: "bob", RoleID: "audio"},
		send:        make(chan WSOutbound, 4),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	hub.Add(listener)
	drain(listener.send)

	hub.BroadcastChatToRoom("foh", User{Username: "telegram-bot"}, "[TG:charlie] hi")

	select {
	case msg := <-listener.send:
		if msg.Type != "chat" {
			t.Fatalf("expected chat type, got %q", msg.Type)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for BroadcastChatToRoom delivery")
	}
}

func TestParseTelegramRoomMap(t *testing.T) {
	cases := []struct {
		input string
		want  []TelegramRoomMapping
	}{
		{
			input: "room1:123,room2:-100456",
			want: []TelegramRoomMapping{
				{RoomID: "room1", ChatID: "123"},
				{RoomID: "room2", ChatID: "-100456"},
			},
		},
		{input: "  ", want: nil},
		{input: "nocolon", want: nil},
		{input: ":onlychat", want: nil},
	}
	for _, tc := range cases {
		got := ParseTelegramRoomMap(tc.input)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("ParseTelegramRoomMap(%q) = %v, want %v", tc.input, got, tc.want)
		}
	}
}
