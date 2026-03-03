package app

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

type client struct {
	session         Session
	user            User
	connectedAt     time.Time
	lastDirectFrom  string
	lastDirectName  string
	signalFrom      string
	signalMessage   string
	signalUntil     time.Time
	activeRoom      string
	listenRooms     map[string]struct{}
	talkRooms       map[string]struct{}
	voiceMode       string
	micEnabled      bool
	broadcastGroups map[string]struct{}
	send            chan WSOutbound
	sendPriority    chan WSOutbound
}

const incomingSignalAttentionWindow = 2200 * time.Millisecond
const presenceBroadcastDebounce = 75 * time.Millisecond

type HubRealtimeStats struct {
	ConnectedClients         int               `json:"connectedClients"`
	NormalQueueDepthTotal    int               `json:"normalQueueDepthTotal"`
	NormalQueueDepthMax      int               `json:"normalQueueDepthMax"`
	PriorityQueueDepthTotal  int               `json:"priorityQueueDepthTotal"`
	PriorityQueueDepthMax    int               `json:"priorityQueueDepthMax"`
	DroppedCriticalMessages  uint64            `json:"droppedCriticalMessages"`
	DroppedNormalMessages    uint64            `json:"droppedNormalMessages"`
	DroppedMessagesByType    map[string]uint64 `json:"droppedMessagesByType"`
	PresenceBroadcasts       uint64            `json:"presenceBroadcasts"`
	PresenceBroadcastsMerged uint64            `json:"presenceBroadcastsMerged"`
}

func (h *Hub) ReplyTargetForUsername(username string) (string, string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var selected *client
	for _, c := range h.clients {
		if c.user.Username != username {
			continue
		}
		if selected == nil || c.connectedAt.After(selected.connectedAt) {
			selected = c
		}
	}
	if selected == nil || selected.lastDirectFrom == "" {
		return "", "", false
	}
	return selected.lastDirectFrom, selected.lastDirectName, true
}

func (h *Hub) SignalStateForUsername(username string) (string, string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var selected *client
	for _, c := range h.clients {
		if c.user.Username != username {
			continue
		}
		if selected == nil || c.connectedAt.After(selected.connectedAt) {
			selected = c
		}
	}
	if selected == nil || time.Now().After(selected.signalUntil) || selected.signalFrom == "" {
		return "", "", false
	}
	return selected.signalFrom, selected.signalMessage, true
}

type Hub struct {
	mu                  sync.RWMutex
	clients             map[string]*client
	store               *Store
	logger              *slog.Logger
	media               *MediaManager
	presenceSubscribers map[chan []PresenceState]struct{}
	chatHook            func(eventType string, e RoutedEvent)
	presenceCoalesceMu  sync.Mutex
	presencePending     bool
	droppedCritical     atomic.Uint64
	droppedNormal       atomic.Uint64
	presenceBroadcasts  atomic.Uint64
	presenceMerged      atomic.Uint64
	droppedByTypeMu     sync.Mutex
	droppedByType       map[string]uint64
}

func NewHub(store *Store, logger *slog.Logger) *Hub {
	return &Hub{
		clients:             make(map[string]*client),
		store:               store,
		logger:              logger,
		presenceSubscribers: make(map[chan []PresenceState]struct{}),
		droppedByType:       make(map[string]uint64),
	}
}

func isCriticalOutboundType(msgType string) bool {
	switch msgType {
	case "webrtc_offer", "webrtc_ice_candidate", "voice_state", "signal", "companion_command":
		return true
	default:
		return false
	}
}

func (h *Hub) recordDroppedMessage(msgType string, critical bool) {
	if critical {
		h.droppedCritical.Add(1)
	} else {
		h.droppedNormal.Add(1)
	}
	key := msgType
	if critical {
		key = "critical:" + msgType
	}
	h.droppedByTypeMu.Lock()
	h.droppedByType[key]++
	h.droppedByTypeMu.Unlock()
}

func (h *Hub) enqueueOutbound(c *client, msg WSOutbound) bool {
	critical := isCriticalOutboundType(msg.Type)
	var ch chan WSOutbound
	if critical && c.sendPriority != nil {
		ch = c.sendPriority
	} else if c.send != nil {
		ch = c.send
	} else {
		ch = c.sendPriority
	}
	if ch == nil {
		return false
	}
	select {
	case ch <- msg:
		return true
	default:
		h.recordDroppedMessage(msg.Type, critical)
		return false
	}
}

