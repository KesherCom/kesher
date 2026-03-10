package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
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
	ctx := context.Background()

	// Handle inline queries (autocomplete for @bot <query>)
	if update.InlineQuery != nil {
		t.handleInlineQuery(ctx, update.InlineQuery)
		return
	}

	// Handle callback queries (button clicks)
	if update.CallbackQuery != nil {
		t.handleCallbackQuery(ctx, update.CallbackQuery)
		return
	}

	// Handle messages
	if update.Message == nil || strings.TrimSpace(update.Message.Text) == "" {
		return
	}

	chatID := strconv.FormatInt(update.Message.Chat.ID, 10)

	// Check if this is a login command in a private chat
	if update.Message.Chat.Type == "private" && strings.HasPrefix(strings.TrimSpace(update.Message.Text), "/login") {
		t.handleLoginCommand(ctx, update.Message, chatID)
		return
	}

	// Check if this is an online command in a private chat
	if update.Message.Chat.Type == "private" && strings.HasPrefix(strings.TrimSpace(update.Message.Text), "/online") {
		t.handleOnlineCommand(ctx, update.Message, chatID)
		return
	}

	// Check if this is a rooms command in a private chat
	if update.Message.Chat.Type == "private" && strings.HasPrefix(strings.TrimSpace(update.Message.Text), "/rooms") {
		t.handleRoomsCommand(ctx, update.Message, chatID)
		return
	}

	// For private chats, check if user is mapped and route as direct message
	if update.Message.Chat.Type == "private" {
		userMapping, err := t.store.FindTelegramUserMappingByTelegramID(ctx, strconv.FormatInt(update.Message.From.ID, 10))
		if err == nil {
			// User is mapped, route as direct message
			t.handleDirectMessage(ctx, update.Message, chatID, userMapping.Username)
			return
		}
		// User not mapped, inform them to use /login
		t.sendMessage(ctx, chatID, "Not logged in. Use /login <username> to link your Telegram account to Kesher.")
		return
	}

	// For group chats, handle as room-based message (existing behavior)
	mapping, err := t.store.FindTelegramMappingByChatID(ctx, chatID)
	if err != nil {
		t.logger.Info("telegram message from unmapped chat", "chatId", chatID)
		return
	}
	t.forwardMessageToRoom(ctx, update.Message, chatID, mapping.RoomID)
}

// handleLoginCommand processes the /login <username> command in private chats.
func (t *TelegramBot) handleLoginCommand(ctx context.Context, msg *TelegramMessage, chatID string) {
	if msg.From == nil {
		return
	}

	parts := strings.Fields(strings.TrimSpace(msg.Text))
	if len(parts) < 2 {
		t.sendMessage(ctx, chatID, "Usage: /login <username>")
		return
	}

	username := parts[1]

	// Verify the username exists in Kesher
	_, err := t.store.FindUserByUsername(ctx, username)
	if err != nil {
		t.logger.Warn("login attempt with non-existent user", "username", username)
		t.sendMessage(ctx, chatID, fmt.Sprintf("User '%s' not found.", username))
		return
	}

	// Create or update the mapping
	telegramUserID := strconv.FormatInt(msg.From.ID, 10)
	mappingID := fmt.Sprintf("telegram_user_%s", telegramUserID)

	// Try to find existing mapping
	existing, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err == nil {
		// Update existing mapping
		err := t.store.UpdateTelegramUserMapping(ctx, existing.ID, username)
		if err != nil {
			t.logger.Warn("failed to update telegram user mapping", "error", err)
			t.sendMessage(ctx, chatID, "Error updating mapping. Please try again.")
			return
		}
		t.logger.Info("telegram user remapped", "telegramUserID", telegramUserID, "username", username)
		t.sendMessage(ctx, chatID, fmt.Sprintf("Account updated: you are now logged in as %s", username))
	} else {
		// Create new mapping with the private chat ID
		err := t.store.CreateTelegramUserMapping(ctx, mappingID, telegramUserID, username, chatID)
		if err != nil {
			if err == ErrConflict {
				t.sendMessage(ctx, chatID, "This Telegram account is already linked to another Kesher user.")
			} else {
				t.logger.Warn("failed to create telegram user mapping", "error", err)
				t.sendMessage(ctx, chatID, "Error creating mapping. Please try again.")
			}
			return
		}
		t.logger.Info("telegram user mapped", "telegramUserID", telegramUserID, "username", username)
		t.sendMessage(ctx, chatID, fmt.Sprintf("Successfully logged in as %s. You can now receive direct messages.", username))
	}
}

