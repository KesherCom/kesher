package app

import (
	"context"
	"testing"

	"github.com/fogleman/gg"
)

func TestSplitAndNormalizeButtonLabel(t *testing.T) {
	cases := []struct{ raw, name, subtitle, normalized string }{
		{"FOH", "FOH", "", "FOH"},
		{" Party Line 1 \n FOH ", "Party Line 1", "FOH", "Party Line 1\nFOH"},
		{"\nFOH", "", "FOH", "\nFOH"},
		{"Reply\r\nBen", "Reply", "Ben", "Reply\nBen"},
		{"  ", "", "", ""},
	}
	for _, c := range cases {
		name, subtitle := splitButtonLabel(c.raw)
		if name != c.name || subtitle != c.subtitle {
			t.Fatalf("splitButtonLabel(%q) = %q, %q; want %q, %q", c.raw, name, subtitle, c.name, c.subtitle)
		}
		if got := normalizeButtonLabel(c.raw); got != c.normalized {
			t.Fatalf("normalizeButtonLabel(%q) = %q; want %q", c.raw, got, c.normalized)
		}
	}
}

func TestResolveButtonLabelKeepsAutomaticNameWithOwnSubtitle(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	if err := s.store.CreateRoom(ctx, "pl-main", "PL Main", nil, nil, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}
	button := StreamDeckButtonConfig{
		Index:  0,
		Label:  "\nStage left",
		Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePTTRoom, RoomID: "pl-main"},
	}
	name, subtitle := s.resolveButtonLabel(ctx, button)
	if name != "PL Main" || subtitle != "Stage left" {
		t.Fatalf("got %q / %q, want the room name with the own subtitle", name, subtitle)
	}
}

func TestMicGainLabelShowsDirection(t *testing.T) {
	if got := micGainLabel(2); got != "Mic +2 dB" {
		t.Fatalf("got %q", got)
	}
	if got := micGainLabel(-1); got != "Mic −1 dB" {
		t.Fatalf("got %q", got)
	}
	if keyIconFor(ButtonState{ActionType: "volume_delta", VolumeDelta: -2}) != "mic-minus" {
		t.Fatal("expected the minus icon for a negative step")
	}
	if keyIconFor(ButtonState{ActionType: "volume_delta", VolumeDelta: 1}) != "mic-plus" {
		t.Fatal("expected the plus icon for a positive step")
	}
}

func TestKeyLayoutKeepsNamesInsideTheKey(t *testing.T) {
	r, err := NewButtonImageRenderer(nil)
	if err != nil {
		t.Fatal(err)
	}
	dc := gg.NewContext(72, 72)
	maxWidth := 72 - 2*keyPadding
	for _, label := range []string{"Bühnenmanagement", "Donaudampfschifffahrtsgesellschaft", "Lighting Booth Left", "Party Line 1"} {
		r.mu.Lock()
		layout := r.layoutKey(dc, label, "Camera", "mic", true, 72, 72, 1)
		dc.SetFontFace(r.face(true, layout.nameSize))
		for _, line := range layout.nameLines {
			if width, _ := dc.MeasureString(line); width > maxWidth+0.5 {
				r.mu.Unlock()
				t.Fatalf("%q: line %q is %.1f px wide, key has %.1f", label, line, width, maxWidth)
			}
		}
		r.mu.Unlock()
		if len(layout.nameLines) == 0 {
			t.Fatalf("%q: no name drawn", label)
		}
	}
	// A short name keeps its icon; a long one gives it up before shrinking further.
	r.mu.Lock()
	short := r.layoutKey(dc, "FOH", "", "mic", false, 72, 72, 1)
	r.mu.Unlock()
	if !short.showIcon {
		t.Fatal("expected the icon on a short name")
	}
}