func (h *Hub) requestPresenceBroadcast() {
	h.presenceCoalesceMu.Lock()
	if h.presencePending {
		h.presenceMerged.Add(1)
		h.presenceCoalesceMu.Unlock()
		return
	}
	h.presencePending = true
	h.presenceCoalesceMu.Unlock()
	time.AfterFunc(presenceBroadcastDebounce, func() {
		h.presenceCoalesceMu.Lock()
		h.presencePending = false
		h.presenceCoalesceMu.Unlock()
		h.broadcastPresence()
	})
}

func (h *Hub) RealtimeStats() HubRealtimeStats {
	h.mu.RLock()
	stats := HubRealtimeStats{
		ConnectedClients: len(h.clients),
	}
	for _, c := range h.clients {
		if c.send != nil {
			depth := len(c.send)
			stats.NormalQueueDepthTotal += depth
			if depth > stats.NormalQueueDepthMax {
				stats.NormalQueueDepthMax = depth
			}
		}
		if c.sendPriority != nil {
			depth := len(c.sendPriority)
			stats.PriorityQueueDepthTotal += depth
			if depth > stats.PriorityQueueDepthMax {
				stats.PriorityQueueDepthMax = depth
			}
		}
	}
	h.mu.RUnlock()

	stats.DroppedCriticalMessages = h.droppedCritical.Load()
	stats.DroppedNormalMessages = h.droppedNormal.Load()
	stats.PresenceBroadcasts = h.presenceBroadcasts.Load()
	stats.PresenceBroadcastsMerged = h.presenceMerged.Load()
	h.droppedByTypeMu.Lock()
	stats.DroppedMessagesByType = make(map[string]uint64, len(h.droppedByType))
	for key, count := range h.droppedByType {
		stats.DroppedMessagesByType[key] = count
	}
	h.droppedByTypeMu.Unlock()
	return stats
}

func (h *Hub) RoomListenerCounts() map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	counts := make(map[string]int)
	for _, c := range h.clients {
		for roomID := range c.listenRooms {
			counts[roomID]++
		}
	}
	return counts
}

func (h *Hub) markDirectSignalIncoming(targetUserID string, fromUser User, signal string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if c.user.ID != targetUserID || c.user.ID == fromUser.ID {
			continue
		}
		c.signalFrom = fromUser.Username
		c.signalMessage = signal
		c.signalUntil = time.Now().Add(incomingSignalAttentionWindow)
	}
}

func (h *Hub) roomNameByID(roomID string) string {
	rooms, err := h.store.ListRooms(context.Background())
	if err != nil {
		return ""
	}
	for _, room := range rooms {
		if room.ID == roomID {
			return room.Name
		}
	}
	return ""
}

func (h *Hub) markRoomSignalIncoming(roomID string, receiverRoles map[string]struct{}, fromUser User, signal string) {
	if signal != "call" {
		return
	}
	signalFrom := fromUser.Username
	if roomName := h.roomNameByID(roomID); roomName != "" {
		signalFrom = fromUser.Username + " (" + roomName + ")"
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if c.user.ID == fromUser.ID {
			continue
		}
		if _, ok := c.listenRooms[roomID]; !ok {
			continue
		}
		if !isRoleAllowed(receiverRoles, c.session.RoleID) {
			continue
		}
		c.signalFrom = signalFrom
		c.signalMessage = signal
		c.signalUntil = time.Now().Add(incomingSignalAttentionWindow)
	}
}

func (h *Hub) SetMediaManager(m *MediaManager) {
	h.media = m
}

func (h *Hub) SetChatHook(fn func(eventType string, e RoutedEvent)) {
	h.mu.Lock()
	h.chatHook = fn
	h.mu.Unlock()
}

func (h *Hub) SendChatToRoom(roomID string, e RoutedEvent) {
	msg := WSOutbound{Type: "chat", Data: e}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if _, ok := c.listenRooms[roomID]; ok {
			h.enqueueOutbound(c, msg)
		}
	}
}

func (h *Hub) Add(c *client) {
	h.mu.Lock()
	c.connectedAt = time.Now()
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
	h.requestPresenceBroadcast()
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
	h.requestPresenceBroadcast()
}

func (h *Hub) Remove(token string) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		if c.send != nil {
			close(c.send)
		}
		if c.sendPriority != nil && c.sendPriority != c.send {
			close(c.sendPriority)
		}
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
	h.requestPresenceBroadcast()
}

