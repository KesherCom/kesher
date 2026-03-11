package app

import (
	"fmt"
	"sort"
	"sync"
)

type chatRing struct {
	entries []RoutedEvent
	next    int
	limit   int
}

func newChatRing(limit int) *chatRing {
	if limit <= 0 {
		limit = 1
	}
	return &chatRing{
		entries: make([]RoutedEvent, 0, limit),
		limit:   limit,
	}
}

func (r *chatRing) append(e RoutedEvent) {
	if len(r.entries) < r.limit {
		r.entries = append(r.entries, e)
		return
	}
	r.entries[r.next] = e
	r.next = (r.next + 1) % r.limit
}

func (r *chatRing) snapshot() []RoutedEvent {
	if len(r.entries) == 0 {
		return nil
	}
	if len(r.entries) < r.limit {
		out := make([]RoutedEvent, len(r.entries))
		copy(out, r.entries)
		return out
	}
	out := make([]RoutedEvent, 0, len(r.entries))
	out = append(out, r.entries[r.next:]...)
	out = append(out, r.entries[:r.next]...)
	return out
}

type ChatHistory struct {
	mu         sync.RWMutex
	limit      int
	roomEvents map[string]*chatRing
	userEvents map[string]*chatRing
}

func NewChatHistory(limit int) *ChatHistory {
	if limit <= 0 {
		limit = 1
	}
	return &ChatHistory{
		limit:      limit,
		roomEvents: make(map[string]*chatRing),
		userEvents: make(map[string]*chatRing),
	}
}

func (h *ChatHistory) AppendForRoom(roomID string, e RoutedEvent) {
	if roomID == "" {
		return
	}
	h.mu.Lock()
	ring, ok := h.roomEvents[roomID]
	if !ok {
		ring = newChatRing(h.limit)
		h.roomEvents[roomID] = ring
	}
	ring.append(e)
	h.mu.Unlock()
}

func (h *ChatHistory) AppendForUser(userID string, e RoutedEvent) {
	if userID == "" {
		return
	}
	h.mu.Lock()
	ring, ok := h.userEvents[userID]
	if !ok {
		ring = newChatRing(h.limit)
		h.userEvents[userID] = ring
	}
	ring.append(e)
	h.mu.Unlock()
}

func (h *ChatHistory) HistoryForRooms(roomIDs []string) []RoutedEvent {
	h.mu.RLock()
	merged := make([]RoutedEvent, 0)
	seen := make(map[string]struct{})
	for _, roomID := range uniqueNonEmpty(roomIDs) {
		ring, ok := h.roomEvents[roomID]
		if !ok {
			continue
		}
		for _, event := range ring.snapshot() {
			key := historyEventKey(event)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			merged = append(merged, event)
		}
	}
	h.mu.RUnlock()
	sortHistoryEvents(merged)
	return merged
}

func (h *ChatHistory) HistoryForUserAndRooms(userID string, roomIDs []string) []RoutedEvent {
	h.mu.RLock()
	merged := make([]RoutedEvent, 0)
	seen := make(map[string]struct{})
	for _, roomID := range uniqueNonEmpty(roomIDs) {
		ring, ok := h.roomEvents[roomID]
		if !ok {
			continue
		}
		for _, event := range ring.snapshot() {
			key := historyEventKey(event)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			merged = append(merged, event)
		}
	}
	if userID != "" {
		if ring, ok := h.userEvents[userID]; ok {
			for _, event := range ring.snapshot() {
				key := historyEventKey(event)
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				merged = append(merged, event)
			}
		}
	}
	h.mu.RUnlock()
	sortHistoryEvents(merged)
	return merged
}

func (h *ChatHistory) Clear() {
	h.mu.Lock()
	h.roomEvents = make(map[string]*chatRing)
	h.userEvents = make(map[string]*chatRing)
	h.mu.Unlock()
}

func sortHistoryEvents(events []RoutedEvent) {
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].Timestamp != events[j].Timestamp {
			return events[i].Timestamp < events[j].Timestamp
		}
		left := historyEventKey(events[i])
		right := historyEventKey(events[j])
		return left < right
	})
}

func historyEventKey(e RoutedEvent) string {
	return fmt.Sprintf(
		"%d|%s|%s|%s|%s|%s|%s",
		e.Timestamp,
		e.Scope,
		e.TargetType,
		e.TargetID,
		e.FromUser.ID,
		e.Signal,
		e.Body,
	)
}

func uniqueNonEmpty(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
