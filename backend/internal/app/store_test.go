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
