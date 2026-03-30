package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
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
		cfg:                              Config{},
		store:                            store,
		sessions:                         NewSessionManager(time.Minute),
		hub:                              hub,
		companionWS:                      make(map[string]map[chan CompanionCommandResult]struct{}),
		companionState:                   make(map[string]map[chan struct{}]struct{}),
		companionPageByRole:              make(map[string]int),
		companionHeldTargets:             make(map[string]string),
		companionPendingCallScopeByUser:  make(map[string]string),
		companionPendingCallSourceByUser: make(map[string]string),
		companionAckedSignalByUser:       make(map[string]string),
		companionSelectListenHoldDelay:   10 * time.Millisecond,
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

func TestResolveCompanionTargetUserAllowsRoleWithoutUser(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "role_a", "Role A", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}

	target, err := s.resolveCompanionTargetUser(ctx, "role_a")
	if err != nil {
		t.Fatalf("resolveCompanionTargetUser failed: %v", err)
	}
	if target.RoleID != "role_a" {
		t.Fatalf("expected role_a, got %q", target.RoleID)
	}
	if strings.TrimSpace(target.Username) == "" {
		t.Fatalf("expected fallback username, got empty")
	}
}

func TestCompanionButtonSnapshotStateMarksPTTSelectedForSelectActions(t *testing.T) {
	s := &Server{}
	presence := PresenceState{
		ListenRooms: []string{"room-a"},
		TalkRooms:   []string{"room-a"},
	}

	selectTalk := StreamDeckButtonConfig{
		Index: 0,
		Action: &StreamDeckButtonAction{
			Type:   StreamDeckActionTypeSelectTalkRoom,
			RoomID: "room-a",
		},
	}
	selectListen := StreamDeckButtonConfig{
		Index: 1,
		Action: &StreamDeckButtonAction{
			Type:   StreamDeckActionTypeSelectListen,
			RoomID: "room-a",
		},
	}

	talkState := s.companionButtonSnapshotState(context.Background(), "role-a", 0, "operator", presence, selectTalk)
	if !talkState.IsPTTSelected {
		t.Fatal("expected select_talk_room button to be marked as PTT-selected")
	}
	if !talkState.IsListening {
		t.Fatal("expected select_talk_room button to keep listen marker")
	}

	listenState := s.companionButtonSnapshotState(context.Background(), "role-a", 0, "operator", presence, selectListen)
	if !listenState.IsPTTSelected {
		t.Fatal("expected select_listen_room button to be marked as PTT-selected")
	}
	if !listenState.IsListening {
		t.Fatal("expected select_listen_room button to keep listen marker")
	}
}

func TestCompanionButtonSnapshotStateReplyToCallerSetsBlinkEffectOnIncomingSignal(t *testing.T) {
	s := newCompanionTestServer(t)
	now := time.Now()
	s.hub.Add(&client{
		session:       Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "role_a", ExpiresAt: now.Add(time.Hour)},
		user:          User{ID: "u1", Username: "operator", RoleID: "role_a"},
		connectedAt:   now,
		signalFrom:    "caller",
		signalMessage: "call",
		signalScope:   "direct",
		signalUntil:   now.Add(time.Second),
		send:          make(chan WSOutbound, 1),
		sendPriority:  make(chan WSOutbound, 1),
		listenRooms:   map[string]struct{}{},
		talkRooms:     map[string]struct{}{},
	})

	button := StreamDeckButtonConfig{
		Index: 7,
		Action: &StreamDeckButtonAction{
			Type: StreamDeckActionTypeReplyToCaller,
		},
	}

	state := s.companionButtonSnapshotState(context.Background(), "role_a", 0, "operator", PresenceState{}, button)
	if state.EffectValue != companionIncomingCallEffectValue {
		t.Fatalf("expected blink effect value %d while signal is active, got %d", companionIncomingCallEffectValue, state.EffectValue)
	}
}

func TestCompanionButtonSnapshotStateReplyToCallerDoesNotBlinkOnRoomCall(t *testing.T) {
	s := newCompanionTestServer(t)
	now := time.Now()
	s.hub.Add(&client{
		session:       Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "role_a", ExpiresAt: now.Add(time.Hour)},
		user:          User{ID: "u1", Username: "operator", RoleID: "role_a"},
		connectedAt:   now,
		signalFrom:    "alice (PL Main)",
		signalMessage: "call",
		signalScope:   "room",
		signalUntil:   now.Add(time.Second),
		send:          make(chan WSOutbound, 1),
		sendPriority:  make(chan WSOutbound, 1),
		listenRooms:   map[string]struct{}{},
		talkRooms:     map[string]struct{}{},
	})

	button := StreamDeckButtonConfig{
		Index: 7,
		Action: &StreamDeckButtonAction{
			Type: StreamDeckActionTypeReplyToCaller,
		},
	}

	state := s.companionButtonSnapshotState(context.Background(), "role_a", 0, "operator", PresenceState{}, button)
	if state.EffectValue != 0 {
		t.Fatalf("expected reply-to-caller to ignore room call blink, got effectValue=%d", state.EffectValue)
	}
}

