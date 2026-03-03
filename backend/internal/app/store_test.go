package app

import (
	"context"
	"errors"
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
