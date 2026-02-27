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
	"sync"
	"time"
)

// TelegramBot handles receiving and sending Telegram messages.
type TelegramBot struct {
	token         string
	webhookSecret string
	mode          string // "polling" or "webhook"
	store         *Store
	hub           *Hub
	logger        *slog.Logger
	httpClient    *http.Client

	// polling state
	pollCancel context.CancelFunc
	pollWg     sync.WaitGroup
}

func NewTelegramBot(token, webhookSecret, mode string, store *Store, hub *Hub, logger *slog.Logger) *TelegramBot {
	if mode == "" {
		mode = "polling"
	}
	bot := &TelegramBot{
		token:         token,
		webhookSecret: webhookSecret,
		mode:          mode,
		store:         store,
		hub:           hub,
		logger:        logger,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
	hub.SetChatHook(bot.onChatEvent)
	return bot
}

// Mode returns the configured mode ("polling" or "webhook").
func (t *TelegramBot) Mode() string {
	return t.mode
}

// StartPolling begins long-polling the Telegram getUpdates API.
// This is suitable for servers behind NAT/firewall without a public IP.
func (t *TelegramBot) StartPolling() {
	if t.mode != "polling" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.pollCancel = cancel
	t.pollWg.Add(1)
	go t.pollLoop(ctx)
	t.logger.Info("telegram bot polling started")
}

// StopPolling gracefully stops the long-polling goroutine.
func (t *TelegramBot) StopPolling() {
	if t.pollCancel != nil {
		t.pollCancel()
		t.pollWg.Wait()
		t.logger.Info("telegram bot polling stopped")
	}
}

func (t *TelegramBot) pollLoop(ctx context.Context) {
	defer t.pollWg.Done()
	var offset int64
	// Use a longer timeout for long-polling so we hold a connection open,
	// reducing API calls. Telegram will respond immediately if new updates arrive.
	pollClient := &http.Client{Timeout: 35 * time.Second}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		updates, err := t.getUpdates(ctx, pollClient, offset)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			t.logger.Warn("telegram getUpdates error", "error", err)
			// back off on errors
			select {
			case <-time.After(3 * time.Second):
			case <-ctx.Done():
				return
			}
			continue
		}
		for _, upd := range updates {
			t.processUpdate(upd)
			if upd.UpdateID >= offset {
				offset = upd.UpdateID + 1
			}
		}
	}
}

func (t *TelegramBot) getUpdates(ctx context.Context, client *http.Client, offset int64) ([]TelegramUpdate, error) {
	url := fmt.Sprintf("https://api.telegram.org/bot%s/getUpdates?timeout=30&offset=%d", t.token, offset)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("telegram getUpdates error %d: %s", resp.StatusCode, string(body))
	}
	var result struct {
		OK     bool             `json:"ok"`
		Result []TelegramUpdate `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("telegram getUpdates returned ok=false")
	}
	return result.Result, nil
}

// processUpdate handles a single Telegram update (used by both polling and webhook).
func (t *TelegramBot) processUpdate(update TelegramUpdate) {
	if update.Message == nil || strings.TrimSpace(update.Message.Text) == "" {
		return
	}
	chatID := strconv.FormatInt(update.Message.Chat.ID, 10)
	mapping, err := t.store.FindTelegramMappingByChatID(context.Background(), chatID)
	if err != nil {
		t.logger.Info("telegram message from unmapped chat", "chatId", chatID)
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
}

// DeleteWebhook removes any previously set webhook so polling works cleanly.
func (t *TelegramBot) DeleteWebhook() error {
	url := fmt.Sprintf("https://api.telegram.org/bot%s/deleteWebhook", t.token)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	resp, err := t.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("telegram deleteWebhook error %d: %s", resp.StatusCode, string(body))
	}
	return nil
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
<<<<<<< HEAD
	t.processUpdate(update)
=======
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
>>>>>>> 61900f9330bcfa6a717b29b4fe59a880e93ad57a
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
