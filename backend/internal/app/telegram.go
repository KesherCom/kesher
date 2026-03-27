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

const telegramVirtualRoleID = "telegram"

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

	// Security: Check if user is on allowlist before processing any updates
	// Extract the sender from the update
	var sender *TelegramUser
	if update.Message != nil && update.Message.From != nil {
		sender = update.Message.From
	} else if update.CallbackQuery != nil && update.CallbackQuery.From != nil {
		sender = update.CallbackQuery.From
	} else if update.InlineQuery != nil && update.InlineQuery.From != nil {
		sender = update.InlineQuery.From
	}

	// If we can identify a sender, enforce allowlist
	if sender != nil {
		allowed, chatID := t.checkTelegramUserAllowed(ctx, sender)
		if !allowed {
			// Silently reject or send generic access denied message
			if chatID != "" {
				t.sendMessage(ctx, chatID, "🚫 Access Denied. Contact the system administrator.")
			}
			t.logger.Warn("telegram access denied: user not on allowlist",
				"telegramUsername", sender.Username,
				"telegramUserID", sender.ID)
			return
		}
	}

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
		t.sendMessage(ctx, chatID, "Not logged in. Use /login to link your Telegram account to Kesher.")
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

// checkTelegramUserAllowed verifies if a Telegram user is on the allowlist and implements TOFU (Trust On First Use).
// Returns (allowed, chatID) where chatID is the private chat ID for sending error messages.
func (t *TelegramBot) checkTelegramUserAllowed(ctx context.Context, user *TelegramUser) (bool, string) {
	numericID := strconv.FormatInt(user.ID, 10)
	username := user.Username

	// Try to find by numeric ID first (fast path for already bound users)
	entry, err := t.store.FindTelegramAllowlistEntryByNumericID(ctx, numericID)
	if err == nil {
		// User is bound and allowed
		return true, ""
	}

	// Try to find by username (case-insensitive)
	if username != "" {
		entry, err = t.store.FindTelegramAllowlistEntryByUsername(ctx, username)
		if err == nil {
			// User is on allowlist but not yet bound
			// Implement TOFU: bind the numeric ID now
			if entry.TelegramNumericID == "" {
				err = t.store.BindTelegramAllowlistEntryNumericID(ctx, username, numericID)
				if err != nil {
					t.logger.Warn("failed to bind telegram numeric ID (TOFU)", "username", username, "numericID", numericID, "error", err)
					// Continue anyway - user is still on allowlist
				} else {
					t.logger.Info("telegram numeric ID bound (TOFU)", "username", username, "numericID", numericID)
				}
			}
			return true, ""
		}
	}

	// User not on allowlist
	// If this is a private chat, return the chat ID for sending error message
	chatID := ""
	// Note: we don't have update.Message here, so caller must handle message sending
	return false, chatID
}

