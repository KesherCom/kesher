package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func newCompanionTestServer(t *testing.T) *Server {
	t.Helper()
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	return &Server{
		cfg:                  Config{},
		store:                store,
		sessions:             NewSessionManager(time.Minute),
		hub:                  hub,
		companionWS:          make(map[string]map[chan CompanionCommandResult]struct{}),
		companionState:       make(map[string]map[chan struct{}]struct{}),
		companionPageByRole:  make(map[string]int),
		companionHeldTargets: make(map[string]string),
	}
}

func TestResolveCompanionTargetUserRejectsDisallowedUser(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "role_a", "Role A", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "blocked-user", "role_a"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	s.cfg.CompanionAllowedUsernames = []string{"allowed-user"}
	_, err := s.resolveCompanionTargetUser(ctx, "role_a")
	if !errors.Is(err, errCompanionUserNotAllowed) {
		t.Fatalf("expected errCompanionUserNotAllowed, got %v", err)
	}
}

func TestExecuteCompanionButtonPressRejectsUnauthorizedPTTRoom(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "other", "Other", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole other failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "r-locked", "Locked", []string{"other"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePTTRoom, RoomID: "r-locked"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	result := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})
	if result.OK {
		t.Fatalf("expected authorization rejection, got OK result: %+v", result)
	}
	if result.Status != "rejected" {
		t.Fatalf("expected status rejected, got %q", result.Status)
	}
}

func TestExecuteCompanionButtonPressRejectsPTTSelectedWithoutAllowedTalkRoom(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePTTSelected}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	result := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})
	if result.OK {
		t.Fatalf("expected rejection when no allowed talk room is selected, got %+v", result)
	}
	if result.Status != "rejected" {
		t.Fatalf("expected status rejected, got %q", result.Status)
	}
}

func TestHubSessionCountForUsername(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer store.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(store, logger)
	now := time.Now()

	addClient := func(token string) {
		hub.Add(&client{
			session:      Session{Token: token, UserID: "u1", Username: "alice", RoleID: "role_a", ExpiresAt: now.Add(time.Hour)},
			user:         User{ID: "u1", Username: "alice", RoleID: "role_a"},
			connectedAt:  now,
			send:         make(chan WSOutbound, 1),
			sendPriority: make(chan WSOutbound, 1),
			listenRooms:  map[string]struct{}{},
			talkRooms:    map[string]struct{}{},
		})
	}

	addClient("t1")
	addClient("t2")

	if got := hub.SessionCountForUsername("alice"); got != 2 {
		t.Fatalf("expected 2 sessions for alice, got %d", got)
	}
}

func TestNormalizeCompanionRelayCommandRejectsUnsupported(t *testing.T) {
	s := newCompanionTestServer(t)
	_, err := s.normalizeCompanionRelayCommand(context.Background(), "source", "operator", CompanionCommand{Command: "unknown_cmd"})
	if err == nil {
		t.Fatal("expected error for unsupported relay command")
	}
}

func TestNormalizeCompanionRelayCommandRejectsUnauthorizedRoomPTT(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "other", "Other", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole other failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "r-locked", "Locked", []string{"other"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}

	_, err := s.normalizeCompanionRelayCommand(ctx, "source", "operator", CompanionCommand{
		Command:  "ptt",
		Scope:    "room",
		TargetID: "r-locked",
		State:    "ptt_start",
	})
	if err == nil || err.Error() != "not allowed to talk to room" {
		t.Fatalf("expected room authorization error, got %v", err)
	}
}

func TestNormalizeCompanionRelayCommandRejectsDisallowedMatrixRoom(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "other", "Other", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole other failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "r-locked", "Locked", []string{"source"}, []string{"other"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}

	_, err := s.normalizeCompanionRelayCommand(ctx, "source", "operator", CompanionCommand{
		Command:       "set_room_matrix",
		ListenRoomIDs: []string{"r-locked"},
		TalkRoomIDs:   []string{},
	})
	if err == nil || err.Error() != "not allowed to listen to room" {
		t.Fatalf("expected listen authorization error, got %v", err)
	}
}

func TestNormalizeCompanionRelayCommandRejectsUnauthorizedDirectSignal(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "target", "Target", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole target failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "target-user", "target"); err != nil {
		t.Fatalf("UpsertUser target failed: %v", err)
	}

	targetUser, err := s.store.FindUserByUsername(ctx, "target-user")
	if err != nil {
		t.Fatalf("FindUserByUsername failed: %v", err)
	}

	_, err = s.normalizeCompanionRelayCommand(ctx, "source", "operator", CompanionCommand{
		Command:  "signal",
		Scope:    "direct",
		TargetID: targetUser.ID,
		Signal:   "call",
	})
	if err == nil || err.Error() != "not allowed to signal target user" {
		t.Fatalf("expected direct signal authorization error, got %v", err)
	}
}

func TestNormalizeCompanionRelayCommandRejectsUnauthorizedBroadcastSignal(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "other", "Other", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole other failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "room-a", "Room A", []string{"source"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}
	if err := s.store.CreateBroadcastGroup(ctx, "broadcast-a", "Broadcast A", []string{"room-a"}, []string{"other"}); err != nil {
		t.Fatalf("CreateBroadcastGroup failed: %v", err)
	}

	_, err := s.normalizeCompanionRelayCommand(ctx, "source", "operator", CompanionCommand{
		Command:  "signal",
		Scope:    "broadcast",
		TargetID: "broadcast-a",
		Signal:   "call",
	})
	if err == nil || err.Error() != "not allowed to signal broadcast group" {
		t.Fatalf("expected broadcast signal authorization error, got %v", err)
	}
}

