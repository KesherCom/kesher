package app

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type client struct {
	session    Session
	user       User
	activeRoom string
	voiceMode  string
	micEnabled bool
	send       chan WSOutbound
}

type Hub struct {
	mu      sync.RWMutex
	clients map[string]*client
	store   *Store
	logger  *slog.Logger
	media   *MediaManager
}

func NewHub(store *Store, logger *slog.Logger) *Hub {
	return &Hub{
		clients: make(map[string]*client),
		store:   store,
		logger:  logger,
	}
}

func (h *Hub) SetMediaManager(m *MediaManager) {
	h.media = m
}

func (h *Hub) Add(c *client) {
	h.mu.Lock()
	h.clients[c.session.Token] = c
	h.mu.Unlock()
	h.broadcastPresence()
}

func (h *Hub) SetVoiceState(token, state string) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		switch state {
		case "always_on":
			c.voiceMode = "always_on"
			c.micEnabled = true
		case "ptt_start":
			c.voiceMode = "ptt"
			c.micEnabled = true
		case "ptt_stop":
			c.voiceMode = "ptt"
			c.micEnabled = false
		case "listen_only":
			c.voiceMode = "ptt"
			c.micEnabled = false
		}
	}
	h.mu.Unlock()
	h.broadcastPresence()
}

func (h *Hub) Remove(token string) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		close(c.send)
		delete(h.clients, token)
	}
	h.mu.Unlock()
	if h.media != nil {
		h.media.RemovePeer(token)
	}
	h.broadcastPresence()
}

func (h *Hub) SetActiveRoom(token, roomID string) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		c.activeRoom = roomID
	}
	h.mu.Unlock()
	h.broadcastPresence()
}

func (h *Hub) RouteEvent(senderToken string, eventType string, e RoutedEvent) {
	h.mu.RLock()
	sender, ok := h.clients[senderToken]
	h.mu.RUnlock()
	if !ok {
		return
	}
	e.FromUser = sender.user
	e.Timestamp = time.Now().UnixMilli()
	out := WSOutbound{Type: eventType, Data: e}

	switch e.Scope {
	case "direct":
		h.sendToUser(e.TargetID, out)
		h.sendToToken(senderToken, out)
	case "room":
		h.sendToRoom(e.TargetID, out)
	case "broadcast":
		rooms, err := h.store.BroadcastGroupRoomSet(context.Background(), e.TargetID)
		if err != nil {
			h.logger.Warn("broadcast group routing failed", "targetId", e.TargetID, "error", err)
			return
		}
		h.sendToRooms(rooms, out)
	default:
		h.logger.Warn("unsupported routing scope", "scope", e.Scope)
	}
}

func (h *Hub) sendToUser(userID string, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if c.user.ID == userID {
			select {
			case c.send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) sendToToken(token string, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[token]
	if !ok {
		return
	}
	select {
	case c.send <- msg:
	default:
	}
}

func (h *Hub) sendToRoom(roomID string, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if c.activeRoom == roomID {
			select {
			case c.send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) sendToRooms(roomSet map[string]struct{}, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if _, ok := roomSet[c.activeRoom]; ok {
			select {
			case c.send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) broadcastPresence() {
	h.mu.RLock()
	var list []PresenceState
	for _, c := range h.clients {
		list = append(list, PresenceState{
			UserID:     c.user.ID,
			Username:   c.user.Username,
			RoleID:     c.user.RoleID,
			ActiveRoom: c.activeRoom,
			VoiceMode:  c.voiceMode,
			MicEnabled: c.micEnabled,
		})
	}
	msg := WSOutbound{Type: "presence", Data: list}
	for _, c := range h.clients {
		select {
		case c.send <- msg:
		default:
		}
	}
	h.mu.RUnlock()
}
