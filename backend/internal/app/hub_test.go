package app

import (
	"context"
	"log/slog"
	"os"
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

func TestHubSetVoiceStatePreservesAlwaysOnAcrossTransientPTT(t *testing.T) {
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
	hub.SetVoiceState("a", "ptt_start")
	presence, ok := hub.PresenceForUsername("a")
	if !ok || presence.VoiceMode != "always_on" || !presence.MicEnabled {
		t.Fatalf("unexpected always_on ptt_start presence: %+v", presence)
	}

	hub.SetVoiceState("a", "ptt_stop")
	presence, ok = hub.PresenceForUsername("a")
	if !ok || presence.VoiceMode != "always_on" || !presence.MicEnabled {
		t.Fatalf("unexpected always_on ptt_stop presence: %+v", presence)
	}
}

func TestHubRoomRoutingRespectsReceiverRoleRestrictions(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio", "video", "lighting"}, []string{"video"}, nil); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{
		session:     Session{Token: "sender", RoleID: "audio"},
		user:        User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:        make(chan WSOutbound, 4),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	allowedReceiver := &client{
		session:     Session{Token: "allowed", RoleID: "video"},
		user:        User{ID: "u2", Username: "allowed", RoleID: "video"},
		send:        make(chan WSOutbound, 4),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	blockedReceiver := &client{
		session:     Session{Token: "blocked", RoleID: "lighting"},
		user:        User{ID: "u3", Username: "blocked", RoleID: "lighting"},
		send:        make(chan WSOutbound, 4),
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
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio"}, []string{"audio", "lighting"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateRoom(context.Background(), "stage", "Stage", []string{"video"}, []string{"audio", "lighting"}, nil); err != nil {
		t.Fatal(err)
	}
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_groups (id,name) VALUES ('split-bg','Split BG')`)
	_, _ = store.db.ExecContext(context.Background(), `DELETE FROM broadcast_group_rooms WHERE broadcast_group_id = 'split-bg'`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('split-bg','foh')`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('split-bg','stage')`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_roles (broadcast_group_id, role_id) VALUES ('split-bg','audio')`)
	_, _ = store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_roles (broadcast_group_id, role_id) VALUES ('split-bg','video')`)

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	audioSender := &client{
		session:     Session{Token: "sender", RoleID: "audio"},
		user:        User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:        make(chan WSOutbound, 4),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	fohReceiver := &client{
		session:     Session{Token: "foh", RoleID: "lighting"},
		user:        User{ID: "u2", Username: "foh", RoleID: "lighting"},
		send:        make(chan WSOutbound, 4),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	stageReceiver := &client{
		session:     Session{Token: "stage", RoleID: "lighting"},
		user:        User{ID: "u3", Username: "stage", RoleID: "lighting"},
		send:        make(chan WSOutbound, 4),
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
	c1 := &client{session: Session{Token: "a"}, user: User{ID: "u1", Username: "a", RoleID: "audio"}, send: make(chan WSOutbound, 2)}
	c2 := &client{session: Session{Token: "b"}, user: User{ID: "u2", Username: "b", RoleID: "video"}, send: make(chan WSOutbound, 2)}
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
	c1 := &client{session: Session{Token: "a", RoleID: "audio"}, user: User{ID: "u1", Username: "a", RoleID: "audio"}, send: make(chan WSOutbound, 2), listenRooms: toRoomSet([]string{"foh"})}
	c2 := &client{session: Session{Token: "b", RoleID: "video"}, user: User{ID: "u2", Username: "b", RoleID: "video"}, send: make(chan WSOutbound, 2), listenRooms: toRoomSet([]string{"stage"})}
	hub.Add(c1)
	hub.Add(c2)
	drain(c1.send)
	drain(c2.send)
	if _, err := store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_groups (id,name) VALUES ('test-bg','Test BG')`); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('test-bg','foh')`); err != nil {
		t.Fatalf("insert room: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_group_roles (broadcast_group_id, role_id) VALUES ('test-bg','audio')`); err != nil {
		t.Fatalf("insert role: %v", err)
	}
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

