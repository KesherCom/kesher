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

func TestSessionManagerLatestForRole(t *testing.T) {
	m := NewSessionManager(time.Minute)
	first := m.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})
	time.Sleep(2 * time.Millisecond)
	second := m.Create(User{ID: "u2", Username: "sam", RoleID: "audio"})

	latest, ok := m.LatestForRole("audio")
	if !ok {
		t.Fatal("expected role conflict session")
	}
	if latest.Token != second.Token {
		t.Fatalf("expected latest token %s, got %s (first was %s)", second.Token, latest.Token, first.Token)
	}
}

func TestSessionManagerDeleteByRole(t *testing.T) {
	m := NewSessionManager(time.Minute)
	audio := m.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})
	video := m.Create(User{ID: "u2", Username: "vic", RoleID: "video"})

	deleted := m.DeleteByRole("audio")
	if len(deleted) != 1 || deleted[0].Token != audio.Token {
		t.Fatalf("unexpected deleted sessions: %+v", deleted)
	}
	if _, ok := m.Get(audio.Token); ok {
		t.Fatal("expected audio role session to be removed")
	}
	if _, ok := m.Get(video.Token); !ok {
		t.Fatal("expected other role session to remain")
	}
}

func TestSessionManagerDeleteByUsernameIgnoresCase(t *testing.T) {
	m := NewSessionManager(time.Minute)
	target := m.Create(User{ID: "u1", Username: "Lubo", RoleID: "audio"})
	other := m.Create(User{ID: "u2", Username: "Silas", RoleID: "lighting"})

	deleted := m.DeleteByUsername("lubo")
	if len(deleted) != 1 || deleted[0].Token != target.Token {
		t.Fatalf("unexpected deleted sessions: %+v", deleted)
	}
	if _, ok := m.Get(target.Token); ok {
		t.Fatal("expected matching username session to be removed")
	}
	if _, ok := m.Get(other.Token); !ok {
		t.Fatal("expected other username session to remain")
	}
}

func TestSessionManagerScheduleDisconnectLogoutDeletesAfterDelay(t *testing.T) {
	m := NewSessionManager(time.Minute)
	s := m.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})

	if ok := m.ScheduleDisconnectLogout(s.Token, 20*time.Millisecond); !ok {
		t.Fatal("expected schedule to succeed")
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok := m.Get(s.Token); ok {
		t.Fatal("expected session to be deleted after scheduled disconnect logout")
	}
}

func TestSessionManagerCancelScheduledDisconnectLogoutKeepsSession(t *testing.T) {
	m := NewSessionManager(time.Minute)
	s := m.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})

	if ok := m.ScheduleDisconnectLogout(s.Token, 80*time.Millisecond); !ok {
		t.Fatal("expected schedule to succeed")
	}
	if ok := m.CancelScheduledDisconnectLogout(s.Token); !ok {
		t.Fatal("expected cancel to succeed")
	}
	time.Sleep(120 * time.Millisecond)
	if _, ok := m.Get(s.Token); !ok {
		t.Fatal("expected session to remain after canceling scheduled disconnect logout")
	}
}

func TestSessionManagerScheduleDisconnectLogoutUnknownToken(t *testing.T) {
	m := NewSessionManager(time.Minute)
	if ok := m.ScheduleDisconnectLogout("missing", time.Second); ok {
		t.Fatal("expected schedule to fail for unknown token")
	}
}