func TestCompanionButtonSnapshotStateReplyToCallerKeepsBlinkWhenCallPending(t *testing.T) {
	s := newCompanionTestServer(t)
	s.setCompanionPendingIncomingCall("operator", true)
	s.setCompanionPendingIncomingCallScope("operator", "direct")

	button := StreamDeckButtonConfig{
		Index: 5,
		Action: &StreamDeckButtonAction{
			Type: StreamDeckActionTypeReplyToCaller,
		},
	}

	state := s.companionButtonSnapshotState(context.Background(), "role_a", 0, "operator", PresenceState{}, button)
	if state.EffectValue != companionIncomingCallEffectValue {
		t.Fatalf("expected pending call effect value %d, got %d", companionIncomingCallEffectValue, state.EffectValue)
	}
}

func TestCompanionButtonSnapshotStateIncomingCallIndicatorShowsCallerAndBlink(t *testing.T) {
	s := newCompanionTestServer(t)
	now := time.Now()
	s.hub.Add(&client{
		session:       Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "role_a", ExpiresAt: now.Add(time.Hour)},
		user:          User{ID: "u1", Username: "operator", RoleID: "role_a"},
		connectedAt:   now,
		signalFrom:    "alice (PL Main)",
		signalMessage: "call",
		signalScope:   "room",
		signalUntil:   now.Add(time.Second),
		send:          make(chan WSOutbound, 1),
		sendPriority:  make(chan WSOutbound, 1),
		listenRooms:   map[string]struct{}{},
		talkRooms:     map[string]struct{}{},
	})

	button := StreamDeckButtonConfig{
		Index: 7,
		Action: &StreamDeckButtonAction{
			Type: StreamDeckActionTypeIncomingCall,
		},
	}

	state := s.companionButtonSnapshotState(context.Background(), "role_a", 0, "operator", PresenceState{}, button)
	if state.EffectValue != companionIncomingCallEffectValue {
		t.Fatalf("expected blink effect value %d while signal is active, got %d", companionIncomingCallEffectValue, state.EffectValue)
	}
	if state.Label != "Incoming" {
		t.Fatalf("expected incoming indicator label, got %q", state.Label)
	}
	if state.Subtitle != "alice (PL Main)" {
		t.Fatalf("expected caller subtitle, got %q", state.Subtitle)
	}
}

func TestCompanionButtonSnapshotStateDirectRoleButtonBlinksForDirectCallSource(t *testing.T) {
	s := newCompanionTestServer(t)
	now := time.Now()
	s.hub.Add(&client{
		session:          Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "role_a", ExpiresAt: now.Add(time.Hour)},
		user:             User{ID: "u1", Username: "operator", RoleID: "role_a"},
		connectedAt:      now,
		signalFrom:       "caller",
		signalMessage:    "call",
		signalScope:      "direct",
		signalSourceType: "role",
		signalSourceID:   "director",
		signalUntil:      now.Add(time.Second),
		send:             make(chan WSOutbound, 1),
		sendPriority:     make(chan WSOutbound, 1),
		listenRooms:      map[string]struct{}{},
		talkRooms:        map[string]struct{}{},
	})

	button := StreamDeckButtonConfig{
		Index: 2,
		Action: &StreamDeckButtonAction{
			Type:   StreamDeckActionTypeDirectRole,
			RoleID: "director",
		},
	}

	state := s.companionButtonSnapshotState(context.Background(), "role_a", 0, "operator", PresenceState{}, button)
	if state.EffectValue != companionIncomingCallEffectValue {
		t.Fatalf("expected matching direct-role button to blink, got effectValue=%d", state.EffectValue)
	}
}

