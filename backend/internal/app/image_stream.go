package app

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log/slog"
	"net/http"
	"sync"
	"time"
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
	Channel    string
	State      string // "IDLE", "TALK", "LISTEN", "BROADCAST"
	Label      string
	TalkCount  int
	IsActive   bool
}

// RenderButtonImage renders a button state to a PNG buffer
func (r *ButtonImageRenderer) RenderButtonImage(state ButtonState) ([]byte, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	width := r.config.Width
	height := r.config.Height

	// Create a new RGBA image
	img := image.NewRGBA(image.Rect(0, 0, width, height))

	// Fill background color based on state
	bgColor := getStateColor(state.State)
	draw.Draw(img, img.Bounds(), &image.Uniform{bgColor}, image.Point{}, draw.Src)

	// Draw border
	drawBorder(img, color.White, 1)

	// Draw icon based on state
	drawButtonIcon(img, state.State)

	// Encode to PNG
	var buf bytes.Buffer
	err := png.Encode(&buf, img)
	if err != nil {
		return nil, fmt.Errorf("failed to encode PNG: %w", err)
	}
	return buf.Bytes(), nil
}

func getStateColor(state string) color.Color {
	switch state {
	case "TALK":
		return color.RGBA{0xDC, 0x14, 0x3C, 0xFF} // Crimson red
	case "LISTEN":
		return color.RGBA{0x1E, 0x90, 0xFF, 0xFF} // Dodger blue
	case "BROADCAST":
		return color.RGBA{0xFF, 0x8C, 0x00, 0xFF} // Dark orange
	default:
		return color.RGBA{0x40, 0x40, 0x40, 0xFF} // Dark gray
	}
}

func drawBorder(img *image.RGBA, c color.Color, width int) {
	bounds := img.Bounds()
	// Top
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		for y := 0; y < width; y++ {
			img.Set(x, y, c)
		}
	}
	// Bottom
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		for y := bounds.Max.Y - width; y < bounds.Max.Y; y++ {
			img.Set(x, y, c)
		}
	}
	// Left
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, c)
		}
	}
	// Right
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Max.X - width; x < bounds.Max.X; x++ {
			img.Set(x, y, c)
		}
	}
}

func drawButtonIcon(img *image.RGBA, state string) {
	bounds := img.Bounds()
	centerX := bounds.Max.X / 2
	centerY := bounds.Max.Y / 2
	c := color.White

	switch state {
	case "TALK":
		// Draw microphone icon (circle + stand)
		drawCircle(img, c, centerX, centerY-8, 4, true)
		drawLine(img, c, centerX, centerY-4, centerX, centerY+8)
	case "LISTEN":
		// Draw ear-like shape (two overlapping circles)
		drawCircle(img, c, centerX-4, centerY, 3, true)
		drawCircle(img, c, centerX+4, centerY, 3, true)
	case "BROADCAST":
		// Draw broadcast signal (concentric circles)
		drawCircle(img, c, centerX, centerY, 2, true)
		drawCircle(img, c, centerX, centerY, 6, false)
	default:
		// Draw dash for IDLE
		drawLine(img, c, centerX-6, centerY, centerX+6, centerY)
	}
}

func drawCircle(img *image.RGBA, c color.Color, cx, cy, r int, filled bool) {
	for x := cx - r; x <= cx+r; x++ {
		for y := cy - r; y <= cy+r; y++ {
			dx := x - cx
			dy := y - cy
			dist := dx*dx + dy*dy
			rsq := r * r
			if filled {
				if dist <= rsq {
					bounds := img.Bounds()
					if x >= bounds.Min.X && x < bounds.Max.X && y >= bounds.Min.Y && y < bounds.Max.Y {
						img.Set(x, y, c)
					}
				}
			} else {
				if dist <= rsq && dist >= (r-1)*(r-1) {
					bounds := img.Bounds()
					if x >= bounds.Min.X && x < bounds.Max.X && y >= bounds.Min.Y && y < bounds.Max.Y {
						img.Set(x, y, c)
					}
				}
			}
		}
	}
}

func drawLine(img *image.RGBA, c color.Color, x1, y1, x2, y2 int) {
	dx := x2 - x1
	dy := y2 - y1
	steps := abs(dx)
	if abs(dy) > steps {
		steps = abs(dy)
	}
	if steps == 0 {
		bounds := img.Bounds()
		if x1 >= bounds.Min.X && x1 < bounds.Max.X && y1 >= bounds.Min.Y && y1 < bounds.Max.Y {
			img.Set(x1, y1, c)
		}
		return
	}

	for i := 0; i <= steps; i++ {
		x := x1 + dx*i/steps
		y := y1 + dy*i/steps
		bounds := img.Bounds()
		if x >= bounds.Min.X && x < bounds.Max.X && y >= bounds.Min.Y && y < bounds.Max.Y {
			img.Set(x, y, c)
		}
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
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

	client := &ImageStreamClient{
		send:   make(chan ImageStreamMessage, 16),
		done:   make(chan struct{}),
		logger: s.logger,
	}

	// Register client
	if s.imageStreamCoord != nil {
		s.imageStreamCoord.RegisterClient(client)
		defer s.imageStreamCoord.UnregisterClient(client)
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
			if err := conn.WriteControl(1, []byte{}, time.Now().Add(10*time.Second)); err != nil {
				return
			}

		case <-client.done:
			return
		}
	}
}
