package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// TelegramBot handles receiving and sending Telegram messages.
type TelegramBot struct {
	token         string
	webhookSecret string
	store         *Store
	hub           *Hub
	logger        *slog.Logger
	httpClient    *http.Client
}

func NewTelegramBot(token, webhookSecret string, store *Store, hub *Hub, logger *slog.Logger) *TelegramBot {
	bot := &TelegramBot{
		token:         token,
		webhookSecret: webhookSecret,
		store:         store,
		hub:           hub,
		logger:        logger,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
	hub.SetChatHook(bot.onChatEvent)
	return bot
}

// onChatEvent is called by the hub whenever a chat event is routed.
// It forwards the message to any Telegram chats mapped to the target room.
func (t *TelegramBot) onChatEvent(eventType string, e RoutedEvent) {
	if eventType != "chat" || e.Scope != "room" || e.TargetID == "" {
		return
	}
	mappings, err := t.store.FindTelegramMappingsByRoomID(context.Background(), e.TargetID)
	if err != nil || len(mappings) == 0 {
		return
	}
	text := fmt.Sprintf("[%s] %s", e.FromUser.Username, e.Body)
	for _, m := range mappings {
		if err := t.sendMessage(context.Background(), m.ChatID, text); err != nil {
			t.logger.Warn("failed to forward chat to telegram", "chatId", m.ChatID, "error", err)
		}
	}
}

// HandleWebhook processes incoming Telegram webhook updates.
func (t *TelegramBot) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if t.webhookSecret != "" {
		secret := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
		if secret != t.webhookSecret {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	var update TelegramUpdate
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if update.Message == nil || strings.TrimSpace(update.Message.Text) == "" {
		w.WriteHeader(http.StatusOK)
		return
	}
	chatID := strconv.FormatInt(update.Message.Chat.ID, 10)
	mapping, err := t.store.FindTelegramMappingByChatID(r.Context(), chatID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			t.logger.Info("telegram message from unmapped chat", "chatId", chatID)
			w.WriteHeader(http.StatusOK)
			return
		}
		t.logger.Error("failed to lookup telegram mapping", "chatId", chatID, "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	senderName := "Telegram"
	if update.Message.From != nil {
		if update.Message.From.Username != "" {
			senderName = "@" + update.Message.From.Username
		} else if update.Message.From.FirstName != "" {
			senderName = update.Message.From.FirstName
		}
	}
	fromUser := User{
		ID:       "telegram:" + chatID,
		Username: senderName,
		RoleID:   "",
	}
	e := RoutedEvent{
		Scope:     "room",
		TargetID:  mapping.RoomID,
		Body:      update.Message.Text,
		FromUser:  fromUser,
		Timestamp: time.Now().UnixMilli(),
	}
	t.hub.SendChatToRoom(mapping.RoomID, e)
	t.logger.Info("telegram message forwarded to room", "chatId", chatID, "room", mapping.RoomID, "sender", senderName)
	w.WriteHeader(http.StatusOK)
}

func (t *TelegramBot) sendMessage(ctx context.Context, chatID, text string) error {
	if t.token == "" {
		return fmt.Errorf("telegram bot token not configured")
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", t.token)
	payload := map[string]string{
		"chat_id": chatID,
		"text":    text,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := t.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("telegram API error %d: %s", resp.StatusCode, string(body))
	}
	return nil
}