func TestCompanionButtonSnapshotStateRoomButtonBlinksForRoomCallSource(t *testing.T) {
	s := newCompanionTestServer(t)
	now := time.Now()
	s.hub.Add(&client{
		session:          Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "role_a", ExpiresAt: now.Add(time.Hour)},
		user:             User{ID: "u1", Username: "operator", RoleID: "role_a"},
		connectedAt:      now,
		signalFrom:       "alice (PL Main)",
		signalMessage:    "call",
		signalScope:      "room",
		signalSourceType: "room",
		signalSourceID:   "pl-main",
		signalUntil:      now.Add(time.Second),
		send:             make(chan WSOutbound, 1),
		sendPriority:     make(chan WSOutbound, 1),
		listenRooms:      map[string]struct{}{},
		talkRooms:        map[string]struct{}{},
	})

	button := StreamDeckButtonConfig{
		Index: 3,
		Action: &StreamDeckButtonAction{
			Type:   StreamDeckActionTypeListenRoom,
			RoomID: "pl-main",
		},
	}

	state := s.companionButtonSnapshotState(context.Background(), "role_a", 0, "operator", PresenceState{}, button)
	if state.EffectValue != companionIncomingCallEffectValue {
		t.Fatalf("expected matching room button to blink, got effectValue=%d", state.EffectValue)
	}
}

func TestExecuteCompanionButtonPressReplyToCallerClearsPendingCall(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	s.setCompanionPendingIncomingCall("operator", true)
	_ = s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})

	if s.hasCompanionPendingIncomingCall("operator") {
		t.Fatal("expected pending incoming call to be cleared after reply button press")
	}
}

func TestExecuteCompanionButtonPressIncomingCallIndicatorNoOp(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	now := time.Now()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	s.hub.Add(&client{
		session:       Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "source", ExpiresAt: now.Add(time.Hour)},
		user:          User{ID: "u1", Username: "operator", RoleID: "source"},
		connectedAt:   now,
		signalFrom:    "alice (PL Main)",
		signalMessage: "call",
		signalScope:   "room",
		signalUntil:   now.Add(time.Second),
		send:          make(chan WSOutbound, 1),
		sendPriority:  make(chan WSOutbound, 1),
		listenRooms:   map[string]struct{}{},
		talkRooms:     map[string]struct{}{},
	})
	s.setCompanionPendingIncomingCall("operator", true)

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeIncomingCall}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	result := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})
	if !result.OK {
		t.Fatalf("expected no-op indicator press to succeed, got %+v", result)
	}
	if result.Status != "executed" {
		t.Fatalf("expected status executed, got %q", result.Status)
	}
	if s.hasCompanionPendingIncomingCall("operator") {
		t.Fatal("expected pending incoming call to be cleared after incoming indicator press")
	}
	state := s.companionButtonSnapshotState(context.Background(), "source", 0, "operator", PresenceState{}, settings.Pages[0].Buttons[0])
	if state.EffectValue != 0 {
		t.Fatalf("expected blinking to stay suppressed after acknowledgement, got effectValue=%d", state.EffectValue)
	}
}

func TestExecuteCompanionButtonPressMatchingDirectRoleAcknowledgesIncomingCall(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	now := time.Now()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	s.hub.Add(&client{
		session:          Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "source", ExpiresAt: now.Add(time.Hour)},
		user:             User{ID: "u1", Username: "operator", RoleID: "source"},
		connectedAt:      now,
		signalFrom:       "caller",
		signalMessage:    "call",
		signalScope:      "direct",
		signalSourceType: "role",
		signalSourceID:   "director",
		signalUntil:      now.Add(time.Second),
		send:             make(chan WSOutbound, 1),
		sendPriority:     make(chan WSOutbound, 1),
		listenRooms:      map[string]struct{}{},
		talkRooms:        map[string]struct{}{},
	})
	s.setCompanionPendingIncomingCall("operator", true)
	s.setCompanionPendingIncomingCallScope("operator", "direct")
	s.setCompanionPendingIncomingCallSource("operator", "role", "director")

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeDirectRole, RoleID: "director"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	result := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if result.OK {
		t.Fatalf("expected direct role press without active user to not execute cleanly, got %+v", result)
	}
	if s.hasCompanionPendingIncomingCall("operator") {
		t.Fatal("expected pending incoming call to be cleared after matching direct-role press")
	}
	state := s.companionButtonSnapshotState(context.Background(), "source", 0, "operator", PresenceState{}, settings.Pages[0].Buttons[0])
	if state.EffectValue != 0 {
		t.Fatalf("expected direct-role blink to stop after acknowledgement, got effectValue=%d", state.EffectValue)
	}
}

