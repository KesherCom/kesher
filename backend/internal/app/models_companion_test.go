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
