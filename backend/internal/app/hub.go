package app

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"time"
)

type client struct {
	session         Session
	user            User
	activeRoom      string
	listenRooms     map[string]struct{}
	talkRooms       map[string]struct{}
	voiceMode       string
	micEnabled      bool
	broadcastGroups map[string]struct{}
	send            chan WSOutbound
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
	if c.broadcastGroups == nil {
		c.broadcastGroups = make(map[string]struct{})
	}
	if c.listenRooms == nil {
		c.listenRooms = make(map[string]struct{})
	}
	if c.talkRooms == nil {
		c.talkRooms = make(map[string]struct{})
	}
	if len(c.listenRooms) == 0 && c.activeRoom != "" {
		c.listenRooms[c.activeRoom] = struct{}{}
	}
	if len(c.talkRooms) == 0 && c.activeRoom != "" {
		c.talkRooms[c.activeRoom] = struct{}{}
	}
	h.clients[c.session.Token] = c
	h.mu.Unlock()
	h.broadcastPresence()
}

func (h *Hub) SetBroadcastActive(token, groupID string, enabled bool) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		if c.broadcastGroups == nil {
			c.broadcastGroups = make(map[string]struct{})
		}
		if enabled {
			c.broadcastGroups[groupID] = struct{}{}
		} else {
			delete(c.broadcastGroups, groupID)
		}
	}
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

func (h *Hub) SetRoomMatrix(token string, listenRooms []string, talkRooms []string) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		c.listenRooms = toRoomSet(listenRooms)
		c.talkRooms = toRoomSet(talkRooms)
	}
	h.mu.Unlock()
	h.broadcastPresence()
}

func (h *Hub) roomSelections(token string) (listenRooms []string, talkRooms []string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[token]
	if !ok {
		return nil, nil
	}
	return roomSetToSortedSlice(c.listenRooms), roomSetToSortedSlice(c.talkRooms)
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
		_, receiverRoles, err := h.store.RoomRolePolicies(context.Background(), e.TargetID)
		if err != nil {
			h.logger.Warn("room routing failed", "targetId", e.TargetID, "error", err)
			return
		}
		h.sendToRoom(e.TargetID, receiverRoles, out)
	case "broadcast":
		rooms, err := h.store.BroadcastGroupRoomSet(context.Background(), e.TargetID)
		if err != nil {
			h.logger.Warn("broadcast group routing failed", "targetId", e.TargetID, "error", err)
			return
		}
		allowedRooms := make(map[string]struct{}, len(rooms))
		receiverRolesByRoom := make(map[string]map[string]struct{}, len(rooms))
		for roomID := range rooms {
			senderRoles, receiverRoles, err := h.store.RoomRolePolicies(context.Background(), roomID)
			if err != nil {
				continue
			}
			if !isRoleAllowed(senderRoles, sender.session.RoleID) {
				continue
			}
			allowedRooms[roomID] = struct{}{}
			receiverRolesByRoom[roomID] = receiverRoles
		}
		h.sendToRooms(allowedRooms, receiverRolesByRoom, out)
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

func (h *Hub) sendToRoom(roomID string, receiverRoles map[string]struct{}, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if _, ok := c.listenRooms[roomID]; ok {
			if !isRoleAllowed(receiverRoles, c.session.RoleID) {
				continue
			}
			select {
			case c.send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) sendToRooms(roomSet map[string]struct{}, receiverRolesByRoom map[string]map[string]struct{}, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		for roomID := range c.listenRooms {
			if _, ok := roomSet[roomID]; !ok {
				continue
			}
			if !isRoleAllowed(receiverRolesByRoom[roomID], c.session.RoleID) {
				continue
			}
			select {
			case c.send <- msg:
			default:
			}
			break
		}
	}
}

func (h *Hub) broadcastPresence() {
	h.mu.RLock()
	var list []PresenceState
	for _, c := range h.clients {
		list = append(list, PresenceState{
			UserID:          c.user.ID,
			Username:        c.user.Username,
			RoleID:          c.user.RoleID,
			ActiveRoom:      c.activeRoom,
			ListenRooms:     roomSetToSortedSlice(c.listenRooms),
			TalkRooms:       roomSetToSortedSlice(c.talkRooms),
			VoiceMode:       c.voiceMode,
			MicEnabled:      c.micEnabled,
			BroadcastActive: len(c.broadcastGroups) > 0,
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

func toRoomSet(roomIDs []string) map[string]struct{} {
	set := make(map[string]struct{}, len(roomIDs))
	for _, roomID := range roomIDs {
		if roomID == "" {
			continue
		}
		set[roomID] = struct{}{}
	}
	return set
}

func roomSetToSortedSlice(roomSet map[string]struct{}) []string {
	list := make([]string, 0, len(roomSet))
	for roomID := range roomSet {
		list = append(list, roomID)
	}
	slices.Sort(list)
	return list
}

func intersectsRoomSet(a map[string]struct{}, b map[string]struct{}) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	for roomID := range a {
		if _, ok := b[roomID]; ok {
			return true
		}
	}
	return false
}
