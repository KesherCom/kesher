package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// TelegramRoomMapping links one intercom room to one Telegram chat.
type TelegramRoomMapping struct {
	RoomID string
	ChatID string // Telegram chat ID as a string (may be negative for groups)
}

// ParseTelegramRoomMap parses the TELEGRAM_ROOM_MAP value.
// Format: "roomId1:chatId1,roomId2:chatId2"
// A leading minus sign in the chat ID (Telegram group chats) is handled
// correctly because the split uses the last colon in each pair.
func ParseTelegramRoomMap(s string) []TelegramRoomMapping {
	var out []TelegramRoomMapping
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		idx := strings.LastIndex(part, ":")
		if idx <= 0 {
			continue
		}
		roomID := strings.TrimSpace(part[:idx])
		chatID := strings.TrimSpace(part[idx+1:])
		if roomID == "" || chatID == "" {
			continue
		}
		out = append(out, TelegramRoomMapping{RoomID: roomID, ChatID: chatID})
	}
	return out
}

// TelegramBridge integrates a Telegram bot into the intercom hub using
// long-polling so the server never needs to be exposed to the internet.
type TelegramBridge struct {
	token        string
	botUsername  string
	mappings     []TelegramRoomMapping
	roomByChatID map[string]string // Telegram chatID → intercom roomID
	chatByRoomID map[string]string // intercom roomID → Telegram chatID
	hub          *Hub
	logger       *slog.Logger
	httpClient   *http.Client
}

// NewTelegramBridge creates a TelegramBridge.  It is a no-op when token is empty.
func NewTelegramBridge(token, botUsername string, mappings []TelegramRoomMapping, hub *Hub, logger *slog.Logger) *TelegramBridge {
	roomByChatID := make(map[string]string, len(mappings))
	chatByRoomID := make(map[string]string, len(mappings))
	for _, m := range mappings {
		roomByChatID[m.ChatID] = m.RoomID
		chatByRoomID[m.RoomID] = m.ChatID
	}
	return &TelegramBridge{
		token:        token,
		botUsername:  botUsername,
		mappings:     mappings,
		roomByChatID: roomByChatID,
		chatByRoomID: chatByRoomID,
		hub:          hub,
		logger:       logger,
		httpClient:   &http.Client{Timeout: 40 * time.Second},
	}
}

// apiURL returns the Telegram Bot API URL for the given method.
func (b *TelegramBridge) apiURL(method string) string {
	return fmt.Sprintf("https://api.telegram.org/bot%s/%s", b.token, method)
}

// tgUpdate is a minimal representation of a Telegram Update object.
type tgUpdate struct {
	UpdateID int        `json:"update_id"`
	Message  *tgMessage `json:"message"`
}

type tgMessage struct {
	Chat tgChat  `json:"chat"`
	From *tgUser `json:"from"`
	Text string  `json:"text"`
}

type tgChat struct {
	ID int64 `json:"id"`
}

type tgUser struct {
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
}

// getUpdates long-polls the Telegram Bot API for new updates.
func (b *TelegramBridge) getUpdates(ctx context.Context, offset int) ([]tgUpdate, error) {
	url := fmt.Sprintf("%s?offset=%d&timeout=30&allowed_updates=[\"message\"]",
		b.apiURL("getUpdates"), offset)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		OK     bool       `json:"ok"`
		Result []tgUpdate `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("telegram getUpdates returned ok=false")
	}
	return result.Result, nil
}

// sendMessage sends a text message to a Telegram chat.
func (b *TelegramBridge) sendMessage(ctx context.Context, chatID, text string) error {
	body, err := json.Marshal(map[string]string{"chat_id": chatID, "text": text})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.apiURL("sendMessage"),
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("telegram sendMessage returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// Run starts the Telegram bridge and blocks until ctx is cancelled.
// It spawns a goroutine that forwards intercom chat events to Telegram and
// polls Telegram for incoming messages to inject into the hub.
func (b *TelegramBridge) Run(ctx context.Context) {
	b.logger.Info("telegram bridge started", "rooms", len(b.mappings))

	// Subscribe to outbound chat events from the hub.
	chatCh, unsubscribe := b.hub.SubscribeChat()
	defer unsubscribe()

	// Goroutine: intercom chat → Telegram.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-chatCh:
				if !ok {
					return
				}
				if event.Scope != "room" {
					continue
				}
				chatID, mapped := b.chatByRoomID[event.TargetID]
				if !mapped {
					continue
				}
				// Avoid re-forwarding messages the bot itself injected.
				if event.FromUser.Username == b.botUsername {
					continue
				}
				text := "[" + event.FromUser.Username + "] " + event.Body
				sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				if err := b.sendMessage(sendCtx, chatID, text); err != nil {
					b.logger.Warn("telegram send failed", "chatId", chatID, "error", err)
				}
				cancel()
			}
		}
	}()

	// Long-poll Telegram and forward messages into the hub.
	offset := 0
	for {
		if ctx.Err() != nil {
			return
		}
		updates, err := b.getUpdates(ctx, offset)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			b.logger.Warn("telegram getUpdates error", "error", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
		for _, u := range updates {
			offset = u.UpdateID + 1
			if u.Message == nil || u.Message.Text == "" {
				continue
			}
			chatID := strconv.FormatInt(u.Message.Chat.ID, 10)
			roomID, ok := b.roomByChatID[chatID]
			if !ok {
				continue
			}
			sender := ""
			if u.Message.From != nil {
				sender = u.Message.From.Username
				if sender == "" {
					sender = u.Message.From.FirstName
				}
			}
			fromUser := User{Username: b.botUsername}
			b.hub.BroadcastChatToRoom(roomID, fromUser, fmt.Sprintf("[TG:%s] %s", sender, u.Message.Text))
		}
	}
}