// handleRoomsCommand processes the /rooms command in private chats.
// It displays an inline keyboard with all available rooms and their subscription status.
func (t *TelegramBot) handleRoomsCommand(ctx context.Context, msg *TelegramMessage, chatID string) {
	if msg.From == nil {
		return
	}

	telegramUserID := strconv.FormatInt(msg.From.ID, 10)

	// Verify the user is logged in (has a mapping)
	userMapping, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err != nil {
		t.sendMessage(ctx, chatID, "Not logged in. Use /login <username> to link your Telegram account to Kesher first.")
		return
	}

	// Get all available rooms
	rooms, err := t.store.ListRooms(ctx)
	if err != nil {
		t.logger.Warn("failed to list rooms", "error", err)
		t.sendMessage(ctx, chatID, "Error loading rooms. Please try again.")
		return
	}

	if len(rooms) == 0 {
		t.sendMessage(ctx, chatID, "No rooms available.")
		return
	}

	// Get the user's current subscriptions
	subscribedRoomIDs, err := t.store.GetTelegramUserRoomSubscriptions(ctx, telegramUserID)
	if err != nil {
		t.logger.Warn("failed to get room subscriptions", "error", err)
		t.sendMessage(ctx, chatID, "Error loading subscriptions. Please try again.")
		return
	}

	// Create a set for quick lookup
	subscribedSet := make(map[string]bool)
	for _, roomID := range subscribedRoomIDs {
		subscribedSet[roomID] = true
	}

	// Build inline keyboard
	var keyboard [][]TelegramInlineKeyboardButton
	for _, room := range rooms {
		icon := "🔴" // Not subscribed
		if subscribedSet[room.ID] {
			icon = "🟢" // Subscribed
		}
		buttonText := fmt.Sprintf("%s #%s", icon, room.Name)
		button := TelegramInlineKeyboardButton{
			Text:         buttonText,
			CallbackData: fmt.Sprintf("toggle_room:%s", room.ID),
		}
		// Add one button per row for better readability
		keyboard = append(keyboard, []TelegramInlineKeyboardButton{button})
	}

	// Send the message with inline keyboard
	text := fmt.Sprintf("Room subscriptions for %s:\n\n🟢 = Listening\n🔴 = Not listening\n\nTap a room to toggle:", userMapping.Username)
	if err := t.sendMessageWithKeyboard(ctx, chatID, text, keyboard); err != nil {
		t.logger.Warn("failed to send rooms keyboard", "error", err)
		t.sendMessage(ctx, chatID, "Error displaying rooms. Please try again.")
	}
}

// handleOnlineCommand processes the /online command in private chats.
// It returns a text list of all currently active users and their roles.
func (t *TelegramBot) handleOnlineCommand(ctx context.Context, msg *TelegramMessage, chatID string) {
	if msg.From == nil {
		return
	}

	telegramUserID := strconv.FormatInt(msg.From.ID, 10)

	// Verify the user is logged in (has a mapping)
	_, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err != nil {
		t.sendMessage(ctx, chatID, "Not logged in. Use /login <username> to link your Telegram account to Kesher first.")
		return
	}

	// Get active clients from the hub
	activeClients := t.hub.GetActiveClients(ctx)

	if len(activeClients) == 0 {
		t.sendMessage(ctx, chatID, "No users currently online.")
		return
	}

	// Build the response text
	var sb strings.Builder
	sb.WriteString("🟢 Currently online:\n\n")
	for _, client := range activeClients {
		if client.RoleName != "" {
			sb.WriteString(fmt.Sprintf("• %s [%s]\n", client.Username, client.RoleName))
		} else {
			sb.WriteString(fmt.Sprintf("• %s\n", client.Username))
		}
	}

	t.sendMessage(ctx, chatID, sb.String())
	t.logger.Info("telegram /online command processed", "chatID", chatID, "onlineCount", len(activeClients))
}

