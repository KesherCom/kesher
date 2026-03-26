package app

import (
	"bytes"
	"context"
	"encoding/base64"
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
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
)

const imageStreamRefreshInterval = 2 * time.Second

// ImageStreamMessage represents an image update message sent via WebSocket
type ImageStreamMessage struct {
	Type        string `json:"type"` // "update_button_image"
	Bank        int    `json:"bank"`
	ButtonIndex int    `json:"buttonIndex"`
	ImageBuffer string `json:"imageBuffer"` // Base64-encoded PNG
	Label       string `json:"label,omitempty"`
	Channel     string `json:"channel,omitempty"`
	State       string `json:"state,omitempty"` // "IDLE", "TALK", "LISTEN", "BROADCAST"
	ActionType  string `json:"actionType,omitempty"`
	Color       string `json:"color,omitempty"`
	IsListening bool   `json:"isListening,omitempty"`
}

// ButtonImageRenderConfig holds rendering configuration
type ButtonImageRenderConfig struct {
	Width  int
	Height int
}

// ButtonImageRenderer renders button state to image buffers
type ButtonImageRenderer struct {
	config ButtonImageRenderConfig
	mu     sync.RWMutex
}

// NewButtonImageRenderer creates a new renderer with default config
func NewButtonImageRenderer(config *ButtonImageRenderConfig) (*ButtonImageRenderer, error) {
	if config == nil {
		config = &ButtonImageRenderConfig{
			Width:  72,
			Height: 72,
		}
	}
	return &ButtonImageRenderer{
		config: *config,
	}, nil
}

// ButtonState represents the state of a button for rendering
type ButtonState struct {
	Channel     string
	State       string // "IDLE", "TALK", "LISTEN", "BROADCAST"
	Label       string
	Subtitle    string
	ActionType  string
	Color       string
	TalkCount   int
	IsListening bool
	IsActive    bool
}

type keyPalette struct {
	background string
	border     string
	label      string
}

const (
	streamDeckCanvasBackground = "#000000"
	defaultBackground          = "#182028"
	defaultForeground          = "#eef4ff"
)