// handleLoginCommand processes the /login command in private chats.
// Automatically maps the user via Telegram username/ID to their pre-approved Kesher username.
// No username argument needed - just /login
func (t *TelegramBot) handleLoginCommand(ctx context.Context, msg *TelegramMessage, chatID string) {
	if msg.From == nil {
		return
	}

	telegramUserID := strconv.FormatInt(msg.From.ID, 10)
	telegramUsername := msg.From.Username

	if telegramUsername == "" {
		t.sendMessage(ctx, chatID, "❌ Your Telegram account must have a username (@username) to login.")
		return
	}

	// Step 1: Check if user is on the allowlist
	allowlistEntry, err := t.store.FindTelegramAllowlistEntryByUsername(ctx, telegramUsername)
	if err != nil {
		t.logger.Warn("login attempt by non-allowlisted user",
			"telegramUsername", telegramUsername,
			"telegramUserID", telegramUserID)
		t.sendMessage(ctx, chatID, "❌ Your Telegram account is not approved to use this bot. Contact the administrator.")
		return
	}

	kesherUsername := allowlistEntry.KesherUsername

	// Step 2: Verify the mapped Kesher username exists
	_, err = t.store.FindUserByUsername(ctx, kesherUsername)
	if err != nil {
		t.logger.Warn("allowlisted user mapped to non-existent kesher user",
			"telegramUsername", telegramUsername,
			"kesherUsername", kesherUsername)
		t.sendMessage(ctx, chatID, fmt.Sprintf("⚠️ Your approved account '%s' does not exist. Contact the administrator.", kesherUsername))
		return
	}

	// Step 3: Perform TOFU binding if this is the first login (numeric ID not yet bound)
	if !allowlistEntry.IsBound {
		err = t.store.BindTelegramAllowlistEntryNumericID(ctx, telegramUsername, telegramUserID)
		if err != nil && err != ErrNotFound {
			t.logger.Warn("failed to bind telegram numeric ID (TOFU)", "error", err)
			// Continue anyway - user is still on allowlist
		} else if err == nil {
			t.logger.Info("telegram numeric ID bound (TOFU)", "username", telegramUsername, "numericID", telegramUserID)
		}
	}

	// Step 4: Create or update the Kesher session mapping
	mappingID := fmt.Sprintf("telegram_user_%s", telegramUserID)

	// Try to find existing mapping
	existing, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err == nil {
		// Update existing mapping
		err := t.store.UpdateTelegramUserMapping(ctx, existing.ID, kesherUsername)
		if err != nil {
			t.logger.Warn("failed to update telegram user mapping", "error", err)
			t.sendMessage(ctx, chatID, "Error updating mapping. Please try again.")
			return
		}
		t.logger.Info("telegram user remapped", "telegramUserID", telegramUserID, "username", kesherUsername)
		t.sendMessage(ctx, chatID, fmt.Sprintf("✓ Welcome back! Logged in as %s", kesherUsername))
	} else {
		// Create new mapping with the private chat ID
		err := t.store.CreateTelegramUserMapping(ctx, mappingID, telegramUserID, kesherUsername, chatID)
		if err != nil {
			if err == ErrConflict {
				t.sendMessage(ctx, chatID, "❌ This Telegram account is already linked to another Kesher user.")
			} else {
				t.logger.Warn("failed to create telegram user mapping", "error", err)
				t.sendMessage(ctx, chatID, "Error creating mapping. Please try again.")
			}
			return
		}
		t.logger.Info("telegram user mapped", "telegramUserID", telegramUserID, "username", kesherUsername)
		t.sendMessage(ctx, chatID, fmt.Sprintf("✓ Successfully logged in as %s. You can now receive direct messages.", kesherUsername))
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
		t.sendMessage(ctx, chatID, "Not logged in. Use /login to link your Telegram account to Kesher first.")
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
		t.sendMessage(ctx, chatID, "Not logged in. Use /login to link your Telegram account to Kesher first.")
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

type inlineTarget struct {
	Kind        string // user|role|room
	ID          string
	Title       string
	SearchValue string
}

// handleInlineQuery processes inline queries with prefix-based routing modes:
// @ -> users/roles, # -> rooms, default -> active talk room.
func (t *TelegramBot) handleInlineQuery(ctx context.Context, query *TelegramInlineQuery) {
	if query.From == nil {
		return
	}

	telegramUserID := strconv.FormatInt(query.From.ID, 10)

	// Verify the user is logged in
	userMapping, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
	if err != nil {
		// User not logged in - return empty results with a helpful message
		emptyResult := TelegramInlineQueryResultArticle{
			Type:        "article",
			ID:          "not_logged_in",
			Title:       "Not logged in",
			Description: "Use /login to link your account first",
			InputMessageContent: TelegramInputMessageContent{
				MessageText: "Not logged in. Use /login to link your Telegram account to Kesher.",
			},
		}
		t.answerInlineQuery(ctx, query.ID, []TelegramInlineQueryResultArticle{emptyResult})
		return
	}

	queryText := strings.TrimSpace(query.Query)
	mode, targetQuery, messagePayload := parseInlineQueryMode(queryText)

	var targets []inlineTarget
	var noMatchTitle string

	switch mode {
	case "users_roles":
		targets = t.inlineTargetsForUsersAndRoles(ctx, userMapping.Username)
		targets = fuzzyMatchInlineTargets(targetQuery, targets)
		noMatchTitle = fmt.Sprintf("⚠️ No matching user/role found for '%s'", targetQuery)
	case "rooms":
		roomTargets := t.inlineTargetsForRooms(ctx)
		targets = fuzzyMatchInlineTargets(targetQuery, roomTargets)
		noMatchTitle = fmt.Sprintf("⚠️ No matching room found for '%s'", targetQuery)
	default:
		// In default mode, show active users for direct messaging
		userTargets := t.inlineTargetsForUsersAndRoles(ctx, userMapping.Username)
		targets = fuzzyMatchInlineTargets(queryText, userTargets)
		noMatchTitle = fmt.Sprintf("⚠️ No matching user found for '%s'", queryText)
		if len(targets) == 0 {
			// If no users match, show help prompt
			promptResult := TelegramInlineQueryResultArticle{
				Type:                "article",
				ID:                  "await_prefix",
				Title:               "Direct Message",
				Description:         "Start typing a user/role name or use @user, #room",
				InputMessageContent: TelegramInputMessageContent{MessageText: "Use @ for users/roles, # for rooms, or type a name for direct messages."},
			}
			t.answerInlineQuery(ctx, query.ID, []TelegramInlineQueryResultArticle{promptResult})
			return
		}
	}

	if len(targets) > 10 {
		targets = targets[:10]
	}

	results := make([]TelegramInlineQueryResultArticle, 0, len(targets))
	if len(targets) == 0 && targetQuery != "" && noMatchTitle != "" {
		results = append(results, TelegramInlineQueryResultArticle{
			Type:                "article",
			ID:                  "no_matches",
			Title:               noMatchTitle,
			Description:         "Try a different search",
			InputMessageContent: TelegramInputMessageContent{MessageText: noMatchTitle},
		})
	} else {
		for _, target := range targets {
			if strings.TrimSpace(messagePayload) == "" {
				results = append(results, TelegramInlineQueryResultArticle{
					Type:                "article",
					ID:                  fmt.Sprintf("typing_%s_%s", target.Kind, target.ID),
					Title:               target.Title,
					Description:         "Keep typing your message...",
					InputMessageContent: TelegramInputMessageContent{MessageText: fmt.Sprintf("Continue typing to send to %s", target.Title)},
				})
				continue
			}

			results = append(results, TelegramInlineQueryResultArticle{
				Type:        "article",
				ID:          fmt.Sprintf("send_%s_%s_%d", target.Kind, target.ID, time.Now().UnixNano()),
				Title:       fmt.Sprintf("✉️ Send to %s", target.Title),
				Description: messagePayload,
				InputMessageContent: TelegramInputMessageContent{
					MessageText: encodeInlineRouteCommand(target, messagePayload),
				},
			})
		}
	}

	t.answerInlineQuery(ctx, query.ID, results)
	t.logger.Info("telegram inline query processed",
		"query", query.Query,
		"mode", mode,
		"targetQuery", targetQuery,
		"hasMessage", strings.TrimSpace(messagePayload) != "",
		"matches", len(targets),
		"results", len(results))
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

func parseInlineQueryMode(queryText string) (mode string, targetQuery string, messagePayload string) {
	if queryText == "" {
		return "default", "", ""
	}
	words := strings.Fields(queryText)
	mode = "default"
	targetIndex := -1
	rawTarget := ""

	for i, w := range words {
		if len(w) == 0 {
			continue
		}
		if w[0] == '@' {
			mode = "users_roles"
			rawTarget = strings.TrimPrefix(w, "@")
			targetIndex = i
			break
		}
		if w[0] == '#' {
			mode = "rooms"
			rawTarget = strings.TrimPrefix(w, "#")
			targetIndex = i
			break
		}
	}

	if mode == "default" {
		return "default", "", ""
	}

	payloadParts := make([]string, 0, len(words)-1)
	for i, w := range words {
		if i == targetIndex {
			continue
		}
		payloadParts = append(payloadParts, w)
	}

	return mode, strings.TrimSpace(rawTarget), strings.TrimSpace(strings.Join(payloadParts, " "))
}

func (t *TelegramBot) inlineTargetsForUsersAndRoles(ctx context.Context, excludeUsername string) []inlineTarget {
	excludeUsername = strings.ToLower(strings.TrimSpace(excludeUsername))

	roleNameByID := make(map[string]string)
	roles, err := t.store.ListRoles(ctx)
	if err != nil {
		t.logger.Warn("failed to load roles for telegram inline targets", "error", err)
	} else {
		for _, role := range roles {
			roleNameByID[role.ID] = role.Name
		}
	}

	activeClients := t.hub.GetActiveClients(ctx)
	targets := make([]inlineTarget, 0, len(activeClients)*2)
	seenUsers := make(map[string]struct{})
	seenRoles := make(map[string]struct{})

	for _, client := range activeClients {
		usernameKey := strings.ToLower(strings.TrimSpace(client.Username))
		if usernameKey == "" {
			continue
		}
		if client.UserID != "" && usernameKey != excludeUsername {
			if _, ok := seenUsers[client.UserID]; !ok {
				title := client.Username
				searchValue := client.Username
				if client.RoleName != "" {
					title = fmt.Sprintf("%s [%s]", client.Username, client.RoleName)
					searchValue += " " + client.RoleName
				}
				targets = append(targets, inlineTarget{Kind: "user", ID: client.UserID, Title: title, SearchValue: searchValue})
				seenUsers[client.UserID] = struct{}{}
			}
		}
		if client.RoleID != "" {
			if _, ok := seenRoles[client.RoleID]; !ok {
				roleTitle := client.RoleName
				if roleTitle == "" {
					roleTitle = roleNameByID[client.RoleID]
				}
				if roleTitle == "" {
					roleTitle = client.RoleID
				}
				targets = append(targets, inlineTarget{Kind: "role", ID: client.RoleID, Title: "Role: " + roleTitle, SearchValue: roleTitle + " " + client.Username})
				seenRoles[client.RoleID] = struct{}{}
			}
		}
	}

	return targets
}

func (t *TelegramBot) inlineTargetsForRooms(ctx context.Context) []inlineTarget {
	rooms, err := t.store.ListRooms(ctx)
	if err != nil {
		return nil
	}
	targets := make([]inlineTarget, 0, len(rooms))
	for _, room := range rooms {
		targets = append(targets, inlineTarget{Kind: "room", ID: room.ID, Title: "#" + room.Name, SearchValue: room.Name + " " + room.ID})
	}
	return targets
}

func fuzzyMatchInlineTargets(query string, targets []inlineTarget) []inlineTarget {
	if strings.TrimSpace(query) == "" {
		return targets
	}
	queryLower := strings.ToLower(query)
	type scoredTarget struct {
		target inlineTarget
		score  int
	}
	scored := make([]scoredTarget, 0, len(targets))
	for _, target := range targets {
		score := inlineTargetMatchScore(queryLower, target)
		if score > 0 {
			scored = append(scored, scoredTarget{target: target, score: score})
		}
	}
	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		if inlineTargetKindRank(scored[i].target.Kind) != inlineTargetKindRank(scored[j].target.Kind) {
			return inlineTargetKindRank(scored[i].target.Kind) < inlineTargetKindRank(scored[j].target.Kind)
		}
		return scored[i].target.Title < scored[j].target.Title
	})
	out := make([]inlineTarget, 0, len(scored))
	for _, s := range scored {
		out = append(out, s.target)
	}
	return out
}

func inlineTargetPrimaryTerm(target inlineTarget) string {
	parts := strings.Fields(strings.ToLower(strings.TrimSpace(target.SearchValue)))
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

func inlineTargetKindRank(kind string) int {
	switch kind {
	case "user":
		return 0
	case "role":
		return 1
	case "room":
		return 2
	default:
		return 3
	}
}

func inlineTargetMatchScore(query string, target inlineTarget) int {
	search := strings.ToLower(strings.TrimSpace(target.SearchValue))
	primary := inlineTargetPrimaryTerm(target)
	kindBonus := 0
	switch target.Kind {
	case "user":
		kindBonus = 30
	case "role":
		kindBonus = 15
	}

	switch {
	case primary != "" && primary == query:
		return 1400 + kindBonus
	case search == query:
		return 1200 + kindBonus
	case primary != "" && strings.HasPrefix(primary, query):
		return 900 + kindBonus
	case strings.HasPrefix(search, query):
		return 700 + kindBonus
	case primary != "" && strings.Contains(primary, query):
		return 520 + kindBonus
	case strings.Contains(search, query):
		return 360 + kindBonus
	default:
		return fuzzyScore(query, search) + kindBonus
	}
}

func encodeInlineRouteCommand(target inlineTarget, messagePayload string) string {
	messagePayload = strings.TrimSpace(messagePayload)
	switch target.Kind {
	case "user":
		return fmt.Sprintf("/ksh_user:%s %s", target.ID, messagePayload)
	case "role":
		return fmt.Sprintf("/ksh_role:%s %s", target.ID, messagePayload)
	default:
		return fmt.Sprintf("/ksh_room:%s %s", target.ID, messagePayload)
	}
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

	// Handle inline-route commands inserted by inline query selection.
	if strings.HasPrefix(text, "/ksh_") {
		parts := strings.SplitN(text, " ", 2)
		if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
			t.sendMessage(ctx, chatID, "Please provide a message payload.")
			return
		}
		targetSpec := strings.TrimPrefix(parts[0], "/ksh_")
		messageBody := strings.TrimSpace(parts[1])

		senderUser, err := t.store.FindUserByUsername(ctx, username)
		if err != nil {
			t.logger.Warn("sender user not found", "username", username, "error", err)
			t.sendMessage(ctx, chatID, "Your user account could not be found.")
			return
		}

		targetParts := strings.SplitN(targetSpec, ":", 2)
		if len(targetParts) != 2 || targetParts[1] == "" {
			t.sendMessage(ctx, chatID, "Invalid inline target.")
			return
		}

		targetType := targetParts[0]
		targetID := targetParts[1]

		e := RoutedEvent{
			Body:      messageBody,
			Source:    "telegram",
			FromUser:  senderUser,
			Timestamp: time.Now().UnixMilli(),
		}
		e.FromUser.RoleID = telegramVirtualRoleID

		switch targetType {
		case "user":
			e.Scope = "direct"
			e.TargetType = "user"
			e.TargetID = targetID
			t.hub.SendChatToUser(targetID, e)
			t.sendMessage(ctx, chatID, "✅ Message sent.")
			return
		case "role":
			e.Scope = "direct"
			e.TargetType = "role"
			e.TargetID = targetID
			t.hub.SendChatToRole(targetID, e)
			t.sendMessage(ctx, chatID, "✅ Message sent.")
			return
		case "room":
			e.Scope = "room"
			e.TargetID = targetID
			t.hub.SendChatToRoom(targetID, e)
			t.sendMessage(ctx, chatID, "✅ Message sent.")
			return
		default:
			t.sendMessage(ctx, chatID, "Unknown inline target.")
			return
		}
	}

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
		routedEvent.FromUser.RoleID = telegramVirtualRoleID

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
		RoleID:   telegramVirtualRoleID,
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

	t.logger.Debug("telegram onChatEvent received", "scope", e.Scope, "targetType", e.TargetType, "targetID", e.TargetID, "from", e.FromUser.Username)

	// Handle room-based messages
	if e.Scope == "room" {
		// Get all telegram users subscribed to this room
		subscribedUserIDs, err := t.store.GetSubscribedTelegramUsersForRoom(ctx, e.TargetID)
		if err != nil || len(subscribedUserIDs) == 0 {
			return
		}

		text := fmt.Sprintf("[%s] %s", e.FromUser.Username, e.Body)

		// For each subscribed telegram user, find their chat mapping and send the message
		for _, telegramUserID := range subscribedUserIDs {
			// Get the user mapping for this telegram user
			userMapping, err := t.store.FindTelegramUserMappingByTelegramID(ctx, telegramUserID)
			if err != nil {
				// User mapping not found, skip
				continue
			}

			if userMapping.PrivateChatID == "" {
				continue
			}

			if err := t.sendMessage(ctx, userMapping.PrivateChatID, text); err != nil {
				t.logger.Warn("failed to forward chat to telegram", "chatId", userMapping.PrivateChatID, "error", err)
			}
		}
		return
	}

	// Handle direct messages to users
	if e.Scope == "direct" && e.TargetType == "user" {
		// Find the user by ID
		user, err := t.store.FindUserByID(ctx, e.TargetID)
		if err != nil {
			t.logger.Debug("telegram user not found for direct message", "targetID", e.TargetID, "error", err)
			return
		}

		// Check if the user has a Telegram mapping
		userMapping, err := t.store.FindTelegramUserMappingByUsername(ctx, user.Username)
		if err != nil {
			// User doesn't have a Telegram mapping
			t.logger.Debug("telegram user mapping not found", "username", user.Username, "error", err)
			return
		}

		// Use the private chat ID from the mapping
		chatID := userMapping.PrivateChatID
		if chatID == "" {
			t.logger.Warn("telegram user mapping has no private chat ID", "username", user.Username)
			return
		}

		text := fmt.Sprintf("DM from %s: %s", e.FromUser.Username, e.Body)
		t.logger.Debug("sending direct message to telegram", "username", user.Username, "chatID", chatID, "text", text)
		if err := t.sendMessage(ctx, chatID, text); err != nil {
			t.logger.Warn("failed to send direct message via telegram", "chatId", chatID, "error", err)
		}
		return
	}

	// Handle direct messages to roles
	if e.Scope == "direct" && e.TargetType == "role" {
		// Get all active clients
		allClients := t.hub.GetActiveClients(ctx)

		// Filter clients that belong to this role
		var roleUsers []ActiveClient
		for _, client := range allClients {
			if client.RoleID == e.TargetID {
				roleUsers = append(roleUsers, client)
			}
		}

		if len(roleUsers) == 0 {
			return
		}

		text := fmt.Sprintf("DM to %s from %s: %s", e.TargetID, e.FromUser.Username, e.Body)
		for _, roleUser := range roleUsers {
			// Check if each user has a Telegram mapping
			userMapping, err := t.store.FindTelegramUserMappingByUsername(ctx, roleUser.Username)
			if err != nil {
				// User doesn't have a Telegram mapping, skip
				continue
			}

			// Use the private chat ID from the mapping
			chatID := userMapping.PrivateChatID
			if chatID == "" {
				continue
			}

			if err := t.sendMessage(ctx, chatID, text); err != nil {
				t.logger.Warn("failed to send role DM via telegram", "chatId", chatID, "roleID", e.TargetID, "error", err)
			}
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
