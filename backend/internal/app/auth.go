package app

import (
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type SessionManager struct {
	mu              sync.RWMutex
	sessions        map[string]Session
	ttl             time.Duration
	scheduledRevoke map[string]*time.Timer
}

func NewSessionManager(ttl time.Duration) *SessionManager {
	return &SessionManager{
		sessions:        make(map[string]Session),
		ttl:             ttl,
		scheduledRevoke: make(map[string]*time.Timer),
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
	if timer, ok := m.scheduledRevoke[token]; ok {
		timer.Stop()
		delete(m.scheduledRevoke, token)
	}
	delete(m.sessions, token)
}

func (m *SessionManager) ScheduleDisconnectLogout(token string, delay time.Duration) bool {
	if delay <= 0 {
		m.Delete(token)
		return true
	}

	m.mu.Lock()
	if _, ok := m.sessions[token]; !ok {
		m.mu.Unlock()
		return false
	}
	if timer, ok := m.scheduledRevoke[token]; ok {
		timer.Stop()
	}
	m.scheduledRevoke[token] = time.AfterFunc(delay, func() {
		m.Delete(token)
	})
	m.mu.Unlock()
	return true
}

func (m *SessionManager) CancelScheduledDisconnectLogout(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	timer, ok := m.scheduledRevoke[token]
	if !ok {
		return false
	}
	timer.Stop()
	delete(m.scheduledRevoke, token)
	return true
}

func (m *SessionManager) LatestForRole(roleID string) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	var selected Session
	var found bool
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		if session.RoleID != roleID {
			continue
		}
		if !found || session.ExpiresAt.After(selected.ExpiresAt) {
			selected = session
			found = true
		}
	}
	if !found {
		return Session{}, false
	}
	return selected, true
}

func (m *SessionManager) DeleteByRole(roleID string) []Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	deleted := make([]Session, 0)
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		if session.RoleID != roleID {
			continue
		}
		deleted = append(deleted, session)
		delete(m.sessions, token)
	}
	return deleted
}

func (m *SessionManager) DeleteByUsername(username string) []Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	username = strings.TrimSpace(username)
	now := time.Now()
	deleted := make([]Session, 0)
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(session.Username), username) {
			continue
		}
		deleted = append(deleted, session)
		delete(m.sessions, token)
	}
	return deleted
}