func TestHubRemoveWithReasonSendsRevocation(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	c := &client{
		session: Session{Token: "token-a", RoleID: "audio"},
		user:    User{ID: "u1", Username: "tim", RoleID: "audio"},
		send:    make(chan WSOutbound, 4),
	}
	hub.Add(c)
	drain(c.send)

	hub.RemoveWithReason("token-a", "takeover")

	msg, ok := <-c.send
	if !ok {
		t.Fatal("expected buffered revocation message before channel closes")
	}
	if msg.Type != "session_revoked" {
		t.Fatalf("expected session_revoked message, got %s", msg.Type)
	}
	if msg.Data.(SessionRevokedEvent).Reason != "takeover" {
		t.Fatalf("unexpected revoke reason: %+v", msg.Data)
	}
	if _, stillPresent := hub.PresenceForUsername("tim"); stillPresent {
		t.Fatal("expected client to be removed from hub")
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
	if !ok || presence.VoiceMode != "always_on" || !presence.MicEnabled {
		t.Fatalf("unexpected always_on ptt_stop presence: %+v", presence)
	}
	hub.SetVoiceState("a", "always_off")
	presence, ok = hub.PresenceForUsername("a")
	if !ok || presence.VoiceMode != "ptt" || presence.MicEnabled {
		t.Fatalf("unexpected always_off presence: %+v", presence)
	}
}

func TestHubChatHistorySnapshotIncludesRoomAndDirect(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{
		session:     Session{Token: "sender", RoleID: "audio"},
		user:        User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:        make(chan WSOutbound, 16),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	hub.Add(sender)
	drain(sender.send)

	hub.RouteEvent("sender", "chat", RoutedEvent{Scope: "room", TargetID: "foh", Body: "room hello"})
	time.Sleep(2 * time.Millisecond)
	hub.RouteEvent("sender", "chat", RoutedEvent{Scope: "direct", TargetType: "user", TargetID: "u2", Body: "direct hello"})

	receiver := &client{
		session:     Session{Token: "receiver", RoleID: "video"},
		user:        User{ID: "u2", Username: "receiver", RoleID: "video"},
		send:        make(chan WSOutbound, 16),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	hub.Add(receiver)
	drain(receiver.send)

	count := hub.SendChatHistorySnapshot("receiver")
	if count != 2 {
		t.Fatalf("expected 2 chat history events, got %d", count)
	}

	var first, second RoutedEvent
	select {
	case msg := <-receiver.send:
		first = msg.Data.(RoutedEvent)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for first chat history event")
	}
	select {
	case msg := <-receiver.send:
		second = msg.Data.(RoutedEvent)
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for second chat history event")
	}
	if first.Body != "room hello" {
		t.Fatalf("expected first history message to be room message, got %q", first.Body)
	}
	if second.Body != "direct hello" {
		t.Fatalf("expected second history message to be direct message, got %q", second.Body)
	}
}

func TestHubClearChatHistoryRemovesBufferedMessages(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	hub.chatHistory.AppendForRoom("foh", RoutedEvent{Scope: "room", TargetID: "foh", Body: "hello", Timestamp: 1})

	hub.ClearChatHistory()
	remaining := hub.chatHistory.HistoryForRooms([]string{"foh"})
	if len(remaining) != 0 {
		t.Fatalf("expected cleared history, got %d entries", len(remaining))
	}
}

func TestHubBroadcastChatHistoryCleared(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	receiver := &client{session: Session{Token: "receiver"}, user: User{ID: "u2", Username: "receiver", RoleID: "video"}, send: make(chan WSOutbound, 4)}
	hub.Add(receiver)
	drain(receiver.send)

	hub.BroadcastChatHistoryCleared()

	select {
	case msg := <-receiver.send:
		if msg.Type != "chat_history_cleared" {
			t.Fatalf("expected chat_history_cleared message, got %s", msg.Type)
		}
	default:
		t.Fatal("expected chat_history_cleared message to be delivered")
	}
}

func TestHubRouteChatAckRoutesToOriginalSender(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)
	sender := &client{session: Session{Token: "sender-token"}, user: User{ID: "u1", Username: "sender", RoleID: "audio"}, send: make(chan WSOutbound, 4)}
	acker := &client{session: Session{Token: "acker-token"}, user: User{ID: "u2", Username: "acker", RoleID: "video"}, send: make(chan WSOutbound, 4)}
	hub.Add(sender)
	hub.Add(acker)
	drain(sender.send)
	drain(acker.send)

	hub.RouteChatAck("acker-token", ChatAckInbound{MessageID: "m-123", SenderUserID: "u1"})

	select {
	case msg := <-sender.send:
		if msg.Type != "chat_ack" {
			t.Fatalf("expected chat_ack event, got %s", msg.Type)
		}
		update, ok := msg.Data.(ChatAckUpdate)
		if !ok {
			t.Fatalf("expected ChatAckUpdate payload, got %T", msg.Data)
		}
		if update.MessageID != "m-123" || update.SenderUserID != "u1" || update.AckedBy.ID != "u2" {
			t.Fatalf("unexpected chat ack payload: %+v", update)
		}
	default:
		t.Fatal("expected chat ack update for original sender")
	}
	select {
	case <-acker.send:
		t.Fatal("did not expect acker to receive chat ack update")
	default:
	}
}

func TestHubSendChatToUserDoesNotPanicWithoutSenderClient(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	hub := NewHub(store, logger)

	receiver := &client{session: Session{Token: "receiver-token"}, user: User{ID: "u2", Username: "receiver", RoleID: "video"}, send: make(chan WSOutbound, 4)}
	hub.Add(receiver)
	drain(receiver.send)

	e := RoutedEvent{
		Scope:      "direct",
		TargetType: "user",
		TargetID:   "u2",
		Body:       "hello from telegram",
		Source:     "telegram",
		FromUser:   User{ID: "u1", Username: "sender", RoleID: "audio"},
	}

	hub.SendChatToUser("u2", e)

	select {
	case msg := <-receiver.send:
		if msg.Type != "chat" {
			t.Fatalf("expected chat message, got %s", msg.Type)
		}
		routed, ok := msg.Data.(RoutedEvent)
		if !ok {
			t.Fatalf("expected RoutedEvent payload, got %T", msg.Data)
		}
		if routed.Body != "hello from telegram" {
			t.Fatalf("unexpected routed body: %q", routed.Body)
		}
	default:
		t.Fatal("expected message to be delivered to target user")
	}
}
