package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fogleman/gg"
	"github.com/golang/freetype/truetype"
	"github.com/gorilla/websocket"
	"golang.org/x/image/font"
)

// Button images are pushed when something changes. The periodic refresh is
// only a safety net (and resolves a deck that connected before it was
// known), so it runs rarely once the target is resolved.
const (
	imageStreamResolveInterval = 2 * time.Second
	imageStreamRefreshInterval = 15 * time.Second
)

// buttonImageCacheSize bounds the rendered-image cache per renderer. A deck
// page has 15 keys with a few states each; 512 covers many decks and pages.
const buttonImageCacheSize = 512

// ImageStreamMessage represents an image update message sent via WebSocket
type ImageStreamMessage struct {
	Type          string `json:"type"` // "update_button_image"
	Bank          int    `json:"bank"`
	ButtonIndex   int    `json:"buttonIndex"`
	ImageBuffer   string `json:"imageBuffer"` // Base64-encoded PNG
	Label         string `json:"label,omitempty"`
	Channel       string `json:"channel,omitempty"`
	State         string `json:"state,omitempty"` // "IDLE", "TALK", "LISTEN", "BROADCAST", "CALL"
	ActionType    string `json:"actionType,omitempty"`
	Color         string `json:"color,omitempty"`
	IsListening   bool   `json:"isListening,omitempty"`
	IsPTTSelected bool   `json:"isPttSelected,omitempty"`
}

// ButtonImageRenderConfig holds rendering configuration
type ButtonImageRenderConfig struct {
	Width  int
	Height int
}

// ButtonImageRenderer renders button state to PNG images. It keeps the
// font faces and the images it rendered: the same key state (on another
// deck, after paging back, the two phases of a blinking call) is not drawn
// again. Font faces are not safe for concurrent use, so drawing is
// serialized; with the caches a key takes well under a millisecond.
type ButtonImageRenderer struct {
	config ButtonImageRenderConfig
	mu     sync.Mutex
	faces  map[buttonFontKey]font.Face
	images map[string]renderedButtonImage
}

type buttonFontKey struct {
	bold bool
	size float64
}

type renderedButtonImage struct {
	png    []byte
	base64 string
}

// NewButtonImageRenderer creates a new renderer with default config
func NewButtonImageRenderer(config *ButtonImageRenderConfig) (*ButtonImageRenderer, error) {
	if config == nil {
		config = &ButtonImageRenderConfig{
			Width:  72,
			Height: 72,
		}
	}
	if _, _, err := parsedButtonFonts(); err != nil {
		return nil, err
	}
	return &ButtonImageRenderer{
		config: *config,
		faces:  make(map[buttonFontKey]font.Face),
		images: make(map[string]renderedButtonImage),
	}, nil
}

var (
	sizedRenderersMu sync.Mutex
	sizedRenderers   = map[[2]int]*ButtonImageRenderer{}
)

// buttonImageRendererForSize returns a shared renderer for one image size,
// so previews and debug images reuse its caches.
func buttonImageRendererForSize(width, height int) (*ButtonImageRenderer, error) {
	sizedRenderersMu.Lock()
	defer sizedRenderersMu.Unlock()
	key := [2]int{width, height}
	if r, ok := sizedRenderers[key]; ok {
		return r, nil
	}
	r, err := NewButtonImageRenderer(&ButtonImageRenderConfig{Width: width, Height: height})
	if err != nil {
		return nil, err
	}
	sizedRenderers[key] = r
	return r, nil
}

// face returns a cached font face; callers hold r.mu.
func (r *ButtonImageRenderer) face(bold bool, size float64) font.Face {
	key := buttonFontKey{bold: bold, size: size}
	if f, ok := r.faces[key]; ok {
		return f
	}
	boldFont, regularFont, _ := parsedButtonFonts()
	src := regularFont
	if bold {
		src = boldFont
	}
	f := truetype.NewFace(src, &truetype.Options{
		Size:    size,
		DPI:     72,
		Hinting: font.HintingFull,
	})
	r.faces[key] = f
	return f
}

