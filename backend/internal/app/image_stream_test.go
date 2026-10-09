package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestButtonImageRendererRenderButtonImageProducesValidPNG(t *testing.T) {
	renderer, err := NewButtonImageRenderer(nil)
	if err != nil {
		t.Fatalf("NewButtonImageRenderer failed: %v", err)
	}

	states := []string{"IDLE", "TALK", "LISTEN", "BROADCAST"}
	for _, state := range states {
		t.Run(state, func(t *testing.T) {
			buf, err := renderer.RenderButtonImage(ButtonState{
				State:   state,
				Label:   state,
				Channel: "debug",
			})
			if err != nil {
				t.Fatalf("RenderButtonImage failed: %v", err)
			}
			if len(buf) == 0 {
				t.Fatal("RenderButtonImage returned empty buffer")
			}

			img, err := png.Decode(bytes.NewReader(buf))
			if err != nil {
				t.Fatalf("png.Decode failed: %v", err)
			}
			if gotW, gotH := img.Bounds().Dx(), img.Bounds().Dy(); gotW != 72 || gotH != 72 {
				t.Fatalf("unexpected image size: got %dx%d want 72x72", gotW, gotH)
			}
		})
	}
}

func TestGetButtonPaletteUsesYellowPressedPaletteForCallRoom(t *testing.T) {
	palette := getButtonPalette(string(StreamDeckActionTypeCallRoom), "", true)
	if palette.background != "#f2c94c" {
		t.Fatalf("unexpected pressed call background: got %q", palette.background)
	}
	if palette.border != "#ffd76a" {
		t.Fatalf("unexpected pressed call border: got %q", palette.border)
	}
	if palette.label != "#2a2110" {
		t.Fatalf("unexpected pressed call label: got %q", palette.label)
	}
}

func TestButtonImageRendererRenderButtonImageRendersTopAndBottomStatusStripes(t *testing.T) {
	renderer, err := NewButtonImageRenderer(&ButtonImageRenderConfig{Width: 112, Height: 112})
	if err != nil {
		t.Fatalf("NewButtonImageRenderer failed: %v", err)
	}

	buf, err := renderer.RenderButtonImage(ButtonState{
		State:         "IDLE",
		Label:         "PL A",
		ActionType:    string(StreamDeckActionTypeSelectTalkRoom),
		IsListening:   true,
		IsPTTSelected: true,
	})
	if err != nil {
		t.Fatalf("RenderButtonImage failed: %v", err)
	}

	img, err := png.Decode(bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("png.Decode failed: %v", err)
	}

	assertPixelNearRGB(t, img, 56, 8, 255, 45, 38)
	assertPixelNearRGB(t, img, 56, 103, 20, 198, 75)
}

func assertPixelNearRGB(t *testing.T, img image.Image, x, y int, wantR, wantG, wantB uint8) {
	t.Helper()
	r, g, b, _ := img.At(x, y).RGBA()
	gotR := uint8(r >> 8)
	gotG := uint8(g >> 8)
	gotB := uint8(b >> 8)

	within := func(got, want uint8) bool {
		const tolerance = 8
		if got > want {
			return got-want <= tolerance
		}
		return want-got <= tolerance
	}

	if !within(gotR, wantR) || !within(gotG, wantG) || !within(gotB, wantB) {
		t.Fatalf("unexpected pixel at (%d,%d): got rgb(%d,%d,%d), want near rgb(%d,%d,%d)", x, y, gotR, gotG, gotB, wantR, wantG, wantB)
	}
}