// handleInlineQuery processes inline queries with smart search and live message preview.
// Query format: "@botname target message..."
// - targetQuery: first word (fuzzy matched against usernames/roles)
// - messagePayload: rest of the string (the actual message to send)
func (t *TelegramBot) handleInlineQuery(ctx context.Context, query *TelegramInlineQuery) {
	if query.From == nil {
		return
	}

	telegramUserID := strconv.FormatInt(query.From.ID, 10)

	// Verify the user is logged in
	_, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err != nil {
		// User not logged in - return empty results with a helpful message
		emptyResult := TelegramInlineQueryResultArticle{
			Type:        "article",
			ID:          "not_logged_in",
			Title:       "Not logged in",
			Description: "Use /login <username> to link your account first",
			InputMessageContent: TelegramInputMessageContent{
				MessageText: "Not logged in. Use /login <username> to link your Telegram account to Kesher.",
			},
		}
		t.answerInlineQuery(ctx, query.ID, []TelegramInlineQueryResultArticle{emptyResult})
		return
	}

	// Get active clients from the hub
	activeClients := t.hub.GetActiveClients(ctx)

	if len(activeClients) == 0 {
		// No one online
		emptyResult := TelegramInlineQueryResultArticle{
			Type:        "article",
			ID:          "no_users_online",
			Title:       "No users online",
			Description: "No active users to send messages to",
			InputMessageContent: TelegramInputMessageContent{
				MessageText: "No users currently online.",
			},
		}
		t.answerInlineQuery(ctx, query.ID, []TelegramInlineQueryResultArticle{emptyResult})
		return
	}

	// Split query into targetQuery (first word) and messagePayload (rest)
	queryText := strings.TrimSpace(query.Query)
	parts := strings.SplitN(queryText, " ", 2)
	targetQuery := ""
	messagePayload := ""
	if len(parts) > 0 {
		targetQuery = parts[0]
	}
	if len(parts) > 1 {
		messagePayload = strings.TrimSpace(parts[1])
	}

	// Fuzzy match targetQuery against active clients
	matches := t.fuzzyMatchClients(targetQuery, activeClients)

	// Limit to top 10 matches for better UX
	maxResults := 10
	if len(matches) > maxResults {
		matches = matches[:maxResults]
	}

	// Build results based on state
	var results []TelegramInlineQueryResultArticle

	if len(matches) == 0 && targetQuery != "" {
		// No matches found
		noMatchResult := TelegramInlineQueryResultArticle{
			Type:        "article",
			ID:          "no_matches",
			Title:       "⚠️ No matching user/role found",
			Description: fmt.Sprintf("No users matching '%s'", targetQuery),
			InputMessageContent: TelegramInputMessageContent{
				MessageText: fmt.Sprintf("⚠️ No users found matching '%s'", targetQuery),
			},
		}
		results = []TelegramInlineQueryResultArticle{noMatchResult}
	} else if messagePayload == "" {
		// State 1: Typing Target (no message yet)
		for _, match := range matches {
			title := match.Username
			if match.RoleName != "" {
				title = fmt.Sprintf("%s [%s]", match.Username, match.RoleName)
			}

			result := TelegramInlineQueryResultArticle{
				Type:        "article",
				ID:          fmt.Sprintf("typing_%s", match.UserID),
				Title:       title,
				Description: "Keep typing your message...",
				InputMessageContent: TelegramInputMessageContent{
					MessageText: fmt.Sprintf("Continue typing to send a message to %s", title),
				},
			}
			results = append(results, result)
		}
	} else {
		// State 2: Message Ready (target + message)
		for _, match := range matches {
			title := match.Username
			if match.RoleName != "" {
				title = fmt.Sprintf("%s [%s]", match.Username, match.RoleName)
			}

			result := TelegramInlineQueryResultArticle{
				Type:        "article",
				ID:          fmt.Sprintf("send_%s_%d", match.UserID, time.Now().UnixNano()),
				Title:       fmt.Sprintf("✉️ Send to %s", title),
				Description: messagePayload,
				InputMessageContent: TelegramInputMessageContent{
					MessageText: fmt.Sprintf("@DM_%s %s", match.Username, messagePayload),
				},
			}
			results = append(results, result)
		}
	}

	t.answerInlineQuery(ctx, query.ID, results)
	t.logger.Info("telegram inline query processed",
		"query", query.Query,
		"targetQuery", targetQuery,
		"hasMessage", messagePayload != "",
		"matches", len(matches),
		"results", len(results))
}