func TestExecuteCompanionButtonPressMatchingRoomAcknowledgesIncomingCall(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	now := time.Now()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "pl-main", "PL Main", []string{"source"}, []string{"source"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	s.hub.Add(&client{
		session:          Session{Token: "token-1", UserID: "u1", Username: "operator", RoleID: "source", ExpiresAt: now.Add(time.Hour)},
		user:             User{ID: "u1", Username: "operator", RoleID: "source"},
		connectedAt:      now,
		signalFrom:       "alice (PL Main)",
		signalMessage:    "call",
		signalScope:      "room",
		signalSourceType: "room",
		signalSourceID:   "pl-main",
		signalUntil:      now.Add(time.Second),
		send:             make(chan WSOutbound, 1),
		sendPriority:     make(chan WSOutbound, 1),
		listenRooms:      map[string]struct{}{},
		talkRooms:        map[string]struct{}{},
	})
	s.setCompanionPendingIncomingCall("operator", true)
	s.setCompanionPendingIncomingCallScope("operator", "room")
	s.setCompanionPendingIncomingCallSource("operator", "room", "pl-main")

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeListenRoom, RoomID: "pl-main"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	result := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !result.OK {
		t.Fatalf("expected matching room press to execute, got %+v", result)
	}
	if s.hasCompanionPendingIncomingCall("operator") {
		t.Fatal("expected pending incoming call to be cleared after matching room press")
	}
	state := s.companionButtonSnapshotState(context.Background(), "source", 0, "operator", PresenceState{}, settings.Pages[0].Buttons[0])
	if state.EffectValue != 0 {
		t.Fatalf("expected room blink to stop after acknowledgement, got effectValue=%d", state.EffectValue)
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

func TestExecuteCompanionButtonPressPageButtonsSwitchCurrentPage(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page0Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}
	page1Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown}
	settings.SelectedPage = 0
	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	if page := s.currentCompanionPage(ctx, "source"); page != 0 {
		t.Fatalf("expected initial page 0, got %d", page)
	}

	forward := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})
	if !forward.OK || forward.Status != "executed" {
		t.Fatalf("expected page_up button to execute, got %+v", forward)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 1 {
		t.Fatalf("expected current page to become 1 after page_up button, got %d", page)
	}

	backward := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})
	if !backward.OK || backward.Status != "executed" {
		t.Fatalf("expected page_down button to execute, got %+v", backward)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 0 {
		t.Fatalf("expected current page to become 0 after page_down button, got %d", page)
	}
}

func TestExecuteCompanionButtonPressPageButtonsIgnoreButtonUp(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page0Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}
	page1Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown}
	settings.SelectedPage = 0
	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "down",
	})
	if !down.OK || down.Status != "executed" {
		t.Fatalf("expected page_up on down to execute, got %+v", down)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 1 {
		t.Fatalf("expected current page to become 1 after page_up down event, got %d", page)
	}

	up := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "up",
	})
	if !up.OK || up.Status != "executed" {
		t.Fatalf("expected page_up on up to be ignored as executed no-op, got %+v", up)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 1 {
		t.Fatalf("expected current page to remain 1 after page_up up event, got %d", page)
	}
}

func TestExecuteCompanionButtonPressPageButtonsAllowUpOnlyTrigger(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page0Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}
	page1Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown}
	settings.SelectedPage = 0
	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	s.setCompanionCurrentPage("source", 1)

	upOnly := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 0,
		State:       "up",
	})
	if !upOnly.OK || upOnly.Status != "executed" {
		t.Fatalf("expected page_down on up-only trigger to execute, got %+v", upOnly)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 0 {
		t.Fatalf("expected current page to become 0 after page_down up-only event, got %d", page)
	}
}

func TestExecuteCompanionButtonPressPageButtonsIndependentFromSlotViaAnchor(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page0Buttons[6].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}
	page1Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown}
	settings.SelectedPage = 0
	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	forward := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 6,
		State:       "down",
	})
	if !forward.OK || forward.Status != "executed" {
		t.Fatalf("expected page_up on slot 6 to execute, got %+v", forward)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 1 {
		t.Fatalf("expected current page to become 1 after page_up, got %d", page)
	}

	backward := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 6,
		State:       "down",
	})
	if !backward.OK || backward.Status != "executed" {
		t.Fatalf("expected page_down fallback to execute from anchored slot 6, got %+v", backward)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 0 {
		t.Fatalf("expected current page to become 0 after anchored fallback page_down, got %d", page)
	}
}

