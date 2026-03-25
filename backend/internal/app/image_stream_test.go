package app

import (
	"bytes"
	"image/png"
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