// RenderButtonImageBase64 renders (or reuses) a key image as base64 PNG.
func (r *ButtonImageRenderer) RenderButtonImageBase64(state ButtonState) (string, error) {
	img, err := r.render(state)
	if err != nil {
		return "", err
	}
	return img.base64, nil
}

// ButtonState represents the state of a button for rendering
type ButtonState struct {
	Channel       string
	State         string // "IDLE", "TALK", "LISTEN", "BROADCAST", "CALL" (blinking incoming call)
	Label         string
	Subtitle      string
	ActionType    string
	Color         string
	TalkCount     int
	IsListening   bool
	IsPTTSelected bool
	IsActive      bool
	// VolumeDelta is the step of a mic gain key (its sign is the direction).
	VolumeDelta int
	// Calling: an incoming call waits on this key; State blinks between
	// "CALL" and the normal state.
	Calling bool
}

type streamDeckPreviewButtonRequest struct {
	ButtonIndex   int    `json:"buttonIndex"`
	Label         string `json:"label,omitempty"`
	Subtitle      string `json:"subtitle,omitempty"`
	ActionType    string `json:"actionType,omitempty"`
	Color         string `json:"color,omitempty"`
	State         string `json:"state,omitempty"`
	Channel       string `json:"channel,omitempty"`
	IsListening   bool   `json:"isListening,omitempty"`
	IsPTTSelected bool   `json:"isPttSelected,omitempty"`
	IsActive      bool   `json:"isActive,omitempty"`
	VolumeDelta   int    `json:"volumeDelta,omitempty"`
}

type streamDeckPreviewRequest struct {
	Width   int                              `json:"width,omitempty"`
	Height  int                              `json:"height,omitempty"`
	Buttons []streamDeckPreviewButtonRequest `json:"buttons"`
}

type streamDeckPreviewImage struct {
	ButtonIndex int    `json:"buttonIndex"`
	ImageBuffer string `json:"imageBuffer"`
}

type streamDeckPreviewResponse struct {
	Width  int                      `json:"width"`
	Height int                      `json:"height"`
	Images []streamDeckPreviewImage `json:"images"`
}

// defaultBackground is used for a color that cannot be read.
const defaultBackground = "#182028"

// RenderButtonImage renders a button state as a PNG. The returned slice is
// shared with the cache and must not be modified.
func (r *ButtonImageRenderer) RenderButtonImage(state ButtonState) ([]byte, error) {
	img, err := r.render(state)
	if err != nil {
		return nil, err
	}
	return img.png, nil
}

func (r *ButtonImageRenderer) render(state ButtonState) (renderedButtonImage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := buttonStateSignature(state)
	if img, ok := r.images[key]; ok {
		return img, nil
	}
	png, err := r.draw(state)
	if err != nil {
		return renderedButtonImage{}, err
	}
	if len(r.images) >= buttonImageCacheSize {
		// Simple bound: start over rather than track recency. Refilling
		// the current pages costs a few milliseconds.
		r.images = make(map[string]renderedButtonImage, buttonImageCacheSize)
	}
	img := renderedButtonImage{png: png, base64: base64.StdEncoding.EncodeToString(png)}
	r.images[key] = img
	return img, nil
}

func normalizeHexColor(input string) string {
	value := strings.TrimSpace(input)
	if value == "" {
		return defaultBackground
	}
	if len(value) == 4 && value[0] == '#' {
		return strings.ToLower(fmt.Sprintf("#%c%c%c%c%c%c", value[1], value[1], value[2], value[2], value[3], value[3]))
	}
	if len(value) == 7 && value[0] == '#' {
		return strings.ToLower(value)
	}
	return defaultBackground
}

func hexToRGB(hex string) (int, int, int) {
	normalized := normalizeHexColor(hex)
	r, _ := strconv.ParseInt(normalized[1:3], 16, 64)
	g, _ := strconv.ParseInt(normalized[3:5], 16, 64)
	b, _ := strconv.ParseInt(normalized[5:7], 16, 64)
	return int(r), int(g), int(b)
}