func TestCompanionResolveRuntimePageUsesSlidingWindowWithReservedNavSlots(t *testing.T) {
	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)

	for i := 0; i < 10; i++ {
		page0Buttons[i].Label = "A"
		page0Buttons[i].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeMuteToggle}
	}
	for i := 0; i < 10; i++ {
		page1Buttons[i].Label = "B"
		page1Buttons[i].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeMuteToggle}
	}

	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}

	runtime0 := companionResolveRuntimePage(settings, 0)
	if !runtime0.Dynamic {
		t.Fatal("expected sliding runtime page to be dynamic")
	}
	if runtime0.TotalPages != 2 {
		t.Fatalf("expected 2 runtime pages, got %d", runtime0.TotalPages)
	}
	if runtime0.Page.Buttons[13].Action != nil {
		t.Fatal("expected slot 13 to be empty on first runtime page")
	}
	if runtime0.Page.Buttons[14].Action == nil || runtime0.Page.Buttons[14].Action.Type != StreamDeckActionTypePageUp {
		t.Fatalf("expected slot 14 to be page_up on first runtime page, got %+v", runtime0.Page.Buttons[14].Action)
	}

	runtime1 := companionResolveRuntimePage(settings, 1)
	if !runtime1.Dynamic {
		t.Fatal("expected second runtime page to be dynamic")
	}
	if runtime1.Page.Buttons[13].Action == nil || runtime1.Page.Buttons[13].Action.Type != StreamDeckActionTypePageDown {
		t.Fatalf("expected slot 13 to be page_down on second runtime page, got %+v", runtime1.Page.Buttons[13].Action)
	}
	if runtime1.Page.Buttons[14].Action != nil {
		t.Fatal("expected slot 14 to be empty on final runtime page")
	}
}

func TestResolveCompanionRuntimePageUsesRoleRoomsAsSlidingDataSource(t *testing.T) {
	s := newCompanionTestServer(t)
	s.cfg.CompanionDynamicPaging = true
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}

	for i := 1; i <= 14; i++ {
		roomID := fmt.Sprintf("r%02d", i)
		roomName := fmt.Sprintf("Room %02d", i)
		if err := s.store.CreateRoom(ctx, roomID, roomName, []string{"source"}, []string{"source"}, nil); err != nil {
			t.Fatalf("CreateRoom %s failed: %v", roomID, err)
		}
	}

	settings := DefaultStreamDeckSettings()
	runtime0 := s.resolveCompanionRuntimePage(ctx, "source", settings, 0)
	if !runtime0.Dynamic {
		t.Fatal("expected runtime page to be dynamic when rooms are available")
	}
	if runtime0.TotalPages != 2 {
		t.Fatalf("expected totalPages=2, got %d", runtime0.TotalPages)
	}
	if runtime0.Page.Buttons[0].Action == nil || runtime0.Page.Buttons[0].Action.Type != StreamDeckActionTypePTTRoom {
		t.Fatalf("expected first payload slot to map to ptt_room, got %+v", runtime0.Page.Buttons[0].Action)
	}
	if runtime0.Page.Buttons[13].Action != nil {
		t.Fatal("expected slot 13 to be empty on first dynamic page")
	}
	if runtime0.Page.Buttons[14].Action == nil || runtime0.Page.Buttons[14].Action.Type != StreamDeckActionTypePageUp {
		t.Fatalf("expected slot 14 to be page_up on first dynamic page, got %+v", runtime0.Page.Buttons[14].Action)
	}

	runtime1 := s.resolveCompanionRuntimePage(ctx, "source", settings, 1)
	if !runtime1.Dynamic {
		t.Fatal("expected second runtime page to remain dynamic")
	}
	if runtime1.Page.Buttons[0].Action == nil || strings.TrimSpace(runtime1.Page.Buttons[0].Action.RoomID) != "r14" {
		t.Fatalf("expected first payload slot on page 2 to be room r14, got %+v", runtime1.Page.Buttons[0].Action)
	}
	if runtime1.Page.Buttons[13].Action == nil || runtime1.Page.Buttons[13].Action.Type != StreamDeckActionTypePageDown {
		t.Fatalf("expected slot 13 to be page_down on second dynamic page, got %+v", runtime1.Page.Buttons[13].Action)
	}
	if runtime1.Page.Buttons[14].Action != nil {
		t.Fatal("expected slot 14 to be empty on final dynamic page")
	}
}