// fuzzyMatchClients performs fuzzy matching on active clients based on username and role name.
// Returns matches sorted by relevance (best matches first).
func (t *TelegramBot) fuzzyMatchClients(query string, clients []ActiveClient) []ActiveClient {
	if query == "" {
		return clients
	}

	queryLower := strings.ToLower(query)
	type scoredMatch struct {
		client ActiveClient
		score  int
	}
	var scored []scoredMatch

	for _, client := range clients {
		score := 0
		usernameLower := strings.ToLower(client.Username)
		roleNameLower := strings.ToLower(client.RoleName)

		// Exact match (highest priority)
		if usernameLower == queryLower || roleNameLower == queryLower {
			score = 1000
		} else if strings.HasPrefix(usernameLower, queryLower) {
			// Username prefix match
			score = 500
		} else if strings.HasPrefix(roleNameLower, queryLower) {
			// Role name prefix match
			score = 400
		} else if strings.Contains(usernameLower, queryLower) {
			// Username contains query
			score = 300
		} else if strings.Contains(roleNameLower, queryLower) {
			// Role name contains query
			score = 200
		} else {
			// Fuzzy match: count matching characters in order
			score = fuzzyScore(queryLower, usernameLower)
			roleScore := fuzzyScore(queryLower, roleNameLower)
			if roleScore > score {
				score = roleScore
			}
		}

		if score > 0 {
			scored = append(scored, scoredMatch{client: client, score: score})
		}
	}

	// Sort by score (descending) then by username
	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		return scored[i].client.Username < scored[j].client.Username
	})

	// Extract clients
	matches := make([]ActiveClient, len(scored))
	for i, s := range scored {
		matches[i] = s.client
	}
	return matches
}

// fuzzyScore calculates a fuzzy matching score between query and target.
// Returns score based on how many characters from query appear in target in order.
func fuzzyScore(query, target string) int {
	if query == "" || target == "" {
		return 0
	}
	score := 0
	targetIdx := 0
	for _, ch := range query {
		found := false
		for targetIdx < len(target) {
			if rune(target[targetIdx]) == ch {
				score += 10
				found = true
				targetIdx++
				break
			}
			targetIdx++
		}
		if !found {
			break
		}
	}
	return score
}

// handleCallbackQuery processes callback queries from inline keyboard buttons.
func (t *TelegramBot) handleCallbackQuery(ctx context.Context, query *TelegramCallbackQuery) {
	// Answer the callback query immediately to remove the loading indicator
	if err := t.answerCallbackQuery(ctx, query.ID); err != nil {
		t.logger.Warn("failed to answer callback query", "error", err)
	}

	if query.From == nil || query.Message == nil {
		return
	}

	telegramUserID := strconv.FormatInt(query.From.ID, 10)
	chatID := strconv.FormatInt(query.Message.Chat.ID, 10)

	// Verify the user is logged in
	userMapping, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err != nil {
		t.logger.Warn("callback from unmapped telegram user", "telegramUserID", telegramUserID)
		return
	}

	// Parse the callback data (format: "toggle_room:room_id")
	if !strings.HasPrefix(query.Data, "toggle_room:") {
		t.logger.Warn("unknown callback data format", "data", query.Data)
		return
	}

	roomID := strings.TrimPrefix(query.Data, "toggle_room:")

	// Toggle the subscription
	isSubscribed, err := t.store.ToggleTelegramUserRoomSubscription(ctx, telegramUserID, roomID)
	if err != nil {
		t.logger.Warn("failed to toggle room subscription", "error", err, "telegramUserID", telegramUserID, "roomID", roomID)
		return
	}

	action := "unsubscribed from"
	if isSubscribed {
		action = "subscribed to"
	}
	t.logger.Info("telegram user toggled room subscription", "username", userMapping.Username, "roomID", roomID, "action", action)

	// Rebuild the keyboard with updated subscription states
	rooms, err := t.store.ListRooms(ctx)
	if err != nil {
		t.logger.Warn("failed to list rooms for keyboard update", "error", err)
		return
	}

	subscribedRoomIDs, err := t.store.GetTelegramUserRoomSubscriptions(ctx, telegramUserID)
	if err != nil {
		t.logger.Warn("failed to get room subscriptions for keyboard update", "error", err)
		return
	}

	subscribedSet := make(map[string]bool)
	for _, id := range subscribedRoomIDs {
		subscribedSet[id] = true
	}

	var keyboard [][]TelegramInlineKeyboardButton
	for _, room := range rooms {
		icon := "🔴"
		if subscribedSet[room.ID] {
			icon = "🟢"
		}
		buttonText := fmt.Sprintf("%s #%s", icon, room.Name)
		button := TelegramInlineKeyboardButton{
			Text:         buttonText,
			CallbackData: fmt.Sprintf("toggle_room:%s", room.ID),
		}
		keyboard = append(keyboard, []TelegramInlineKeyboardButton{button})
	}

	// Update the original message's keyboard
	if err := t.editMessageReplyMarkup(ctx, chatID, query.Message.MessageID, keyboard); err != nil {
		t.logger.Warn("failed to update keyboard", "error", err)
	}
}

