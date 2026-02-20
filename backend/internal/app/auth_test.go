package app

import (
	"testing"
	"time"
)

func TestSessionManagerCreateGetDelete(t *testing.T) {
	m := NewSessionManager(2 * time.Minute)
	user := User{ID: "u1", Username: "tim", RoleID: "audio"}
	session := m.Create(user)
	if session.Token == "" {
		t.Fatal("expected non-empty token")
	}
	got, ok := m.Get(session.Token)
	if !ok {
		t.Fatal("expected session to exist")
	}
	if got.UserID != user.ID {
		t.Fatalf("unexpected user id: %s", got.UserID)
	}
	m.Delete(session.Token)
	if _, ok := m.Get(session.Token); ok {
		t.Fatal("expected session to be deleted")
	}
}
