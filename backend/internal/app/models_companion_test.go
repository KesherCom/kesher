package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompanionCommandMarshalIncludesEmptyRoomMatrixArrays(t *testing.T) {
	payload, err := json.Marshal(CompanionCommand{
		Command:       "set_room_matrix",
		ListenRoomIDs: []string{},
		TalkRoomIDs:   []string{},
	})
	if err != nil {
		t.Fatalf("json marshal failed: %v", err)
	}
	jsonText := string(payload)
	if !strings.Contains(jsonText, `"listenRoomIds":[]`) {
		t.Fatalf("expected listenRoomIds to be serialized as empty array, got %s", jsonText)
	}
	if !strings.Contains(jsonText, `"talkRoomIds":[]`) {
		t.Fatalf("expected talkRoomIds to be serialized as empty array, got %s", jsonText)
	}
}

func TestDefaultStreamDeckSettingsStartsWithUnassignedButtons(t *testing.T) {
	settings := DefaultStreamDeckSettings()
	if len(settings.Pages) == 0 {
		t.Fatal("expected at least one page")
	}
	if settings.Pages[0].PageType != "" && settings.Pages[0].PageType != StreamDeckPageTypeManual {
		t.Fatalf("expected default page type to be manual-compatible, got %q", settings.Pages[0].PageType)
	}
	for _, button := range settings.Pages[0].Buttons {
		if button.Action != nil {
			t.Fatalf("expected default button index %d to be unassigned", button.Index)
		}
	}
}