func TestBuildCompanionProfileResponseExpandsAutoRoleFolder(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "director", "Director", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole director failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "room-a", "Room A", []string{"source"}, []string{"director"}, nil); err != nil {
		t.Fatalf("CreateRoom room-a failed: %v", err)
	}
	user, err := s.store.UpsertUser(ctx, "operator", "source")
	if err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[1].Label = "Roles"
	settings.Pages[0].Buttons[1].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageJump, TargetPage: 1}
	parentPage := 0
	settings.Pages = append(settings.Pages, StreamDeckPageConfig{
		Page:       1,
		Title:      "Roles",
		PageType:   StreamDeckPageTypeAllRoles,
		ParentPage: &parentPage,
		Buttons:    companionBuildEmptyButtons(settings),
	})
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	profile, err := s.buildCompanionProfileResponse(ctx, user)
	if err != nil {
		t.Fatalf("buildCompanionProfileResponse failed: %v", err)
	}
	autoPage := companionResolvePageConfig(profile.StreamDeck, 1)
	if autoPage.Buttons[0].Action == nil || autoPage.Buttons[0].Action.Type != StreamDeckActionTypePageBack {
		t.Fatalf("expected auto folder to inject page_back into slot 0, got %+v", autoPage.Buttons[0].Action)
	}
	foundDirector := false
	for _, button := range autoPage.Buttons {
		if button.Action != nil && button.Action.Type == StreamDeckActionTypeDirectRole && button.Action.RoleID == "director" {
			foundDirector = true
			break
		}
	}
	if !foundDirector {
		t.Fatal("expected expanded auto role folder to include reachable director role")
	}
}

func TestExecuteCompanionPageCommandPageBackReturnsToParent(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	settings := DefaultStreamDeckSettings()
	parentPage := 0
	settings.Pages = append(settings.Pages, StreamDeckPageConfig{
		Page:       1,
		Title:      "Child",
		PageType:   StreamDeckPageTypeManual,
		ParentPage: &parentPage,
		Buttons:    companionBuildEmptyButtons(settings),
	})
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	s.setCompanionCurrentPage("source", 1)
	result, handled := s.executeCompanionPageCommand(ctx, "source", "operator", CompanionCommand{Command: "page_back"})
	if !handled {
		t.Fatal("expected page_back to be handled")
	}
	if !result.OK || result.Status != "executed" {
		t.Fatalf("expected successful page_back execution, got %+v", result)
	}
	if got := s.currentCompanionPage(ctx, "source"); got != 0 {
		t.Fatalf("expected page_back to return to parent page 0, got %d", got)
	}
}

func TestExecuteCompanionButtonPressDynamicEdgeFallbackAllowsReverseOnNextSlot(t *testing.T) {
	s := newCompanionTestServer(t)
	s.cfg.CompanionDynamicPaging = true
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	for i := 0; i < 10; i++ {
		page0Buttons[i].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeMuteToggle}
		page1Buttons[i].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeMuteToggle}
	}
	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	s.setCompanionCurrentPage("source", 1)

	// On the last dynamic page, slot 14 (0-based) has no direct action.
	// Fallback should treat it as reverse navigation to make edge behavior tolerant.
	res := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{
		Command:     "press_button",
		ButtonIndex: 14,
		State:       "down",
	})
	if !res.OK || res.Status != "executed" {
		t.Fatalf("expected edge fallback navigation to execute, got %+v", res)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 0 {
		t.Fatalf("expected current page to become 0 after edge fallback, got %d", page)
	}
}

