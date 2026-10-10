package app

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"testing"

	"github.com/fogleman/gg"
	"github.com/golang/freetype/truetype"
	"golang.org/x/image/font"
)

// TestKeyDesignSheet renders docs/design/stream-deck-keys.png, the
// reference of every key design. It only runs on request:
//
//	KESHER_KEY_SHEET=../../../docs/design go test -run TestKeyDesignSheet ./internal/app
func TestKeyDesignSheet(t *testing.T) {
	outDir := os.Getenv("KESHER_KEY_SHEET")
	if outDir == "" {
		t.Skip("set KESHER_KEY_SHEET to the output directory to render the sheet")
	}
	const size = 144
	r, _ := NewButtonImageRenderer(&ButtonImageRenderConfig{Width: size, Height: size})
	type entry struct {
		caption string
		state   ButtonState
	}
	groups := []struct {
		title   string
		entries []entry
	}{
		{"Party line keys", []entry{
			{"idle", ButtonState{ActionType: "ptt_room", Label: "Party Line 1"}},
			{"you hear it", ButtonState{ActionType: "ptt_room", Label: "Party Line 1", IsListening: true}},
			{"you talk (held)", ButtonState{ActionType: "ptt_room", Label: "Party Line 1", State: "TALK", IsListening: true}},
			{"selected to talk on", ButtonState{ActionType: "select_talk_room", Label: "FOH", IsPTTSelected: true, IsListening: true}},
			{"listen key, on", ButtonState{ActionType: "listen_room", Label: "Stage", IsListening: true, State: "LISTEN"}},
			{"listen key, off", ButtonState{ActionType: "listen_room", Label: "Stage"}},
		}},
		{"Calls and people", []entry{
			{"call a line", ButtonState{ActionType: "call_room", Label: "Call FOH"}},
			{"calling (held)", ButtonState{ActionType: "call_room", Label: "Call FOH", State: "TALK"}},
			{"talk to a person", ButtonState{ActionType: "direct_user", Label: "Tim", Subtitle: "Camera"}},
			{"reply, no call", ButtonState{ActionType: "reply_to_caller", Label: "Reply", Subtitle: "No active caller"}},
			{"call waiting (blinks)", ButtonState{ActionType: "reply_to_caller", Label: "Reply", Subtitle: "Ben", State: "CALL", Calling: true}},
			{"incoming, blink off", ButtonState{ActionType: "incoming_call_indicator", Label: "Incoming", Subtitle: "Pastor", Calling: true}},
		}},
		{"Broadcast, mic and pages", []entry{
			{"broadcast", ButtonState{ActionType: "broadcast_ptt", Label: "All crew"}},
			{"broadcasting (held)", ButtonState{ActionType: "broadcast_ptt", Label: "All crew", State: "BROADCAST"}},
			{"mic gain up", ButtonState{ActionType: "volume_delta", Label: "Mic +2 dB", VolumeDelta: 2}},
			{"mic gain down", ButtonState{ActionType: "volume_delta", Label: "Mic −1 dB", VolumeDelta: -1}},
			{"next page", ButtonState{ActionType: "page_up", Label: "Page +"}},
			{"open a page", ButtonState{ActionType: "page_jump", Label: "Cameras"}},
		}},
		{"Names and colors", []entry{
			{"long name: smaller", ButtonState{ActionType: "ptt_room", Label: "Lighting Booth Left"}},
			{"no room: icon goes", ButtonState{ActionType: "direct_user", Label: "Maximilian Schneider", Subtitle: "Camera"}},
			{"long word: split", ButtonState{ActionType: "direct_role", Label: "Bühnenmanagement"}},
			{"own frame color", ButtonState{ActionType: "ptt_room", Label: "Video", Color: "#8b5cf6"}},
			{"pairing code", ButtonState{ActionType: "none", Label: "4821", Subtitle: "Pairing code"}},
			{"unassigned", ButtonState{}},
		}},
	}

	const cols = 6
	const cell = size + 40
	const gap = 20
	const titleH = 44
	width := gap + cols*(cell)
	height := gap
	for range groups {
		height += titleH + size + 36 + gap
	}
	dc := gg.NewContext(width, height)
	dc.SetHexColor("#0e1116")
	dc.Clear()
	bold, regular, _ := parsedButtonFonts()
	y := float64(gap)
	for _, g := range groups {
		dc.SetFontFace(sheetFace(bold, 22))
		dc.SetHexColor("#e6eaf0")
		dc.DrawString(g.title, float64(gap), y+26)
		y += titleH
		for i, e := range g.entries {
			x := float64(gap + i*cell)
			buf, err := r.RenderButtonImage(e.state)
			if err != nil {
				t.Fatal(err)
			}
			img, _ := png.Decode(bytes.NewReader(buf))
			dc.DrawImage(img.(image.Image), int(x), int(y))
			dc.SetFontFace(sheetFace(regular, 16))
			dc.SetHexColor("#9aa4b2")
			dc.DrawStringAnchored(e.caption, x+size/2, y+size+20, 0.5, 0.5)
		}
		y += size + 36 + gap
	}
	if err := dc.SavePNG(outDir + "/stream-deck-keys.png"); err != nil {
		t.Fatal(err)
	}
}

func sheetFace(f *truetype.Font, size float64) font.Face {
	return truetype.NewFace(f, &truetype.Options{Size: size, DPI: 72, Hinting: font.HintingFull})
}
