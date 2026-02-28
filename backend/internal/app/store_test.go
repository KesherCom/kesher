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

func TestBroadcastGroupAllowedRoleSetReturnsNotFoundForUnknownGroup(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	_, err = store.BroadcastGroupAllowedRoleSet(context.Background(), "does-not-exist")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestBroadcastGroupRoomSetErrorsForEmptyGroup(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO broadcast_groups (id,name) VALUES ('empty','Empty')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BroadcastGroupRoomSet(context.Background(), "empty"); err == nil {
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

	// Verify foh permissions via RoomRolePolicies
	fohSenders, fohReceivers, err := store.RoomRolePolicies(ctx, "foh")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := fohSenders["audio"]; !ok {
		t.Fatal("foh should have audio as sender")
	}
	if _, ok := fohSenders["video"]; !ok {
		t.Fatal("foh should have video as sender")
	}
	if len(fohSenders) != 2 {
		t.Fatalf("foh senders: expected 2 got %d", len(fohSenders))
	}
	if _, ok := fohReceivers["audio"]; !ok {
		t.Fatal("foh should have audio as receiver")
	}
	if _, ok := fohReceivers["lighting"]; !ok {
		t.Fatal("foh should have lighting as receiver")
	}
	if len(fohReceivers) != 2 {
		t.Fatalf("foh receivers: expected 2 got %d", len(fohReceivers))
	}

	// Verify stage permissions
	stageSenders, stageReceivers, err := store.RoomRolePolicies(ctx, "stage")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := stageSenders["lighting"]; !ok {
		t.Fatal("stage should have lighting as sender")
	}
	if len(stageSenders) != 1 {
		t.Fatalf("stage senders: expected 1 got %d", len(stageSenders))
	}
	if _, ok := stageReceivers["video"]; !ok {
		t.Fatal("stage should have video as receiver")
	}
	if _, ok := stageReceivers["lighting"]; !ok {
		t.Fatal("stage should have lighting as receiver")
	}
	if len(stageReceivers) != 2 {
		t.Fatalf("stage receivers: expected 2 got %d", len(stageReceivers))
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