func TestCompanionButtonSnapshotStateKeepsHeldPTTRoomActive(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	coord, err := NewImageStreamCoordinator(logger)
	if err != nil {
		t.Fatalf("NewImageStreamCoordinator failed: %v", err)
	}
	s.imageStreamCoord = coord

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	user, err := s.store.UpsertUser(ctx, "operator", "source")
	if err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}
	s.sessions.Create(user)

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePTTRoom, RoomID: "room-a"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	client := &ImageStreamClient{send: make(chan ImageStreamMessage, 32), done: make(chan struct{}), logger: logger}
	s.imageStreamCoord.RegisterClient(client)
	defer s.imageStreamCoord.UnregisterClient(client)

	s.rememberCompanionHeldTarget("source:0:0", "room-a")
	s.emitCompanionCurrentPageImages(ctx, "source")

	for i := 0; i < len(settings.Pages[0].Buttons); i++ {
		msg := <-client.send
		if msg.ButtonIndex != 0 {
			continue
		}
		if msg.State != "TALK" {
			t.Fatalf("expected held ptt room button to stay TALK during snapshot refresh, got %q", msg.State)
		}
		return
	}
	t.Fatal("did not receive snapshot image for target button")
}

func TestExecuteCompanionButtonPressPTTSelectedStopsOriginalHeldTarget(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "room-a", "Room A", []string{"source"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom room-a failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "room-b", "Room B", []string{"source"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom room-b failed: %v", err)
	}
	user, err := s.store.UpsertUser(ctx, "operator", "source")
	if err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}
	session := s.sessions.Create(user)

	client := &client{
		session:      session,
		user:         user,
		send:         make(chan WSOutbound, 8),
		sendPriority: make(chan WSOutbound, 8),
		listenRooms:  map[string]struct{}{},
		talkRooms:    map[string]struct{}{},
	}
	s.hub.Add(client)
	s.hub.SetRoomMatrix(session.Token, nil, []string{"room-a"})

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePTTSelected}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !down.OK || down.Status != "queued" {
		t.Fatalf("expected down press to queue, got %+v", down)
	}
	first := <-client.sendPriority
	command, ok := first.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", first.Data)
	}
	if command.TargetID != "room-a" || command.State != "ptt_start" {
		t.Fatalf("expected ptt_start for room-a, got %+v", command)
	}

	s.hub.SetRoomMatrix(session.Token, nil, []string{"room-b"})

	up := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "up"})
	if !up.OK || up.Status != "queued" {
		t.Fatalf("expected up press to queue, got %+v", up)
	}
	second := <-client.sendPriority
	stopCommand, ok := second.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", second.Data)
	}
	if stopCommand.TargetID != "room-a" || stopCommand.State != "ptt_stop" {
		t.Fatalf("expected ptt_stop for original held room-a, got %+v", stopCommand)
	}

	if heldTarget, ok := s.companionHeldTarget("source:0:0"); ok || strings.TrimSpace(heldTarget) != "" {
		t.Fatalf("expected held target to be cleared after release, got %q", heldTarget)
	}
}

func TestExecuteCompanionButtonPressCallRoomKeepsVisibleFeedbackUntilRefresh(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	coord, err := NewImageStreamCoordinator(logger)
	if err != nil {
		t.Fatalf("NewImageStreamCoordinator failed: %v", err)
	}
	s.imageStreamCoord = coord

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "room-a", "Room A", []string{"source"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom room-a failed: %v", err)
	}
	user, err := s.store.UpsertUser(ctx, "operator", "source")
	if err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}
	session := s.sessions.Create(user)

	hubClient := &client{
		session:      session,
		user:         user,
		send:         make(chan WSOutbound, 8),
		sendPriority: make(chan WSOutbound, 8),
		listenRooms:  map[string]struct{}{},
		talkRooms:    map[string]struct{}{},
	}
	s.hub.Add(hubClient)

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeCallRoom, RoomID: "room-a"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	imageClient := &ImageStreamClient{send: make(chan ImageStreamMessage, 32), done: make(chan struct{}), logger: logger}
	s.imageStreamCoord.RegisterClient(imageClient)
	defer s.imageStreamCoord.UnregisterClient(imageClient)

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !down.OK || down.Status != "queued" {
		t.Fatalf("expected down press to queue, got %+v", down)
	}
	commandOutbound := <-hubClient.sendPriority
	command, ok := commandOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", commandOutbound.Data)
	}
	if command.Command != "signal" || command.Signal != "call" || command.TargetID != "room-a" {
		t.Fatalf("unexpected call command payload: %+v", command)
	}
	imageDown := <-imageClient.send
	if imageDown.State != "TALK" {
		t.Fatalf("expected call button image to switch to TALK, got %q", imageDown.State)
	}

	up := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "up"})
	if !up.OK || up.Status != "executed" {
		t.Fatalf("expected release to complete without immediate reset, got %+v", up)
	}
	select {
	case msg := <-imageClient.send:
		t.Fatalf("expected no immediate idle image on call button release, got state %q", msg.State)
	default:
	}
}
