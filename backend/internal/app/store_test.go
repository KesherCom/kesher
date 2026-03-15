package app

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNormalizeIDsTrimsDeduplicatesAndKeepsOrder(t *testing.T) {
	got := normalizeIDs([]string{" foh ", "", "stage", "foh", "stage", "video-control"})
	want := []string{"foh", "stage", "video-control"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected normalized IDs: got %v want %v", got, want)
	}
}

func TestIsAllowedVoiceMode(t *testing.T) {
	if !isAllowedVoiceMode("always_on") {
		t.Fatal("always_on should be allowed")
	}
	if !isAllowedVoiceMode("ptt") {
		t.Fatal("ptt should be allowed")
	}
	if isAllowedVoiceMode("listen_only") {
		t.Fatal("listen_only should not be allowed")
	}
}

func TestCreateRoleRejectsUnknownDefaultRoom(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	err = store.CreateRole(context.Background(), "qa", "QA", "missing-room", "ptt", false)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestCreateRoleRejectsInvalidDefaultVoiceMode(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	err = store.CreateRole(context.Background(), "qa", "QA", "foh", "listen_only", false)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestDeleteRoleConflictsWhenRoleAssignedToUser(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.UpsertUser(context.Background(), "alice", "audio"); err != nil {
		t.Fatal(err)
	}
	err = store.DeleteRole(context.Background(), "audio")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
}

func TestBroadcastGroupAllowsRoleReturnsNotFoundForUnknownGroup(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = store.BroadcastGroupAllowsRole(context.Background(), "does-not-exist", "audio")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestBroadcastGroupRoomIDsErrorsForEmptyGroup(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_groups (id,name) VALUES ('empty','Empty')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BroadcastGroupRoomIDs(context.Background(), "empty"); err == nil {
		t.Fatal("expected error for empty broadcast group room set")
	}
}

func TestBulkUpdateRoomPermissions(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()

	// Seed data provides roles: audio, video, lighting, ... and rooms: foh, stage, ...
	// Update permissions in bulk for foh and stage
	entries := []RoomPermissionEntry{
		{RoomID: "foh", SenderRoleIDs: []string{"audio", "video"}, ReceiverRoleIDs: []string{"audio", "lighting"}},
		{RoomID: "stage", SenderRoleIDs: []string{"lighting"}, ReceiverRoleIDs: []string{"video", "lighting"}},
	}
	if err := store.BulkUpdateRoomPermissions(ctx, entries); err != nil {
		t.Fatalf("BulkUpdateRoomPermissions failed: %v", err)
	}

	// Verify foh permissions.
	if allowed, err := store.RoomAllowsSenderRole(ctx, "foh", "audio"); err != nil || !allowed {
		t.Fatal("foh should have audio as sender")
	}
	if allowed, err := store.RoomAllowsSenderRole(ctx, "foh", "video"); err != nil || !allowed {
		t.Fatal("foh should have video as sender")
	}
	if allowed, err := store.RoomAllowsSenderRole(ctx, "foh", "lighting"); err != nil || allowed {
		t.Fatal("foh should not have lighting as sender")
	}
	if allowed, err := store.RoomAllowsReceiverRole(ctx, "foh", "audio"); err != nil || !allowed {
		t.Fatal("foh should have audio as receiver")
	}
	if allowed, err := store.RoomAllowsReceiverRole(ctx, "foh", "lighting"); err != nil || !allowed {
		t.Fatal("foh should have lighting as receiver")
	}
	if allowed, err := store.RoomAllowsReceiverRole(ctx, "foh", "video"); err != nil || allowed {
		t.Fatal("foh should not have video as receiver")
	}

	// Verify stage permissions
	if allowed, err := store.RoomAllowsSenderRole(ctx, "stage", "lighting"); err != nil || !allowed {
		t.Fatal("stage should have lighting as sender")
	}
	if allowed, err := store.RoomAllowsSenderRole(ctx, "stage", "audio"); err != nil || allowed {
		t.Fatal("stage should not have audio as sender")
	}
	if allowed, err := store.RoomAllowsReceiverRole(ctx, "stage", "video"); err != nil || !allowed {
		t.Fatal("stage should have video as receiver")
	}
	if allowed, err := store.RoomAllowsReceiverRole(ctx, "stage", "lighting"); err != nil || !allowed {
		t.Fatal("stage should have lighting as receiver")
	}
	if allowed, err := store.RoomAllowsReceiverRole(ctx, "stage", "audio"); err != nil || allowed {
		t.Fatal("stage should not have audio as receiver")
	}
}

func TestBulkUpdateRoomPermissionsRejectsUnknownRoom(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	entries := []RoomPermissionEntry{
		{RoomID: "nonexistent", SenderRoleIDs: []string{"audio"}, ReceiverRoleIDs: []string{}},
	}
	err = store.BulkUpdateRoomPermissions(context.Background(), entries)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestBulkUpdateRoomPermissionsRejectsUnknownRole(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	entries := []RoomPermissionEntry{
		{RoomID: "foh", SenderRoleIDs: []string{"nonexistent-role"}, ReceiverRoleIDs: []string{}},
	}
	err = store.BulkUpdateRoomPermissions(context.Background(), entries)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestCreateTelegramAllowlistEntryRejectsWhitespaceNames(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	err = store.CreateTelegramAllowlistEntry(ctx, "a1", "tg user", "validuser")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput for telegram username with whitespace, got %v", err)
	}

	err = store.CreateTelegramAllowlistEntry(ctx, "a2", "tg_user", "valid user")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput for kesher username with whitespace, got %v", err)
	}
}

func TestNewStoreMigratesLegacyTelegramUserMappingsSchema(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "legacy-telegram.sqlite")
	legacyDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	if _, err := legacyDB.ExecContext(ctx, `CREATE TABLE telegram_user_mappings (
		telegram_user_id TEXT NOT NULL UNIQUE,
		username TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`); err != nil {
		legacyDB.Close()
		t.Fatal(err)
	}
	if _, err := legacyDB.ExecContext(ctx, `INSERT INTO telegram_user_mappings (telegram_user_id, username, created_at) VALUES (?, ?, ?)`,
		"12345", "alice", int64(1710000000)); err != nil {
		legacyDB.Close()
		t.Fatal(err)
	}
	if err := legacyDB.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := NewStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	mapping, err := store.FindTelegramUserMappingByTelegramID(ctx, "12345")
	if err != nil {
		t.Fatalf("expected migrated mapping, got %v", err)
	}
	if mapping.ID != "telegram_user_12345" {
		t.Fatalf("unexpected migrated mapping id: %q", mapping.ID)
	}
	if mapping.Username != "alice" {
		t.Fatalf("unexpected migrated mapping username: %q", mapping.Username)
	}
	if mapping.PrivateChatID != "12345" {
		t.Fatalf("unexpected migrated private chat id: %q", mapping.PrivateChatID)
	}

	if err := store.CreateTelegramUserMapping(ctx, "telegram_user_67890", "67890", "bob", "1000"); err != nil {
		t.Fatalf("expected inserts to work after migration, got %v", err)
	}
	created, err := store.FindTelegramUserMappingByTelegramID(ctx, "67890")
	if err != nil {
		t.Fatalf("expected created mapping after migration, got %v", err)
	}
	if created.ID != "telegram_user_67890" {
		t.Fatalf("unexpected created mapping id: %q", created.ID)
	}
}

func TestUserStreamDeckSettingsRoundTrip(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	user, err := store.UpsertUser(ctx, "deckuser", "audio")
	if err != nil {
		t.Fatal(err)
	}

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Label = "Reply"
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}

	stored, err := store.UpsertUserStreamDeckSettings(ctx, user.ID, settings)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Pages[0].Buttons[0].Action == nil || stored.Pages[0].Buttons[0].Action.Type != StreamDeckActionTypeReplyToCaller {
		t.Fatalf("unexpected stored action: %+v", stored.Pages[0].Buttons[0].Action)
	}

	loaded, err := store.GetUserStreamDeckSettings(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Pages[0].Buttons[0].Label != "Reply" {
		t.Fatalf("expected label Reply, got %q", loaded.Pages[0].Buttons[0].Label)
	}
	if loaded.Pages[0].Buttons[0].Action == nil || loaded.Pages[0].Buttons[0].Action.Type != StreamDeckActionTypeReplyToCaller {
		t.Fatalf("unexpected loaded action: %+v", loaded.Pages[0].Buttons[0].Action)
	}
}

func TestDeleteUserStreamDeckSettings(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	user, err := store.UpsertUser(ctx, "deckdelete", "audio")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertUserStreamDeckSettings(ctx, user.ID, DefaultStreamDeckSettings()); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteUserStreamDeckSettings(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetUserStreamDeckSettings(ctx, user.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestUserStreamDeckSettingsAcceptsDirectRoleAction(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	user, err := store.UpsertUser(ctx, "deckrole", "audio")
	if err != nil {
		t.Fatal(err)
	}

	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[1].Action = &StreamDeckButtonAction{
		Type:   StreamDeckActionTypeDirectRole,
		RoleID: "video",
	}

	stored, err := store.UpsertUserStreamDeckSettings(ctx, user.ID, settings)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Pages[0].Buttons[1].Action == nil {
		t.Fatal("expected action to be stored")
	}
	if stored.Pages[0].Buttons[1].Action.Type != StreamDeckActionTypeDirectRole {
		t.Fatalf("unexpected action type: %s", stored.Pages[0].Buttons[1].Action.Type)
	}
	if stored.Pages[0].Buttons[1].Action.RoleID != "video" {
		t.Fatalf("unexpected role id: %q", stored.Pages[0].Buttons[1].Action.RoleID)
	}
}