// handleDirectMessage processes a message from a mapped user in a private chat.
// This handles both regular messages and messages sent via inline query (@DM_username message).
func (t *TelegramBot) handleDirectMessage(ctx context.Context, msg *TelegramMessage, chatID string, username string) {
	text := strings.TrimSpace(msg.Text)

	// Check if this is a direct message command from inline query (@DM_username message)
	if strings.HasPrefix(text, "@DM_") {
		parts := strings.SplitN(text, " ", 2)
		if len(parts) < 2 {
			t.sendMessage(ctx, chatID, "Invalid message format. Use inline query to send messages.")
			return
		}

		targetUsername := strings.TrimPrefix(parts[0], "@DM_")
		messageBody := parts[1]

		// Find the target user
		targetUser, err := t.store.FindUserByUsername(ctx, targetUsername)
		if err != nil {
			t.logger.Warn("target user not found for DM", "targetUsername", targetUsername, "error", err)
			t.sendMessage(ctx, chatID, fmt.Sprintf("User '%s' not found or offline.", targetUsername))
			return
		}

		// Find the sender's Kesher user info
		senderUser, err := t.store.FindUserByUsername(ctx, username)
		if err != nil {
			t.logger.Warn("sender user not found", "username", username, "error", err)
			t.sendMessage(ctx, chatID, "Your user account could not be found.")
			return
		}

		// Create and route the message through the hub
		routedEvent := RoutedEvent{
			Scope:      "direct",
			TargetType: "user",
			TargetID:   targetUser.ID,
			Body:       messageBody,
			Source:     "telegram",
			FromUser:   senderUser,
			Timestamp:  time.Now().UnixMilli(),
		}

		// Send via hub to all clients of the target user
		t.hub.SendChatToUser(targetUser.ID, routedEvent)

		// Confirm to sender
		t.sendMessage(ctx, chatID, fmt.Sprintf("✅ Message sent to %s: %s", targetUsername, messageBody))
		t.logger.Info("telegram direct message routed", "from", username, "to", targetUsername, "body", messageBody)
		return
	}

	// Regular message in private chat (not a DM command)
	t.logger.Info("telegram private message received", "chatId", chatID, "from", username, "text", text)
	t.sendMessage(ctx, chatID, "Use inline query (@botname target message) to send direct messages to other users.")
}

