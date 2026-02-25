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

func TestSessionManagerGetUnknownToken(t *testing.T) {
	m := NewSessionManager(time.Minute)
	if _, ok := m.Get("missing"); ok {
		t.Fatal("expected unknown token lookup to fail")
	}
}

func TestSessionManagerExpiredSessionIsRejectedAndRemoved(t *testing.T) {
	m := NewSessionManager(-1 * time.Second)
	user := User{ID: "u1", Username: "tim", RoleID: "audio"}
	session := m.Create(user)
	if _, ok := m.Get(session.Token); ok {
		t.Fatal("expected expired session to be rejected")
	}
	m.mu.RLock()
	_, exists := m.sessions[session.Token]
	m.mu.RUnlock()
	if exists {
		t.Fatal("expected expired session to be removed from store")
	}
}
