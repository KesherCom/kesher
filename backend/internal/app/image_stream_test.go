package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
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