func mixColors(hex, target string, amount float64) string {
	sr, sg, sb := hexToRGB(hex)
	tr, tg, tb := hexToRGB(target)
	mix := func(left, right int) int {
		value := float64(left) + (float64(right-left) * amount)
		return int(math.Round(value))
	}
	return fmt.Sprintf("#%02x%02x%02x", mix(sr, tr), mix(sg, tg), mix(sb, tb))
}

func wrapButtonLines(dc *gg.Context, text string, maxWidth float64, maxLines int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{""}
	}

	lines := make([]string, 0, maxLines)
	current := ""
	for _, word := range words {
		candidate := word
		if current != "" {
			candidate = current + " " + word
		}
		if width, _ := dc.MeasureString(candidate); width <= maxWidth {
			current = candidate
			continue
		}
		if current != "" {
			lines = append(lines, current)
			current = word
		} else {
			lines = append(lines, word)
			current = ""
		}
		if len(lines) == maxLines-1 {
			break
		}
	}

	if len(lines) < maxLines && current != "" {
		lines = append(lines, current)
	}

	if len(lines) == 0 {
		return []string{""}
	}

	result := lines
	if len(result) > maxLines {
		result = result[:maxLines]
	}

	joined := strings.Join(words, " ")
	if len(result) == maxLines && strings.Join(result, " ") != joined {
		last := result[len(result)-1]
		trimmed := strings.TrimSpace(last)
		if trimmed != "" {
			r := []rune(trimmed)
			if len(r) > 0 {
				trimmed = string(r[:len(r)-1])
			}
		}
		result[len(result)-1] = trimmed + "..."
	}

	return result
}

// ImageStreamCoordinator manages image stream connections and broadcasting
type ImageStreamCoordinator struct {
	mu       sync.RWMutex
	clients  map[*ImageStreamClient]struct{}
	renderer *ButtonImageRenderer
	logger   *slog.Logger
}

// ImageStreamClient represents a connected image stream client
type ImageStreamClient struct {
	RoleID   string
	send     chan ImageStreamMessage
	done     chan struct{}
	logger   *slog.Logger
	mu       sync.Mutex
	lastSent map[string]string
}

func streamButtonKey(bank, buttonIndex int) string {
	return strconv.Itoa(bank) + ":" + strconv.Itoa(buttonIndex)
}

func buttonStateSignature(state ButtonState) string {
	return strings.Join(
		[]string{
			strings.TrimSpace(state.Channel),
			strings.TrimSpace(state.State),
			strings.TrimSpace(state.Label),
			strings.TrimSpace(state.Subtitle),
			strings.TrimSpace(state.ActionType),
			strings.TrimSpace(state.Color),
			strconv.Itoa(state.TalkCount),
			strconv.FormatBool(state.IsListening),
			strconv.FormatBool(state.IsPTTSelected),
			strconv.FormatBool(state.IsActive),
			strconv.FormatBool(state.Calling),
			strconv.Itoa(state.VolumeDelta),
		},
		"\x1f",
	)
}

func (c *ImageStreamClient) needsButtonUpdate(bank, buttonIndex int, signature string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSent == nil {
		c.lastSent = make(map[string]string)
		return true
	}
	return c.lastSent[streamButtonKey(bank, buttonIndex)] != signature
}

func (c *ImageStreamClient) markButtonUpdateSent(bank, buttonIndex int, signature string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.lastSent == nil {
		c.lastSent = make(map[string]string)
	}
	c.lastSent[streamButtonKey(bank, buttonIndex)] = signature
	c.mu.Unlock()
}

func (c *ImageStreamClient) resetLastSent() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.lastSent = make(map[string]string)
	c.mu.Unlock()
}

// NewImageStreamCoordinator creates a new image stream coordinator
func NewImageStreamCoordinator(logger *slog.Logger) (*ImageStreamCoordinator, error) {
	renderer, err := NewButtonImageRenderer(nil)
	if err != nil {
		return nil, err
	}

	return &ImageStreamCoordinator{
		clients:  make(map[*ImageStreamClient]struct{}),
		renderer: renderer,
		logger:   logger,
	}, nil
}