// RenderButtonImage renders a button state as a PNG using the same card palette and
// typography rules as web/src/lib/streamDeckHardwareFeedback.ts.
func (r *ButtonImageRenderer) RenderButtonImage(state ButtonState) ([]byte, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	w := float64(r.config.Width)
	h := float64(r.config.Height)
	actionType := strings.TrimSpace(state.ActionType)
	pressed := state.IsActive || state.State == "TALK" || state.State == "BROADCAST"
	useCallPressedColor := pressed && actionType == string(StreamDeckActionTypeCallRoom)
	useEmergencyPressedColor := pressed && actionType != string(StreamDeckActionTypeListenRoom) && actionType != string(StreamDeckActionTypeCallRoom)
	palette := getButtonPalette(actionType, state.Color, pressed)
	strokeColor := palette.border
	if pressed {
		strokeColor = mixColors(strokeColor, "#ffffff", 0.2)
	}

	dc := gg.NewContext(r.config.Width, r.config.Height)

	// Black canvas background
	dc.SetHexColor(streamDeckCanvasBackground)
	dc.Clear()

	const cardInset = 2.0
	radius := math.Max(10, math.Round(w*0.12))

	dc.SetHexColor(palette.background)
	dc.DrawRoundedRectangle(cardInset, cardInset, w-cardInset*2, h-cardInset*2, radius)
	dc.Fill()

	dc.SetHexColor(strokeColor)
	if useEmergencyPressedColor {
		dc.SetLineWidth(4)
	} else {
		dc.SetLineWidth(3)
	}
	dc.DrawRoundedRectangle(cardInset, cardInset, w-cardInset*2, h-cardInset*2, radius)
	dc.Stroke()

	if useEmergencyPressedColor {
		dc.SetRGBA255(255, 115, 115, 72)
		dc.SetLineWidth(2)
		dc.DrawRoundedRectangle(cardInset-1, cardInset-1, w-(cardInset-1)*2, h-(cardInset-1)*2, radius+1)
		dc.Stroke()
	}
	if useCallPressedColor {
		dc.SetRGBA255(255, 214, 102, 90)
		dc.SetLineWidth(2)
		dc.DrawRoundedRectangle(cardInset-1, cardInset-1, w-(cardInset-1)*2, h-(cardInset-1)*2, radius+1)
		dc.Stroke()
	}

	if (actionType == string(StreamDeckActionTypePTTRoom) || actionType == string(StreamDeckActionTypeListenRoom) || actionType == string(StreamDeckActionTypeSelectTalkRoom)) && state.IsListening {
		stripeHeight := math.Max(6, math.Round(h*0.075))
		dc.SetHexColor("#14c64b")
		dc.DrawRoundedRectangle(
			cardInset+3,
			cardInset+(h-cardInset*2)-stripeHeight-2,
			(w-cardInset*2)-6,
			stripeHeight,
			math.Max(3, math.Round(stripeHeight/2)),
		)
		dc.Fill()
	}

	// Text rendering
	label := strings.TrimSpace(state.Label)
	subtitle := strings.TrimSpace(state.Subtitle)
	textColor := palette.label

	if label != "" {
		if subtitle != "" {
			// Two-line layout: large primary near top, small subtitle near bottom
			primarySize := fitButtonFontSize(dc, label, w-24, math.Max(20, w*0.2), 800, gobold.TTF)
			if face, err := loadButtonFontFace(gobold.TTF, primarySize); err == nil {
				dc.SetFontFace(face)
			}
			dc.SetHexColor(textColor)
			primaryLines := wrapButtonLines(dc, label, w-24, 2)
			primaryLineHeight := math.Round(primarySize * 1.1)
			primaryBlockHeight := float64(len(primaryLines)) * primaryLineHeight
			primaryStartY := math.Round(h*0.38) - primaryBlockHeight/2 + primaryLineHeight/2
			for i, line := range primaryLines {
				dc.DrawStringAnchored(line, w/2, primaryStartY+float64(i)*primaryLineHeight, 0.5, 0.5)
			}

			subSize := fitButtonFontSize(dc, subtitle, w-26, math.Max(11, w*0.1), 600, goregular.TTF)
			if face, err := loadButtonFontFace(goregular.TTF, subSize); err == nil {
				dc.SetFontFace(face)
			}
			dc.SetHexColor(mixColors(textColor, "#aeb6c0", 0.45))
			secondaryLines := wrapButtonLines(dc, subtitle, w-26, 1)
			dc.DrawStringAnchored(secondaryLines[0], w/2, math.Round(h*0.68), 0.5, 0.5)
		} else {
			// Single-label layout: up to two wrapped lines, centered in lower half
			labelSize := fitButtonFontSize(dc, label, w-24, math.Max(18, w*0.15), 800, gobold.TTF)
			if face, err := loadButtonFontFace(gobold.TTF, labelSize); err == nil {
				dc.SetFontFace(face)
			}
			dc.SetHexColor(textColor)
			labelLines := wrapButtonLines(dc, label, w-24, 2)
			labelLineHeight := math.Round(labelSize * 1.03)
			labelStartY := math.Round(h*0.56) - (float64(len(labelLines)-1)*labelLineHeight)/2
			for i, line := range labelLines {
				dc.DrawStringAnchored(line, w/2, labelStartY+float64(i)*labelLineHeight, 0.5, 0.5)
			}
		}
	}

	var buf bytes.Buffer
	if err := dc.EncodePNG(&buf); err != nil {
		return nil, fmt.Errorf("failed to encode PNG: %w", err)
	}
	return buf.Bytes(), nil
}