func TestHandleUserStreamDeckPreviewRendersPNGImages(t *testing.T) {
	server := &Server{}
	body := map[string]any{
		"width":  112,
		"height": 112,
		"buttons": []map[string]any{
			{
				"buttonIndex": 0,
				"label":       "Reply",
				"subtitle":    "Caller",
				"actionType":  string(StreamDeckActionTypeReplyToCaller),
				"state":       "TALK",
				"isActive":    true,
			},
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/user/stream-deck/preview", bytes.NewReader(payload))
	rec := httptest.NewRecorder()

	server.handleUserStreamDeckPreview(rec, req, Session{})

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d want %d", rec.Code, http.StatusOK)
	}

	var res streamDeckPreviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if res.Width != 112 || res.Height != 112 {
		t.Fatalf("unexpected preview size: got %dx%d", res.Width, res.Height)
	}
	if len(res.Images) != 1 {
		t.Fatalf("unexpected image count: got %d want 1", len(res.Images))
	}
	rawPNG, err := base64.StdEncoding.DecodeString(res.Images[0].ImageBuffer)
	if err != nil {
		t.Fatalf("base64 decode failed: %v", err)
	}
	decoded, err := png.Decode(bytes.NewReader(rawPNG))
	if err != nil {
		t.Fatalf("png.Decode failed: %v", err)
	}
	if gotW, gotH := decoded.Bounds().Dx(), decoded.Bounds().Dy(); gotW != 112 || gotH != 112 {
		t.Fatalf("unexpected image size: got %dx%d want 112x112", gotW, gotH)
	}
}

func TestImageStreamCoordinatorSkipsUnchangedButtonState(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	coord, err := NewImageStreamCoordinator(logger)
	if err != nil {
		t.Fatalf("NewImageStreamCoordinator failed: %v", err)
	}

	client := &ImageStreamClient{
		RoleID:   "role-a",
		Username: "operator",
		send:     make(chan ImageStreamMessage, 4),
		done:     make(chan struct{}),
		logger:   logger,
	}
	coord.RegisterClient(client)
	defer coord.UnregisterClient(client)

	state := ButtonState{
		Channel:    "room-a",
		State:      "IDLE",
		Label:      "Room A",
		ActionType: string(StreamDeckActionTypePTTRoom),
	}

	coord.BroadcastImageUpdateForTarget("role-a", "operator", state, 0, 2)
	select {
	case <-client.send:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("expected first update to be delivered")
	}

	coord.BroadcastImageUpdateForTarget("role-a", "operator", state, 0, 2)
	select {
	case msg := <-client.send:
		t.Fatalf("expected unchanged update to be skipped, got %+v", msg)
	case <-time.After(50 * time.Millisecond):
	}

	changed := state
	changed.State = "TALK"
	coord.BroadcastImageUpdateForTarget("role-a", "operator", changed, 0, 2)
	select {
	case msg := <-client.send:
		if msg.State != "TALK" {
			t.Fatalf("expected changed state TALK, got %q", msg.State)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("expected changed update to be delivered")
	}
}

func TestImageStreamCoordinatorRoleOnlyClientReceivesTargetedRoleUpdates(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	coord, err := NewImageStreamCoordinator(logger)
	if err != nil {
		t.Fatalf("NewImageStreamCoordinator failed: %v", err)
	}

	client := &ImageStreamClient{
		RoleID: "role-a",
		send:   make(chan ImageStreamMessage, 2),
		done:   make(chan struct{}),
		logger: logger,
	}
	coord.RegisterClient(client)
	defer coord.UnregisterClient(client)

	coord.BroadcastImageUpdateForTarget("role-a", "operator", ButtonState{
		Channel:    "room-a",
		State:      "TALK",
		Label:      "Room A",
		ActionType: string(StreamDeckActionTypePTTRoom),
	}, 0, 0)

	select {
	case msg := <-client.send:
		if msg.State != "TALK" {
			t.Fatalf("expected TALK state, got %q", msg.State)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("expected role-only client to receive targeted update")
	}
}

func TestResolveImageStreamTargetKeepsRoleOnlyBindingWithoutUsername(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()

	if err := s.store.CreateRole(ctx, "source", "Source", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	user, err := s.store.UpsertUser(ctx, "operator", "source")
	if err != nil {
		t.Fatalf("UpsertUser failed: %v", err)
	}
	s.sessions.Create(user)

	req := httptest.NewRequest(http.MethodGet, "/api/companion/image-stream?roleId=source", nil)
	roleID, username := s.resolveImageStreamTarget(ctx, req)
	if roleID != "source" {
		t.Fatalf("expected roleID source, got %q", roleID)
	}
	if username != "" {
		t.Fatalf("expected empty username for role-only binding, got %q", username)
	}
}

func TestButtonImageRendererReusesRenderedImages(t *testing.T) {
	renderer, err := NewButtonImageRenderer(nil)
	if err != nil {
		t.Fatalf("NewButtonImageRenderer failed: %v", err)
	}
	state := ButtonState{Label: "Party Line 1", Subtitle: "FOH", ActionType: "select_talk_room", IsListening: true}

	first, err := renderer.RenderButtonImage(state)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	second, err := renderer.RenderButtonImage(state)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	if &first[0] != &second[0] {
		t.Fatal("expected the same key state to come from the cache")
	}

	encoded, err := renderer.RenderButtonImageBase64(state)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	if encoded != base64.StdEncoding.EncodeToString(first) {
		t.Fatal("base64 image does not match the PNG")
	}

	state.IsPTTSelected = true
	changed, err := renderer.RenderButtonImage(state)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	if bytes.Equal(first, changed) {
		t.Fatal("expected a different image for a different key state")
	}
}

func TestButtonImageRendererIsSafeForConcurrentUse(t *testing.T) {
	renderer, err := buttonImageRendererForSize(96, 96)
	if err != nil {
		t.Fatalf("renderer failed: %v", err)
	}
	done := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func(i int) {
			_, err := renderer.RenderButtonImage(ButtonState{Label: "Key", Subtitle: string(rune('A' + i))})
			done <- err
		}(i)
	}
	for i := 0; i < 8; i++ {
		if err := <-done; err != nil {
			t.Fatalf("concurrent render failed: %v", err)
		}
	}
	again, _ := buttonImageRendererForSize(96, 96)
	if again != renderer {
		t.Fatal("expected one shared renderer per size")
	}
}

func BenchmarkRenderButtonImageUncached(b *testing.B) {
	renderer, _ := NewButtonImageRenderer(nil)
	for i := 0; i < b.N; i++ {
		// A new label each time defeats the image cache: measures drawing.
		state := ButtonState{Label: "Party Line " + strconv.Itoa(i), Subtitle: "Ben talking", ActionType: "select_talk_room", IsListening: true}
		if _, err := renderer.RenderButtonImage(state); err != nil {
			b.Fatal(err)
		}
	}
}

func TestRenderButtonImageDrawsIncomingCallInYellow(t *testing.T) {
	renderer, err := NewButtonImageRenderer(nil)
	if err != nil {
		t.Fatalf("NewButtonImageRenderer failed: %v", err)
	}
	buf, err := renderer.RenderButtonImage(ButtonState{State: "CALL", Calling: true, ActionType: "reply_to_caller"})
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	r, g, b, _ := img.At(36, 36).RGBA()
	// #facc15: strong red and green, little blue.
	if r>>8 < 0xe0 || g>>8 < 0xb0 || b>>8 > 0x40 {
		t.Fatalf("expected a yellow call key, got rgb(%d,%d,%d)", r>>8, g>>8, b>>8)
	}
}