// BroadcastImageUpdate sends an image update to all connected clients.
func (c *ImageStreamCoordinator) BroadcastImageUpdate(state ButtonState, bank, buttonIndex int) {
	c.BroadcastImageUpdateForTarget("", state, bank, buttonIndex)
}

// ResetTargetCache clears dedup signatures for matching clients so subsequent image
// emissions are always re-sent even if signatures are unchanged.
func (c *ImageStreamCoordinator) ResetTargetCache(roleID string) {
	if c == nil {
		return
	}
	targetRoleID := strings.TrimSpace(roleID)

	c.mu.RLock()
	clients := make([]*ImageStreamClient, 0, len(c.clients))
	for client := range c.clients {
		clientRoleID := strings.TrimSpace(client.RoleID)
		if targetRoleID != "" && clientRoleID != targetRoleID {
			continue
		}
		clients = append(clients, client)
	}
	c.mu.RUnlock()

	for _, client := range clients {
		client.resetLastSent()
	}
}

// BroadcastImageUpdateForTarget sends an image update only to clients bound to
// the same target (a deck key or a role ID; empty means all clients).
func (c *ImageStreamCoordinator) BroadcastImageUpdateForTarget(roleID string, state ButtonState, bank, buttonIndex int) {
	targetRoleID := strings.TrimSpace(roleID)
	signature := buttonStateSignature(state)

	c.mu.RLock()
	recipients := make([]*ImageStreamClient, 0, len(c.clients))
	for client := range c.clients {
		clientRoleID := strings.TrimSpace(client.RoleID)
		if targetRoleID != "" && clientRoleID != targetRoleID {
			continue
		}
		if !client.needsButtonUpdate(bank, buttonIndex, signature) {
			continue
		}
		recipients = append(recipients, client)
	}
	c.mu.RUnlock()

	if len(recipients) == 0 {
		if c.logger != nil {
			c.logger.Info("companion image update skipped",
				"roleId", targetRoleID,
				"bank", bank,
				"buttonIndex", buttonIndex,
				"label", strings.TrimSpace(state.Label),
				"actionType", strings.TrimSpace(state.ActionType),
				"state", strings.TrimSpace(state.State),
			)
		}
		return
	}

	imageBase64, err := c.renderer.RenderButtonImageBase64(state)
	if err != nil {
		c.logger.Error("failed to render button image", "error", err)
		return
	}

	msg := ImageStreamMessage{
		Type:          "update_button_image",
		Bank:          bank,
		ButtonIndex:   buttonIndex,
		ImageBuffer:   imageBase64,
		Label:         state.Label,
		Channel:       state.Channel,
		State:         state.State,
		ActionType:    state.ActionType,
		Color:         state.Color,
		IsListening:   state.IsListening,
		IsPTTSelected: state.IsPTTSelected,
	}

	// Send only to matching clients.
	sent := 0
	closed := 0
	dropped := 0
	for _, client := range recipients {
		select {
		case client.send <- msg:
			client.markButtonUpdateSent(bank, buttonIndex, signature)
			sent++
		case <-client.done:
			closed++
		default:
			// Client queue full, drop message
			dropped++
		}
	}
	if c.logger != nil {
		c.logger.Info("companion image update dispatched",
			"roleId", targetRoleID,
			"bank", bank,
			"buttonIndex", buttonIndex,
			"label", strings.TrimSpace(state.Label),
			"actionType", strings.TrimSpace(state.ActionType),
			"state", strings.TrimSpace(state.State),
			"recipients", len(recipients),
			"sent", sent,
			"closed", closed,
			"dropped", dropped,
		)
	}
}

// RegisterClient registers a new image stream client
func (c *ImageStreamCoordinator) RegisterClient(client *ImageStreamClient) {
	c.mu.Lock()
	c.clients[client] = struct{}{}
	c.mu.Unlock()
}

// UnregisterClient unregisters a client
func (c *ImageStreamCoordinator) UnregisterClient(client *ImageStreamClient) {
	c.mu.Lock()
	delete(c.clients, client)
	c.mu.Unlock()
}

