package app

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]Session
	ttl      time.Duration
}

func NewSessionManager(ttl time.Duration) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]Session),
		ttl:      ttl,
	}
}

func (m *SessionManager) Create(user User) Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	token := uuid.NewString()
	s := Session{
		Token:     token,
		UserID:    user.ID,
		Username:  user.Username,
		RoleID:    user.RoleID,
		ExpiresAt: time.Now().Add(m.ttl),
	}
	m.sessions[token] = s
	return s
}

func (m *SessionManager) Get(token string) (Session, bool) {
	m.mu.RLock()
	s, ok := m.sessions[token]
	m.mu.RUnlock()
	if !ok {
		return Session{}, false
	}
	if time.Now().After(s.ExpiresAt) {
		m.Delete(token)
		return Session{}, false
	}
	return s, true
}

func (m *SessionManager) Delete(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, token)
}