func TestExecuteCompanionPageCommandUpdatesRolePageState(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole source failed: %v", err)
	}
	if _, err := s.store.UpsertUser(ctx, "operator", "source"); err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}

	settings := DefaultStreamDeckSettings()
	page0Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	page1Buttons := append([]StreamDeckButtonConfig(nil), settings.Pages[0].Buttons...)
	settings.SelectedPage = 0
	settings.Pages = []StreamDeckPageConfig{
		{Page: 0, Buttons: page0Buttons},
		{Page: 1, Buttons: page1Buttons},
	}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	pageUpResult, handled := s.executeCompanionPageCommand(ctx, "source", "operator", CompanionCommand{Command: "page_up"})
	if !handled {
		t.Fatal("expected page_up command to be handled")
	}
	if !pageUpResult.OK || pageUpResult.Status != "executed" {
		t.Fatalf("expected page_up to execute, got %+v", pageUpResult)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 1 {
		t.Fatalf("expected current page to become 1 after page_up command, got %d", page)
	}

	navigateResult, handled := s.executeCompanionPageCommand(ctx, "source", "operator", CompanionCommand{Command: "navigate_to_page", PageNumber: 0})
	if !handled {
		t.Fatal("expected navigate_to_page command to be handled")
	}
	if !navigateResult.OK || navigateResult.Status != "executed" {
		t.Fatalf("expected navigate_to_page to execute, got %+v", navigateResult)
	}
	if page := s.currentCompanionPage(ctx, "source"); page != 0 {
		t.Fatalf("expected current page to become 0 after navigate_to_page command, got %d", page)
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

func TestLoadCompanionImageEffectMapJSONFromFile(t *testing.T) {
	tmp := t.TempDir()
	mapPath := filepath.Join(tmp, "image-effect-map.json")
	content := `{"0":{"mode":0},"1":{"mode":"blink","color":"#ff2d26"}}`
	if err := os.WriteFile(mapPath, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write image effect map: %v", err)
	}

	s := newCompanionTestServer(t)
	s.cfg.CompanionImageEffectMapFile = mapPath

	got := s.loadCompanionImageEffectMapJSON()
	if got != content {
		t.Fatalf("unexpected image effect map json: got %q want %q", got, content)
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

	client := &ImageStreamClient{RoleID: "source", Username: "operator", send: make(chan ImageStreamMessage, 32), done: make(chan struct{}), logger: logger}
	s.imageStreamCoord.RegisterClient(client)
	defer s.imageStreamCoord.UnregisterClient(client)

	s.rememberCompanionHeldTarget("source:0:0", "room-a")
	s.emitCompanionCurrentPageImages(ctx, "source", "operator")

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

func TestEmitCompanionCurrentPageImagesSkipsUnchangedButtonsOnRepeat(t *testing.T) {
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

	client := &ImageStreamClient{RoleID: "source", Username: "operator", send: make(chan ImageStreamMessage, 64), done: make(chan struct{}), logger: logger}
	s.imageStreamCoord.RegisterClient(client)
	defer s.imageStreamCoord.UnregisterClient(client)

	s.emitCompanionCurrentPageImages(ctx, "source", "operator")
	firstCount := 0
	for firstCount < len(settings.Pages[0].Buttons) {
		select {
		case <-client.send:
			firstCount++
		case <-time.After(250 * time.Millisecond):
			t.Fatalf("expected %d initial button updates, got %d", len(settings.Pages[0].Buttons), firstCount)
		}
	}

	s.emitCompanionCurrentPageImages(ctx, "source", "operator")
	select {
	case msg := <-client.send:
		t.Fatalf("expected no redundant updates on unchanged repeat snapshot, got button %d", msg.ButtonIndex)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestExecuteCompanionButtonPressPTTRoomSelectsFixedChannelBeforePTT(t *testing.T) {
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
	s.hub.SetRoomMatrix(session.Token, nil, []string{"room-b"})

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePTTRoom, RoomID: "room-a"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !down.OK || down.Status != "queued" {
		t.Fatalf("expected down press to queue, got %+v", down)
	}

	firstOutbound := <-client.sendPriority
	firstCommand, ok := firstOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", firstOutbound.Data)
	}
	if firstCommand.Command != "set_room_matrix" {
		t.Fatalf("expected first command to select talk room, got %+v", firstCommand)
	}
	if len(firstCommand.TalkRoomIDs) != 1 || firstCommand.TalkRoomIDs[0] != "room-a" {
		t.Fatalf("expected fixed talk room selection [room-a], got %+v", firstCommand.TalkRoomIDs)
	}

	secondOutbound := <-client.sendPriority
	secondCommand, ok := secondOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", secondOutbound.Data)
	}
	if secondCommand.Command != "ptt" || secondCommand.TargetID != "room-a" || secondCommand.State != "ptt_start" {
		t.Fatalf("expected room ptt_start for room-a after selection, got %+v", secondCommand)
	}

	s.hub.SetRoomMatrix(session.Token, nil, []string{"room-b"})

	up := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "up"})
	if !up.OK || up.Status != "queued" {
		t.Fatalf("expected up press to queue, got %+v", up)
	}

	thirdOutbound := <-client.sendPriority
	thirdCommand, ok := thirdOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", thirdOutbound.Data)
	}
	if thirdCommand.Command != "ptt" || thirdCommand.TargetID != "room-a" || thirdCommand.State != "ptt_stop" {
		t.Fatalf("expected ptt_stop for original fixed room-a, got %+v", thirdCommand)
	}

	if heldTarget, ok := s.companionHeldTarget("source:0:0"); ok || strings.TrimSpace(heldTarget) != "" {
		t.Fatalf("expected held target to be cleared after release, got %q", heldTarget)
	}
}

func TestExecuteCompanionButtonPressSelectTalkRoomSetsExclusiveSelection(t *testing.T) {
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
	s.hub.SetRoomMatrix(session.Token, []string{"room-a"}, []string{"room-a"})

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeSelectTalkRoom, RoomID: "room-b"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !down.OK || down.Status != "queued" {
		t.Fatalf("expected down press to queue, got %+v", down)
	}

	firstOutbound := <-client.sendPriority
	firstCommand, ok := firstOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", firstOutbound.Data)
	}
	if firstCommand.Command != "set_room_matrix" {
		t.Fatalf("expected set_room_matrix command, got %+v", firstCommand)
	}
	if len(firstCommand.ListenRoomIDs) != 1 || firstCommand.ListenRoomIDs[0] != "room-a" {
		t.Fatalf("expected listen rooms to be preserved, got %+v", firstCommand.ListenRoomIDs)
	}
	if len(firstCommand.TalkRoomIDs) != 1 || firstCommand.TalkRoomIDs[0] != "room-b" {
		t.Fatalf("expected exclusive talk room selection [room-b], got %+v", firstCommand.TalkRoomIDs)
	}

	s.hub.SetRoomMatrix(session.Token, []string{"room-a"}, []string{"room-b"})

	repeat := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !repeat.OK || repeat.Status != "queued" {
		t.Fatalf("expected repeat down press to stay queued, got %+v", repeat)
	}

	secondOutbound := <-client.sendPriority
	secondCommand, ok := secondOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", secondOutbound.Data)
	}
	if len(secondCommand.TalkRoomIDs) != 1 || secondCommand.TalkRoomIDs[0] != "room-b" {
		t.Fatalf("expected repeat press to keep [room-b] selected, got %+v", secondCommand.TalkRoomIDs)
	}
}

