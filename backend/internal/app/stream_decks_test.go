package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func addPlaceClient(s *Server, token, userID, username, roleID, placeID string, connectedAt time.Time) *client {
	c := &client{
		session:      Session{Token: token, UserID: userID, Username: username, RoleID: roleID, PlaceID: placeID, ExpiresAt: connectedAt.Add(time.Hour)},
		user:         User{ID: userID, Username: username, RoleID: roleID},
		connectedAt:  connectedAt,
		send:         make(chan WSOutbound, 16),
		sendPriority: make(chan WSOutbound, 16),
		listenRooms:  map[string]struct{}{},
		talkRooms:    map[string]struct{}{},
	}
	s.hub.Add(c)
	return c
}

func TestStreamDeckIDsAndStore(t *testing.T) {
	ctx := context.Background()
	s := newCompanionTestServer(t)
	for raw, want := range map[string]string{
		"  Kamera 1   links ": "kamera 1 links",
		"CL12K1A00042":        "cl12k1a00042",
	} {
		deck, err := s.store.TouchStreamDeck(ctx, raw, "10.0.0.5")
		if err != nil || deck.ID != want {
			t.Fatalf("TouchStreamDeck(%q) = %q, %v; want %q", raw, deck.ID, err, want)
		}
	}
	for _, bad := range []string{"", "a/b", "bell\x07"} {
		if _, err := s.store.TouchStreamDeck(ctx, bad, ""); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("TouchStreamDeck(%q) should be rejected, got %v", bad, err)
		}
	}
	deck, _ := s.store.GetStreamDeck(ctx, "kamera 1 links")
	if deck.Name != "Kamera 1 links" || deck.PlaceID != "" || deck.HasLayout {
		t.Fatalf("unexpected new deck: %+v", deck)
	}

	layout := DefaultStreamDeckSettings()
	layout.Pages[0].Buttons[0].Label = "Talk"
	if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, &layout); err != nil {
		t.Fatal(err)
	}
	if got, err := s.store.GetStreamDeckLayout(ctx, deck.ID); err != nil || got.Pages[0].Buttons[0].Label != "Talk" {
		t.Fatalf("layout not stored: %v", err)
	}
	if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.GetStreamDeckLayout(ctx, deck.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("layout should be gone, got %v", err)
	}
}

// Two people share the camera role at two places; the deck at place-1 must
// control the person there, not the newest login of the role.
func TestStreamDeckControlsItsPlace(t *testing.T) {
	ctx := context.Background()
	s := newCompanionTestServer(t)
	now := time.Now()
	anna := addPlaceClient(s, "token-anna", "u-anna", "anna", "camera", "place-1", now)
	ben := addPlaceClient(s, "token-ben", "u-ben", "ben", "camera", "place-2", now.Add(time.Second))

	deck, err := s.store.TouchStreamDeck(ctx, "Kamera 1", "")
	if err != nil {
		t.Fatal(err)
	}
	key := deckKey(deck.ID)
	if _, unbound := s.deckUnbound(ctx, key); !unbound {
		t.Fatal("a new deck has no place")
	}
	if got := s.companionTargetUsername(ctx, key); got != "" {
		t.Fatalf("an unbound deck controls nobody, got %q", got)
	}

	// Anna pairs it with the code the deck shows.
	code := s.deckState.pairingCode(deck.ID)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/user/stream-decks/pair", bytes.NewBufferString(`{"code":"`+code+`"}`))
	s.handleUserStreamDecks(rec, req, anna.session)
	if rec.Code != http.StatusOK {
		t.Fatalf("pair: %d %s", rec.Code, rec.Body.String())
	}
	if got := s.companionTargetUsername(ctx, key); got != "anna" {
		t.Fatalf("deck should control anna, got %q", got)
	}
	if role := s.companionTargetRole(ctx, key); role != "camera" {
		t.Fatalf("deck should use anna's role, got %q", role)
	}
	if _, ok := s.deckState.deckForCode(code); ok {
		t.Fatal("the code is used up after pairing")
	}

	// A button press goes to anna's session only.
	layout := DefaultStreamDeckSettings()
	layout.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeMuteToggle}
	if _, err := s.store.SetStreamDeckLayout(ctx, deck.ID, &layout); err != nil {
		t.Fatal(err)
	}
	drain := func(c *client) int {
		n := 0
		for {
			select {
			case msg := <-c.send:
				if msg.Type == "companion_command" {
					n++
				}
			case msg := <-c.sendPriority:
				if msg.Type == "companion_command" {
					n++
				}
			default:
				return n
			}
		}
	}
	drain(anna)
	drain(ben)
	result := s.executeCompanionButtonPress(ctx, key, "anna", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !result.OK {
		t.Fatalf("press failed: %+v", result)
	}
	if drain(anna) != 1 || drain(ben) != 0 {
		t.Fatal("the command must reach the deck's place only")
	}

	// Somebody else logs in at place-1: the deck follows.
	s.hub.Remove("token-anna")
	addPlaceClient(s, "token-carl", "u-carl", "carl", "audio", "place-1", now.Add(2*time.Second))
	if got := s.companionTargetUsername(ctx, key); got != "carl" {
		t.Fatalf("deck should follow the place, got %q", got)
	}
}