// forwardMessageToRoom forwards a message from a group chat to a Kesher room (original behavior).
func (t *TelegramBot) forwardMessageToRoom(ctx context.Context, msg *TelegramMessage, chatID string, roomID string) {
	senderName := "Telegram"
	if msg.From != nil {
		if msg.From.Username != "" {
			senderName = "@" + msg.From.Username
		} else if msg.From.FirstName != "" {
			senderName = msg.From.FirstName
		}
	}
	fromUser := User{
		ID:       "telegram:" + chatID,
		Username: senderName,
		RoleID:   "",
	}
	e := RoutedEvent{
		Scope:     "room",
		TargetID:  roomID,
		Body:      msg.Text,
		Source:    "telegram",
		FromUser:  fromUser,
		Timestamp: time.Now().UnixMilli(),
	}
	t.hub.SendChatToRoom(roomID, e)
	t.logger.Info("telegram message forwarded to room", "chatId", chatID, "room", roomID, "sender", senderName)
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
// It forwards the message to any Telegram chats mapped to the target room/user.
func (t *TelegramBot) onChatEvent(eventType string, e RoutedEvent) {
	if eventType != "chat" || e.TargetID == "" {
		return
	}

	ctx := context.Background()

	// Handle room-based messages
	if e.Scope == "room" {
		mappings, err := t.store.FindTelegramMappingsByRoomID(ctx, e.TargetID)
		if err != nil || len(mappings) == 0 {
			return
		}
		text := fmt.Sprintf("[%s] %s", e.FromUser.Username, e.Body)
		for _, m := range mappings {
			if err := t.sendMessage(ctx, m.ChatID, text); err != nil {
				t.logger.Warn("failed to forward chat to telegram", "chatId", m.ChatID, "error", err)
			}
		}
		return
	}

	// Handle direct messages to users
	if e.Scope == "direct" && e.TargetType == "user" {
		// Find the user by ID
		user, err := t.store.FindUserByID(ctx, e.TargetID)
		if err != nil {
			return
		}

		// Check if the user has a Telegram mapping
		userMapping, err := t.store.FindTelegramUserMappingByUsername(ctx, user.Username)
		if err != nil {
			// User doesn't have a Telegram mapping
			return
		}

		// Look up the private chat ID for this telegram user
		// For now, we'll use the FindTelegramChatIDForUser method (to be added to store)
		chatID, err := t.store.FindTelegramChatIDForTelegramUser(ctx, userMapping.TelegramUserID)
		if err != nil {
			t.logger.Warn("failed to find telegram chat for user", "username", user.Username, "error", err)
			return
		}

		text := fmt.Sprintf("DM from %s: %s", e.FromUser.Username, e.Body)
		if err := t.sendMessage(ctx, chatID, text); err != nil {
			t.logger.Warn("failed to send direct message via telegram", "chatId", chatID, "error", err)
		}
		return
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
	t.processUpdate(update)
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

func (t *TelegramBot) sendMessageWithKeyboard(ctx context.Context, chatID, text string, keyboard [][]TelegramInlineKeyboardButton) error {
	if t.token == "" {
		return fmt.Errorf("telegram bot token not configured")
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", t.token)
	payload := map[string]interface{}{
		"chat_id": chatID,
		"text":    text,
		"reply_markup": TelegramInlineKeyboardMarkup{
			InlineKeyboard: keyboard,
		},
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

func (t *TelegramBot) editMessageReplyMarkup(ctx context.Context, chatID string, messageID int64, keyboard [][]TelegramInlineKeyboardButton) error {
	if t.token == "" {
		return fmt.Errorf("telegram bot token not configured")
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/editMessageReplyMarkup", t.token)
	payload := map[string]interface{}{
		"chat_id":    chatID,
		"message_id": messageID,
		"reply_markup": TelegramInlineKeyboardMarkup{
			InlineKeyboard: keyboard,
		},
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

func (t *TelegramBot) answerCallbackQuery(ctx context.Context, callbackQueryID string) error {
	if t.token == "" {
		return fmt.Errorf("telegram bot token not configured")
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/answerCallbackQuery", t.token)
	payload := map[string]string{
		"callback_query_id": callbackQueryID,
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

func (t *TelegramBot) answerInlineQuery(ctx context.Context, inlineQueryID string, results []TelegramInlineQueryResultArticle) error {
	if t.token == "" {
		return fmt.Errorf("telegram bot token not configured")
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/answerInlineQuery", t.token)
	payload := map[string]interface{}{
		"inline_query_id": inlineQueryID,
		"results":         results,
		"cache_time":      10, // Cache results for 10 seconds
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