func TestExecuteCompanionButtonPressSelectListenSetsExclusiveSelection(t *testing.T) {
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
	s.hub.SetRoomMatrix(session.Token, []string{"room-a"}, []string{"room-a"})

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeSelectListen, RoomID: "room-b"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !down.OK || down.Status != "executed" {
		t.Fatalf("expected down press to arm hold logic, got %+v", down)
	}

	up := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "up"})
	if !up.OK || up.Status != "queued" {
		t.Fatalf("expected short press release to queue selection, got %+v", up)
	}

	firstOutbound := <-client.sendPriority
	firstCommand, ok := firstOutbound.Data.(CompanionCommand)
	if !ok {
		t.Fatalf("expected CompanionCommand payload, got %T", firstOutbound.Data)
	}
	if firstCommand.Command != "set_room_matrix" {
		t.Fatalf("expected set_room_matrix command, got %+v", firstCommand)
	}
	if len(firstCommand.ListenRoomIDs) != 1 || firstCommand.ListenRoomIDs[0] != "room-a" {
		t.Fatalf("expected listen rooms to be preserved, got %+v", firstCommand.ListenRoomIDs)
	}
	if len(firstCommand.TalkRoomIDs) != 1 || firstCommand.TalkRoomIDs[0] != "room-b" {
		t.Fatalf("expected exclusive talk room selection [room-b], got %+v", firstCommand.TalkRoomIDs)
	}
}

func TestExecuteCompanionButtonPressSelectListenLongHoldTogglesListen(t *testing.T) {
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
	s.hub.SetRoomMatrix(session.Token, []string{"room-a"}, []string{"room-a"})

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeSelectListen, RoomID: "room-b"}
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "source", settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}

	down := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !down.OK || down.Status != "executed" {
		t.Fatalf("expected down press to arm hold logic, got %+v", down)
	}

	select {
	case outbound := <-client.sendPriority:
		command, ok := outbound.Data.(CompanionCommand)
		if !ok {
			t.Fatalf("expected CompanionCommand payload, got %T", outbound.Data)
		}
		if command.Command != "set_room_matrix" {
			t.Fatalf("expected set_room_matrix command, got %+v", command)
		}
		if len(command.ListenRoomIDs) != 2 {
			t.Fatalf("expected long hold to toggle room-b listen on, got %+v", command.ListenRoomIDs)
		}
		if len(command.TalkRoomIDs) != 1 || command.TalkRoomIDs[0] != "room-a" {
			t.Fatalf("expected talk rooms to remain unchanged on long hold, got %+v", command.TalkRoomIDs)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for long-hold listen toggle command")
	}

	up := s.executeCompanionButtonPress(ctx, "source", "operator", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "up"})
	if !up.OK || up.Status != "executed" {
		t.Fatalf("expected release after long hold to avoid extra select, got %+v", up)
	}
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

	imageClient := &ImageStreamClient{RoleID: "source", Username: "operator", send: make(chan ImageStreamMessage, 32), done: make(chan struct{}), logger: logger}
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