func TestStreamDeckLayoutFallsBackToRole(t *testing.T) {
	ctx := context.Background()
	s := newCompanionTestServer(t)
	addPlaceClient(s, "token-anna", "u-anna", "anna", "camera", "place-1", time.Now())
	roleLayout := DefaultStreamDeckSettings()
	roleLayout.Pages[0].Buttons[1].Label = "Role layout"
	if _, err := s.store.UpsertRoleStreamDeckSettings(ctx, "camera", roleLayout); err != nil {
		t.Fatal(err)
	}
	deck, _ := s.store.TouchStreamDeck(ctx, "Kamera 1", "")
	if err := s.store.UpdateStreamDeck(ctx, deck.ID, deck.Name, "place-1", "anna"); err != nil {
		t.Fatal(err)
	}
	key := deckKey(deck.ID)
	got, err := s.companionLayout(ctx, key)
	if err != nil || got.Pages[0].Buttons[1].Label != "Role layout" {
		t.Fatalf("without its own layout the deck shows the role's: %v", err)
	}
	before := s.deckLayoutVersion(ctx, deck.ID)

	// The editor at that place saves a layout for the deck, not the role.
	own := DefaultStreamDeckSettings()
	own.Pages[0].Buttons[1].Label = "Deck layout"
	body, _ := json.Marshal(own)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/user/stream-deck/settings", bytes.NewReader(body))
	s.handleUserStreamDeckSettings(rec, req, Session{UserID: "u-anna", Username: "anna", RoleID: "camera", PlaceID: "place-1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	if got, _ := s.companionLayout(ctx, key); got.Pages[0].Buttons[1].Label != "Deck layout" {
		t.Fatal("deck layout not used")
	}
	if role, _ := s.store.GetRoleStreamDeckSettings(ctx, "camera"); role.Pages[0].Buttons[1].Label != "Role layout" {
		t.Fatal("the role layout must stay untouched")
	}
	if after := s.deckLayoutVersion(ctx, deck.ID); after <= before {
		t.Fatalf("profile version must grow on a layout change: %d -> %d", before, after)
	}
}

func TestStreamDeckPairingRejectsUnknownCodeAndClientsWithoutPlace(t *testing.T) {
	s := newCompanionTestServer(t)
	deck, _ := s.store.TouchStreamDeck(context.Background(), "Deck", "")
	code := s.deckState.pairingCode(deck.ID)

	rec := httptest.NewRecorder()
	s.handleUserStreamDecks(rec, httptest.NewRequest(http.MethodPost, "/api/user/stream-decks/pair", bytes.NewBufferString(`{"code":"`+code+`"}`)), Session{Username: "old-client"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a client without place id cannot pair, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.handleUserStreamDecks(rec, httptest.NewRequest(http.MethodPost, "/api/user/stream-decks/pair", bytes.NewBufferString(`{"code":"0000"}`)), Session{Username: "anna", PlaceID: "place-1"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown code: expected 404, got %d", rec.Code)
	}
}

// The Companion endpoints with ?deck=: discovery registers the deck, the
// bridge reports its pairing code until it is paired, then who it controls.
func TestStreamDeckCompanionEndpoints(t *testing.T) {
	s := newCompanionTestServer(t)
	s.upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/companion/discovery", s.handleCompanionDiscovery)
	mux.HandleFunc("/api/companion/ws", s.handleCompanionWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	res, err := http.Get(srv.URL + "/api/companion/discovery?deck=Kamera%201")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("discovery: %v %v", err, res.Status)
	}
	res.Body.Close()
	deck, err := s.store.GetStreamDeck(context.Background(), "kamera 1")
	if err != nil {
		t.Fatalf("discovery should register the deck: %v", err)
	}

	readState := func(ws *websocket.Conn) CompanionBridgeState {
		t.Helper()
		_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
		for {
			var msg struct {
				Type string               `json:"type"`
				Data CompanionBridgeState `json:"data"`
			}
			if err := ws.ReadJSON(&msg); err != nil {
				t.Fatalf("read: %v", err)
			}
			if msg.Type == "companion_state" {
				return msg.Data
			}
		}
	}
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/companion/ws?deck=Kamera%201"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	state := readState(ws)
	ws.Close()
	if state.DeckName != "Kamera 1" || state.PairingCode != s.deckState.pairingCode(deck.ID) || state.Bound {
		t.Fatalf("unpaired deck state: %+v", state)
	}

	addPlaceClient(s, "token-anna", "u-anna", "anna", "camera", "place-1", time.Now())
	if err := s.store.UpdateStreamDeck(context.Background(), deck.ID, deck.Name, "place-1", "anna"); err != nil {
		t.Fatal(err)
	}
	ws, _, err = websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	state = readState(ws)
	if state.Username != "anna" || !state.Bound || state.PairingCode != "" {
		t.Fatalf("paired deck state: %+v", state)
	}
}