func (h *Hub) SetRoomMatrix(token string, listenRooms []string, talkRooms []string) {
	h.mu.Lock()
	if c, ok := h.clients[token]; ok {
		c.listenRooms = toRoomSet(listenRooms)
		c.talkRooms = toRoomSet(talkRooms)
	}
	h.mu.Unlock()
	h.requestPresenceBroadcast()
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
		if eventType == "signal" {
			h.markDirectSignalIncoming(e.TargetID, sender.user, e.Signal)
		}
		if eventType == "voice_state" && e.Body == "ptt_start" {
			h.mu.Lock()
			for _, c := range h.clients {
				if c.user.ID == e.TargetID {
					c.lastDirectFrom = sender.user.ID
					c.lastDirectName = sender.user.Username
				}
			}
			h.mu.Unlock()
		}
		h.sendToUser(e.TargetID, out)
		h.sendToToken(senderToken, out)
	case "room":
		_, receiverRoles, err := h.store.RoomRolePolicies(context.Background(), e.TargetID)
		if err != nil {
			h.logger.Warn("room routing failed", "targetId", e.TargetID, "error", err)
			return
		}
		if eventType == "signal" {
			h.markRoomSignalIncoming(e.TargetID, receiverRoles, sender.user, e.Signal)
		}
		h.sendToRoom(e.TargetID, receiverRoles, out)
	case "broadcast":
		allowedRoles, err := h.store.BroadcastGroupAllowedRoleSet(context.Background(), e.TargetID)
		if err != nil || !isRoleAllowed(allowedRoles, sender.session.RoleID) {
			h.logger.Warn("broadcast group role check failed", "targetId", e.TargetID, "error", err)
			return
		}
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

	if eventType == "chat" {
		h.mu.RLock()
		hook := h.chatHook
		h.mu.RUnlock()
		if hook != nil {
			hook(eventType, e)
		}
	}
}

func (h *Hub) sendToUser(userID string, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if c.user.ID == userID {
			h.enqueueOutbound(c, msg)
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
	h.enqueueOutbound(c, msg)
}

func (h *Hub) sendToRoom(roomID string, receiverRoles map[string]struct{}, msg WSOutbound) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if _, ok := c.listenRooms[roomID]; ok {
			if !isRoleAllowed(receiverRoles, c.session.RoleID) {
				continue
			}
			h.enqueueOutbound(c, msg)
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
			h.enqueueOutbound(c, msg)
			break
		}
	}
}

func (h *Hub) LatestTokenForUsername(username string) (string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var selectedToken string
	var selectedAt time.Time
	for token, c := range h.clients {
		if c.user.Username != username {
			continue
		}
		if selectedToken == "" || c.connectedAt.After(selectedAt) {
			selectedToken = token
			selectedAt = c.connectedAt
		}
	}
	if selectedToken == "" {
		return "", false
	}
	return selectedToken, true
}

func (h *Hub) PresenceForUsername(username string) (PresenceState, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var selected *client
	for _, c := range h.clients {
		if c.user.Username != username {
			continue
		}
		if selected == nil || c.connectedAt.After(selected.connectedAt) {
			selected = c
		}
	}
	if selected == nil {
		return PresenceState{}, false
	}
	return PresenceState{
		UserID:          selected.user.ID,
		Username:        selected.user.Username,
		RoleID:          selected.user.RoleID,
		ActiveRoom:      selected.activeRoom,
		ListenRooms:     roomSetToSortedSlice(selected.listenRooms),
		TalkRooms:       roomSetToSortedSlice(selected.talkRooms),
		VoiceMode:       selected.voiceMode,
		MicEnabled:      selected.micEnabled,
		BroadcastActive: len(selected.broadcastGroups) > 0,
	}, true
}

func (h *Hub) SendToToken(token string, msg WSOutbound) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[token]
	if !ok {
		return false
	}
	return h.enqueueOutbound(c, msg)
}

func (h *Hub) SubscribePresence() (chan []PresenceState, func()) {
	ch := make(chan []PresenceState, 8)
	h.mu.Lock()
	h.presenceSubscribers[ch] = struct{}{}
	h.mu.Unlock()
	unsubscribe := func() {
		h.mu.Lock()
		if _, ok := h.presenceSubscribers[ch]; ok {
			delete(h.presenceSubscribers, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
	return ch, unsubscribe
}
func (h *Hub) broadcastPresence() {
	h.presenceBroadcasts.Add(1)
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
	subscribers := make([]chan []PresenceState, 0, len(h.presenceSubscribers))
	for ch := range h.presenceSubscribers {
		subscribers = append(subscribers, ch)
	}
	for _, c := range h.clients {
		h.enqueueOutbound(c, msg)
	}
	h.mu.RUnlock()
	for _, ch := range subscribers {
		select {
		case ch <- list:
		default:
		}
	}
}

func (h *Hub) BroadcastConfigUpdate(data PublicBootstrapResponse) {
	msg := WSOutbound{Type: "config_updated", Data: data}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		h.enqueueOutbound(c, msg)
	}
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