// HandleImageStreamWebSocket handles WebSocket connections for image streaming
func (s *Server) HandleImageStreamWebSocket(w http.ResponseWriter, r *http.Request) {
	if !s.requireCompanionSecret(w, r) {
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("websocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()
	targetRoleID := s.resolveImageStreamTarget(r.Context(), r)

	client := &ImageStreamClient{
		RoleID:   targetRoleID,
		send:     make(chan ImageStreamMessage, 16),
		done:     make(chan struct{}),
		logger:   s.logger,
		lastSent: make(map[string]string),
	}

	// Register client
	if s.imageStreamCoord != nil {
		s.imageStreamCoord.RegisterClient(client)
		defer s.imageStreamCoord.UnregisterClient(client)
		s.enqueueInitialImageSnapshot(r.Context(), client, targetRoleID)
	}

	// Ping ticker
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	refreshTicker := time.NewTicker(imageStreamResolveInterval)
	defer refreshTicker.Stop()
	lastRefresh := time.Now()

	for {
		select {
		case msg := <-client.send:
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(msg); err != nil {
				s.logger.Error("failed to write image message", "error", err)
				return
			}

		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
				return
			}

		case <-refreshTicker.C:
			resolved := strings.TrimSpace(targetRoleID) != ""
			if resolved && time.Since(lastRefresh) < imageStreamRefreshInterval {
				continue
			}
			if !resolved {
				targetRoleID = s.resolveImageStreamTarget(context.Background(), r)
				client.RoleID = targetRoleID
			}
			lastRefresh = time.Now()
			s.enqueueInitialImageSnapshot(context.Background(), client, targetRoleID)

		case <-client.done:
			return
		}
	}
}

// resolveImageStreamTarget binds an image stream to ?deck= (current) or
// ?roleId= (older module versions), like the Companion WebSocket.
func (s *Server) resolveImageStreamTarget(ctx context.Context, r *http.Request) string {
	if s.store == nil {
		return ""
	}
	if deckParam := strings.TrimSpace(r.URL.Query().Get("deck")); deckParam != "" {
		deck, err := s.store.TouchStreamDeck(ctx, deckParam, remoteIP(r))
		if err != nil {
			return ""
		}
		return deckKey(deck.ID)
	}
	roleID := strings.TrimSpace(r.URL.Query().Get("roleId"))
	if roleID == "" {
		autoRoleID, err := s.store.ResolveSinglePublishedCompanionRole(ctx)
		if err == nil {
			roleID = strings.TrimSpace(autoRoleID)
		}
	}
	return roleID
}

func (s *Server) enqueueInitialImageSnapshot(ctx context.Context, client *ImageStreamClient, roleID string) {
	if s.imageStreamCoord == nil || client == nil || strings.TrimSpace(roleID) == "" {
		return
	}
	if _, isDeck := deckIDFromKey(roleID); isDeck {
		// Images only go where they are still missing, so this fills in a
		// newly connected deck without resending to others.
		s.emitCompanionCurrentPageImages(ctx, roleID, "")
		return
	}

	listeningRooms := make(map[string]struct{})
	selectedTalkRooms := make(map[string]struct{})
	renderUsername := ""
	presence := PresenceState{}
	if s.hub != nil {
		if session, ok := s.hub.LatestRoleSession(roleID); ok {
			renderUsername = strings.TrimSpace(session.Username)
			presence, _ = s.hub.PresenceForUsername(renderUsername)
			for _, roomID := range presence.TalkRooms {
				if trimmed := strings.TrimSpace(roomID); trimmed != "" {
					selectedTalkRooms[trimmed] = struct{}{}
				}
			}
			for _, roomID := range s.hub.ListenRoomsForToken(session.Token) {
				if trimmed := strings.TrimSpace(roomID); trimmed != "" {
					listeningRooms[trimmed] = struct{}{}
				}
			}
		}
	}

	profile, err := s.store.GetCompanionProfileByRole(ctx, roleID)
	if err != nil {
		s.logger.Debug("image snapshot skipped: profile unavailable", "roleId", roleID, "error", err)
		return
	}

	pageNumber := s.currentCompanionPage(ctx, roleID)
	runtimePage := s.resolveCompanionRuntimePage(ctx, roleID, profile.StreamDeck, pageNumber)
	page := &runtimePage.Page
	if page == nil {
		return
	}

	for i := range page.Buttons {
		button := page.Buttons[i]
		state := s.companionButtonSnapshotState(ctx, roleID, page.Page, renderUsername, presence, button)
		if !state.IsListening && button.Action != nil {
			actionType := button.Action.Type
			roomID := strings.TrimSpace(button.Action.RoomID)
			if roomID != "" && (actionType == StreamDeckActionTypePTTRoom || actionType == StreamDeckActionTypeListenRoom || actionType == StreamDeckActionTypeSelectListen) {
				_, state.IsListening = listeningRooms[roomID]
			}
		}
		if !state.IsPTTSelected && button.Action != nil {
			actionType := button.Action.Type
			roomID := strings.TrimSpace(button.Action.RoomID)
			if roomID != "" && (actionType == StreamDeckActionTypeSelectTalkRoom || actionType == StreamDeckActionTypeSelectListen) {
				_, state.IsPTTSelected = selectedTalkRooms[roomID]
			}
		}
		if strings.TrimSpace(state.Label) == "" {
			state.Label, state.Subtitle = s.resolveButtonLabel(ctx, button)
		}
		if strings.TrimSpace(state.Channel) == "" {
			state.Channel = companionButtonChannel(button)
		}
		if button.Action != nil && strings.TrimSpace(state.ActionType) == "" {
			state.ActionType = string(button.Action.Type)
		}
		if button.Action != nil {
			state.VolumeDelta = button.Action.VolumeDelta
		}
		if strings.TrimSpace(state.Color) == "" {
			state.Color = strings.TrimSpace(button.Color)
		}
		signature := buttonStateSignature(state)
		if !client.needsButtonUpdate(page.Page, button.Index, signature) {
			continue
		}
		img, renderErr := s.imageStreamCoord.renderer.RenderButtonImageBase64(state)
		if renderErr != nil {
			s.logger.Warn("image snapshot render failed", "roleId", roleID, "index", button.Index, "error", renderErr)
			continue
		}

		msg := ImageStreamMessage{
			Type:          "update_button_image",
			Bank:          page.Page,
			ButtonIndex:   button.Index,
			ImageBuffer:   img,
			Label:         state.Label,
			Channel:       state.Channel,
			State:         state.State,
			ActionType:    state.ActionType,
			Color:         state.Color,
			IsListening:   state.IsListening,
			IsPTTSelected: state.IsPTTSelected,
		}

		select {
		case client.send <- msg:
			client.markButtonUpdateSent(page.Page, button.Index, signature)
			if s.logger != nil {
				s.logger.Info("companion image snapshot queued",
					"roleId", roleID,
					"username", renderUsername,
					"bank", page.Page,
					"buttonIndex", button.Index,
					"label", strings.TrimSpace(state.Label),
					"actionType", strings.TrimSpace(state.ActionType),
					"state", strings.TrimSpace(state.State),
				)
			}
		default:
			s.logger.Warn("image snapshot queue full", "roleId", roleID)
			return
		}
	}
}

// HandleDebugButtonImage renders a single button image as PNG for browser-based inspection.
func (s *Server) HandleDebugButtonImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	state := normalizeButtonRenderState(r.URL.Query().Get("state"))

	label := strings.TrimSpace(r.URL.Query().Get("label"))
	if label == "" {
		label = state
	}

	channel := strings.TrimSpace(r.URL.Query().Get("channel"))
	if channel == "" {
		channel = "debug"
	}

	width := parseDebugInt(r.URL.Query().Get("width"), 72)
	height := parseDebugInt(r.URL.Query().Get("height"), 72)

	renderer, err := buttonImageRendererForSize(width, height)
	if err != nil {
		http.Error(w, "failed to initialize renderer", http.StatusInternalServerError)
		return
	}

	imageBuf, err := renderer.RenderButtonImage(ButtonState{
		Channel: channel,
		State:   state,
		Label:   label,
	})
	if err != nil {
		http.Error(w, "failed to render image", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Kesher-Button-State", state)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(imageBuf)
}

// HandleDebugButtonImagePreview serves a tiny HTML page to inspect generated images.
func (s *Server) HandleDebugButtonImagePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kesher Button Image Debug</title>
  <style>
    body { font-family: Segoe UI, sans-serif; margin: 24px; color: #222; }
    h1 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; background: #fafafa; }
    img { width: 144px; height: 144px; image-rendering: pixelated; border: 1px solid #ccc; background: #fff; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Kesher Backend Image Preview</h1>
  <p>PNG endpoint: <code>/api/debug/button-image?state=IDLE&amp;label=IDLE&amp;channel=debug</code></p>
  <div class="grid">
    <div class="card"><div>IDLE</div><img src="/api/debug/button-image?state=IDLE&amp;label=IDLE&amp;channel=debug" alt="IDLE" /></div>
    <div class="card"><div>TALK</div><img src="/api/debug/button-image?state=TALK&amp;label=TALK&amp;channel=debug" alt="TALK" /></div>
    <div class="card"><div>LISTEN</div><img src="/api/debug/button-image?state=LISTEN&amp;label=LISTEN&amp;channel=debug" alt="LISTEN" /></div>
    <div class="card"><div>BROADCAST</div><img src="/api/debug/button-image?state=BROADCAST&amp;label=BROADCAST&amp;channel=debug" alt="BROADCAST" /></div>
  </div>
</body>
</html>`

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(page))
}

func parseDebugInt(raw string, fallback int) int {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	if v < 16 {
		return 16
	}
	if v > 512 {
		return 512
	}
	return v
}

func parsePreviewDimension(raw int, fallback int) int {
	v := raw
	if v == 0 {
		v = fallback
	}
	if v < 16 {
		return 16
	}
	if v > 512 {
		return 512
	}
	return v
}

func normalizeButtonRenderState(raw string) string {
	state := strings.ToUpper(strings.TrimSpace(raw))
	switch state {
	case "IDLE", "TALK", "LISTEN", "BROADCAST", "CALL":
		return state
	default:
		return "IDLE"
	}
}

func (s *Server) handleUserStreamDeckPreview(w http.ResponseWriter, r *http.Request, _ Session) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req streamDeckPreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if len(req.Buttons) == 0 {
		s.writeJSON(w, http.StatusOK, streamDeckPreviewResponse{Width: 112, Height: 112, Images: []streamDeckPreviewImage{}})
		return
	}

	width := parsePreviewDimension(req.Width, 112)
	height := parsePreviewDimension(req.Height, 112)

	renderer, err := buttonImageRendererForSize(width, height)
	if err != nil {
		s.internalErr(w, err)
		return
	}

	images := make([]streamDeckPreviewImage, 0, len(req.Buttons))
	for _, button := range req.Buttons {
		img, renderErr := renderer.RenderButtonImageBase64(ButtonState{
			Channel:       strings.TrimSpace(button.Channel),
			State:         normalizeButtonRenderState(button.State),
			Label:         strings.TrimSpace(button.Label),
			Subtitle:      strings.TrimSpace(button.Subtitle),
			ActionType:    strings.TrimSpace(button.ActionType),
			Color:         strings.TrimSpace(button.Color),
			IsListening:   button.IsListening,
			IsPTTSelected: button.IsPTTSelected,
			IsActive:      button.IsActive,
			VolumeDelta:   button.VolumeDelta,
		})
		if renderErr != nil {
			http.Error(w, "failed to render preview image", http.StatusInternalServerError)
			return
		}
		images = append(images, streamDeckPreviewImage{
			ButtonIndex: button.ButtonIndex,
			ImageBuffer: img,
		})
	}

	s.writeJSON(w, http.StatusOK, streamDeckPreviewResponse{
		Width:  width,
		Height: height,
		Images: images,
	})
}