func getButtonPalette(actionType, color string, pressed bool) keyPalette {
	if pressed && actionType == string(StreamDeckActionTypeCallRoom) {
		return keyPalette{
			background: "#f2c94c",
			border:     "#ffd76a",
			label:      "#2a2110",
		}
	}

	useEmergencyPressedColor := pressed && actionType != string(StreamDeckActionTypeNone) && actionType != string(StreamDeckActionTypeListenRoom)
	if useEmergencyPressedColor {
		return keyPalette{
			background: "#ef1212",
			border:     "#ff2d26",
			label:      "#f7f7f7",
		}
	}

	if strings.TrimSpace(color) != "" {
		custom := normalizeHexColor(color)
		amount := 0.22
		if pressed {
			amount = 0.42
		}
		return keyPalette{
			background: "#000000",
			border:     mixColors(custom, "#ffffff", amount),
			label:      "#f2f5f8",
		}
	}

	switch actionType {
	case string(StreamDeckActionTypeBroadcastPTT):
		return keyPalette{background: "#000000", border: "#ff2d26", label: "#f7f7f7"}
	case string(StreamDeckActionTypeCallRoom):
		return keyPalette{background: "#000000", border: "#ffc067", label: "#f6f0e8"}
	case string(StreamDeckActionTypeSelectTalkRoom):
		return keyPalette{background: "#000000", border: "#2da8ff", label: "#ecf7ff"}
	case string(StreamDeckActionTypePTTSelected):
		return keyPalette{background: "#000000", border: "#ff4d4d", label: "#fff1f1"}
	case string(StreamDeckActionTypeListenRoom):
		return keyPalette{background: "#000000", border: "#26d07c", label: "#ebfff3"}
	case string(StreamDeckActionTypeDirectRole), string(StreamDeckActionTypeDirectUser):
		return keyPalette{background: "#000000", border: "#ff2d26", label: "#f3f5f7"}
	case string(StreamDeckActionTypePTTRoom):
		return keyPalette{background: "#000000", border: "#1b2026", label: "#f1f4f8"}
	case string(StreamDeckActionTypeReplyToCaller):
		return keyPalette{background: "#000000", border: "#ffc067", label: "#f6f0e8"}
	case string(StreamDeckActionTypeMuteToggle):
		return keyPalette{background: "#000000", border: "#f84e4e", label: "#fff1f1"}
	case string(StreamDeckActionTypeVolumeDelta):
		return keyPalette{background: "#000000", border: "#9d8cff", label: "#f2f0ff"}
	case string(StreamDeckActionTypePageUp), string(StreamDeckActionTypePageDown):
		return keyPalette{background: "#000000", border: "#58ccf6", label: "#effbff"}
	default:
		return keyPalette{background: "#000000", border: "#1a1f26", label: "#edf2f8"}
	}
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

// loadButtonFontFace parses a TTF byte slice and returns a font.Face at the given point size.
func loadButtonFontFace(ttfBytes []byte, size float64) (font.Face, error) {
	f, err := truetype.Parse(ttfBytes)
	if err != nil {
		return nil, err
	}
	return truetype.NewFace(f, &truetype.Options{
		Size:    size,
		DPI:     72,
		Hinting: font.HintingFull,
	}), nil
}

// fitButtonFontSize shrinks point size from initialSize down to 12 until the string fits maxWidth.
func fitButtonFontSize(dc *gg.Context, text string, maxWidth, initialSize, _ float64, ttfBytes []byte) float64 {
	size := initialSize
	for size > 12 {
		if face, err := loadButtonFontFace(ttfBytes, size); err == nil {
			dc.SetFontFace(face)
			if w, _ := dc.MeasureString(text); w <= maxWidth {
				return size
			}
		}
		size--
	}
	return size
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
	send   chan ImageStreamMessage
	done   chan struct{}
	logger *slog.Logger
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

// BroadcastImageUpdate sends an image update to all connected clients
func (c *ImageStreamCoordinator) BroadcastImageUpdate(state ButtonState, bank, buttonIndex int) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Render the image
	imageBuf, err := c.renderer.RenderButtonImage(state)
	if err != nil {
		c.logger.Error("failed to render button image", "error", err)
		return
	}

	// Encode to base64
	imageBase64 := base64.StdEncoding.EncodeToString(imageBuf)

	msg := ImageStreamMessage{
		Type:        "update_button_image",
		Bank:        bank,
		ButtonIndex: buttonIndex,
		ImageBuffer: imageBase64,
		Label:       state.Label,
		Channel:     state.Channel,
		State:       state.State,
		ActionType:  state.ActionType,
		Color:       state.Color,
		IsListening: state.IsListening,
	}

	// Send to all clients
	for client := range c.clients {
		select {
		case client.send <- msg:
		case <-client.done:
			delete(c.clients, client)
		default:
			// Client queue full, drop message
		}
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
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("websocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()
	targetRoleID := s.resolveImageStreamRoleID(r.Context(), r)

	client := &ImageStreamClient{
		send:   make(chan ImageStreamMessage, 16),
		done:   make(chan struct{}),
		logger: s.logger,
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
	refreshTicker := time.NewTicker(imageStreamRefreshInterval)
	defer refreshTicker.Stop()

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
			if strings.TrimSpace(targetRoleID) == "" {
				targetRoleID = s.resolveImageStreamRoleID(context.Background(), r)
			}
			s.enqueueInitialImageSnapshot(context.Background(), client, targetRoleID)

		case <-client.done:
			return
		}
	}
}

func (s *Server) resolveImageStreamRoleID(ctx context.Context, r *http.Request) string {
	if s.store == nil {
		return ""
	}
	roleID := strings.TrimSpace(r.URL.Query().Get("roleId"))
	if roleID != "" {
		return roleID
	}
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username != "" {
		if u, err := s.store.FindUserByUsername(ctx, username); err == nil {
			return strings.TrimSpace(u.RoleID)
		}
	}
	autoRoleID, err := s.store.ResolveSinglePublishedCompanionRole(ctx)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(autoRoleID)
}

func (s *Server) enqueueInitialImageSnapshot(ctx context.Context, client *ImageStreamClient, roleID string) {
	if s.imageStreamCoord == nil || client == nil || strings.TrimSpace(roleID) == "" {
		return
	}

	listeningRooms := make(map[string]struct{})
	renderUsername := ""
	presence := PresenceState{}
	if s.hub != nil {
		if session, ok := s.hub.LatestRoleSession(roleID); ok {
			renderUsername = strings.TrimSpace(session.Username)
			presence, _ = s.hub.PresenceForUsername(renderUsername)
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
	var page *StreamDeckPageConfig
	for i := range profile.StreamDeck.Pages {
		if profile.StreamDeck.Pages[i].Page == pageNumber {
			page = &profile.StreamDeck.Pages[i]
			break
		}
	}
	if page == nil && len(profile.StreamDeck.Pages) > 0 {
		page = &profile.StreamDeck.Pages[0]
	}
	if page == nil {
		return
	}

	for i := range page.Buttons {
		button := page.Buttons[i]
		state := s.companionButtonSnapshotState(ctx, roleID, page.Page, renderUsername, presence, button)
		if !state.IsListening && button.Action != nil {
			actionType := button.Action.Type
			roomID := strings.TrimSpace(button.Action.RoomID)
			if roomID != "" && (actionType == StreamDeckActionTypePTTRoom || actionType == StreamDeckActionTypeListenRoom) {
				_, state.IsListening = listeningRooms[roomID]
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
		if strings.TrimSpace(state.Color) == "" {
			state.Color = strings.TrimSpace(button.Color)
		}
		img, renderErr := s.imageStreamCoord.renderer.RenderButtonImage(state)
		if renderErr != nil {
			s.logger.Warn("image snapshot render failed", "roleId", roleID, "index", button.Index, "error", renderErr)
			continue
		}

		msg := ImageStreamMessage{
			Type:        "update_button_image",
			Bank:        page.Page,
			ButtonIndex: button.Index,
			ImageBuffer: base64.StdEncoding.EncodeToString(img),
			Label:       state.Label,
			Channel:     state.Channel,
			State:       state.State,
			ActionType:  state.ActionType,
			Color:       state.Color,
			IsListening: state.IsListening,
		}

		select {
		case client.send <- msg:
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

	state := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("state")))
	switch state {
	case "IDLE", "TALK", "LISTEN", "BROADCAST":
	default:
		state = "IDLE"
	}

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

	renderer, err := NewButtonImageRenderer(&ButtonImageRenderConfig{Width: width, Height: height})
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
