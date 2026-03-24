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

// ImageStreamMessage represents an image update message sent via WebSocket
type ImageStreamMessage struct {
	Type        string `json:"type"` // "update_button_image"
	Bank        int    `json:"bank"`
	ButtonIndex int    `json:"buttonIndex"`
	ImageBuffer string `json:"imageBuffer"` // Base64-encoded PNG
	Label       string `json:"label,omitempty"`
	Channel     string `json:"channel,omitempty"`
	State       string `json:"state,omitempty"` // "IDLE", "TALK", "LISTEN", "BROADCAST"
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
	Channel   string
	State     string // "IDLE", "TALK", "LISTEN", "BROADCAST"
	Label     string
	Subtitle  string
	TalkCount int
	IsActive  bool
}

// RenderButtonImage renders a button state as a PNG using the WebHID visual style:
// pure black canvas, rounded card with a colored state border, and a text label.
func (r *ButtonImageRenderer) RenderButtonImage(state ButtonState) ([]byte, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	w := float64(r.config.Width)
	h := float64(r.config.Height)

	dc := gg.NewContext(r.config.Width, r.config.Height)

	// Black canvas background
	dc.SetHexColor("#000000")
	dc.Clear()

	// Rounded card: filled black, then stroked with state border color
	const inset = 2.0
	const cardRadius = 10.0
	dc.SetHexColor("#000000")
	dc.DrawRoundedRectangle(inset, inset, w-inset*2, h-inset*2, cardRadius)
	dc.Fill()

	dc.SetHexColor(getBorderColor(state.State))
	dc.SetLineWidth(3)
	dc.DrawRoundedRectangle(inset, inset, w-inset*2, h-inset*2, cardRadius)
	dc.Stroke()

	// Text rendering
	label := strings.TrimSpace(state.Label)
	subtitle := strings.TrimSpace(state.Subtitle)

	if label != "" {
		if subtitle != "" {
			// Two-line layout: large primary near top, small subtitle near bottom
			primarySize := fitButtonFontSize(dc, label, w-24, math.Max(20, w*0.2), gobold.TTF)
			if face, err := loadButtonFontFace(gobold.TTF, primarySize); err == nil {
				dc.SetFontFace(face)
			}
			dc.SetHexColor("#eef4ff")
			dc.DrawStringAnchored(label, w/2, h*0.38, 0.5, 0.5)

			subSize := fitButtonFontSize(dc, subtitle, w-26, math.Max(11, w*0.1), goregular.TTF)
			if face, err := loadButtonFontFace(goregular.TTF, subSize); err == nil {
				dc.SetFontFace(face)
			}
			dc.SetHexColor("#aeb6c0")
			dc.DrawStringAnchored(subtitle, w/2, h*0.68, 0.5, 0.5)
		} else {
			// Single-line layout: bold label centered
			labelSize := fitButtonFontSize(dc, label, w-24, math.Max(20, w*0.2), gobold.TTF)
			if face, err := loadButtonFontFace(gobold.TTF, labelSize); err == nil {
				dc.SetFontFace(face)
			}
			dc.SetHexColor("#eef4ff")
			dc.DrawStringAnchored(label, w/2, h*0.56, 0.5, 0.5)
		}
	}

	var buf bytes.Buffer
	if err := dc.EncodePNG(&buf); err != nil {
		return nil, fmt.Errorf("failed to encode PNG: %w", err)
	}
	return buf.Bytes(), nil
}

// getBorderColor returns the WebHID-style colored border hex for a given state.
func getBorderColor(state string) string {
	switch state {
	case "TALK":
		return "#ff2d26" // red — active/transmitting
	case "LISTEN":
		return "#26d07c" // green — listening
	case "BROADCAST":
		return "#ffc067" // orange — broadcast/call
	default: // IDLE
		return "#1b2026" // near-black — idle
	}
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
func fitButtonFontSize(dc *gg.Context, text string, maxWidth, initialSize float64, ttfBytes []byte) float64 {
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
		primary, subtitle := s.resolveButtonLabel(ctx, button)
		state := ButtonState{
			State:    "IDLE",
			Label:    primary,
			Subtitle: subtitle,
			Channel:  companionButtonChannel(button),
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
