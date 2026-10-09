package app

// Stream Decks that belong to a place, not to a role.
//
// A place is one client installation: a browser profile, a desktop app or a
// station. It sends a stable placeId at login. A Stream Deck reaches the
// server through the Companion module with ?deck=<serial or name> (one
// Companion connection per deck, so a central Companion with satellites
// works) and is bound to a place: in the admin area (Stream Decks) or by the
// person at that place, who types the code the unbound deck shows.
//
// The deck then controls whoever is logged in at its place, with that
// login's rights. Its layout is its own (edited from that place) or, until
// one is saved, the layout of that login's role.
//
// Companion state that used to be keyed by role ID (current page, held
// buttons, result fan-out, image clients) is keyed by "deck:<id>" for decks;
// connections with ?roleId= keep working as before.

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	companionDeckKeyPrefix = "deck:"
	// Unauthenticated Companion connections may register at most this many
	// decks.
	maxStreamDecks = 200
)

var errTooManyStreamDecks = errors.New("too many stream decks")

type StreamDeck struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	PlaceID    string `json:"placeId"`
	PlaceLabel string `json:"placeLabel"`
	// HasLayout: the deck has its own layout; otherwise it shows the layout
	// of the role logged in at its place.
	HasLayout  bool   `json:"hasLayout"`
	Surface    string `json:"surface"`
	LastIP     string `json:"lastIp"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt"`

	// Filled in for the admin view, not stored.
	Connected   bool   `json:"connected"`
	Username    string `json:"username,omitempty"`
	RoleID      string `json:"roleId,omitempty"`
	PairingCode string `json:"pairingCode,omitempty"`
}

// Place: a client installation that is connected right now.
type Place struct {
	PlaceID  string `json:"placeId"`
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

func (s *Store) ensureStreamDecksSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS stream_decks (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		place_id TEXT NOT NULL DEFAULT '',
		place_label TEXT NOT NULL DEFAULT '',
		layout_json TEXT NOT NULL DEFAULT '',
		surface TEXT NOT NULL DEFAULT '',
		last_ip TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL
	)`)
	return err
}

// normalizeStreamDeckID turns what the Companion connection sends (a serial
// number or a name like "Kamera 1 links") into an ID: trimmed, single spaces,
// lower case, at most 64 characters, no control characters or slashes.
func normalizeStreamDeckID(raw string) (id, name string, ok bool) {
	name = strings.Join(strings.Fields(raw), " ")
	if name == "" || len(name) > 64 {
		return "", "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) || r == '/' || r == '\\' || r == '?' || r == '#' {
			return "", "", false
		}
	}
	return strings.ToLower(name), name, true
}

// normalizePlaceID accepts the placeId a client sends at login.
func normalizePlaceID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 80 {
		return ""
	}
	for _, r := range raw {
		if !(r == '-' || r == '_' || r == ':' || r == '.' || unicode.IsLetter(r) || unicode.IsDigit(r)) {
			return ""
		}
	}
	return raw
}

const streamDeckColumns = `id, name, place_id, place_label, layout_json != '', surface, last_ip, created_at, last_seen_at`

func scanStreamDeck(row interface{ Scan(...any) error }) (StreamDeck, error) {
	var d StreamDeck
	err := row.Scan(&d.ID, &d.Name, &d.PlaceID, &d.PlaceLabel, &d.HasLayout, &d.Surface, &d.LastIP, &d.CreatedAt, &d.LastSeenAt)
	return d, err
}

// TouchStreamDeck registers a deck on first contact and records when and
// from where it was last seen.
func (s *Store) TouchStreamDeck(ctx context.Context, rawID, ip string) (StreamDeck, error) {
	id, name, ok := normalizeStreamDeckID(rawID)
	if !ok {
		return StreamDeck{}, ErrInvalidInput
	}
	now := time.Now().UnixMilli()
	existing, err := s.GetStreamDeck(ctx, id)
	switch {
	case err == nil:
		// Companion polls every few seconds; write at most every 30 s.
		if now-existing.LastSeenAt < 30_000 && existing.LastIP == ip {
			return existing, nil
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE stream_decks SET last_seen_at = ?, last_ip = ? WHERE id = ?`, now, ip, id); err != nil {
			return StreamDeck{}, err
		}
	case !errors.Is(err, ErrNotFound):
		return StreamDeck{}, err
	default:
		var count int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM stream_decks`).Scan(&count); err != nil {
			return StreamDeck{}, err
		}
		if count >= maxStreamDecks {
			return StreamDeck{}, errTooManyStreamDecks
		}
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO stream_decks (id, name, last_ip, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
			id, name, ip, now, now); err != nil {
			return StreamDeck{}, err
		}
	}
	return s.GetStreamDeck(ctx, id)
}

func (s *Store) GetStreamDeck(ctx context.Context, id string) (StreamDeck, error) {
	d, err := scanStreamDeck(s.db.QueryRowContext(ctx, `SELECT `+streamDeckColumns+` FROM stream_decks WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return StreamDeck{}, ErrNotFound
	}
	return d, err
}

func (s *Store) ListStreamDecks(ctx context.Context) ([]StreamDeck, error) {
	return s.queryStreamDecks(ctx, `SELECT `+streamDeckColumns+` FROM stream_decks ORDER BY name`)
}

func (s *Store) StreamDecksForPlace(ctx context.Context, placeID string) ([]StreamDeck, error) {
	if placeID == "" {
		return []StreamDeck{}, nil
	}
	return s.queryStreamDecks(ctx, `SELECT `+streamDeckColumns+` FROM stream_decks WHERE place_id = ? ORDER BY name`, placeID)
}

func (s *Store) queryStreamDecks(ctx context.Context, query string, args ...any) ([]StreamDeck, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	decks := []StreamDeck{}
	for rows.Next() {
		d, err := scanStreamDeck(rows)
		if err != nil {
			return nil, err
		}
		decks = append(decks, d)
	}
	return decks, rows.Err()
}

// UpdateStreamDeck sets name and place; an empty placeID unbinds the deck.
func (s *Store) UpdateStreamDeck(ctx context.Context, id, name, placeID, placeLabel string) error {
	name = strings.Join(strings.Fields(name), " ")
	placeLabel = strings.TrimSpace(placeLabel)
	if name == "" || len(name) > 64 || len(placeLabel) > 80 {
		return ErrInvalidInput
	}
	placeID = strings.TrimSpace(placeID)
	if placeID != "" && normalizePlaceID(placeID) == "" {
		return ErrInvalidInput
	}
	if placeID == "" {
		placeLabel = ""
	}
	res, err := s.db.ExecContext(ctx, `UPDATE stream_decks SET name = ?, place_id = ?, place_label = ? WHERE id = ?`, name, placeID, placeLabel, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetStreamDeckSurface(ctx context.Context, id, surface string) error {
	surface = strings.TrimSpace(surface)
	if len(surface) > 120 {
		surface = surface[:120]
	}
	_, err := s.db.ExecContext(ctx, `UPDATE stream_decks SET surface = ? WHERE id = ? AND surface != ?`, surface, id, surface)
	return err
}

// GetStreamDeckLayout returns the deck's own layout, or ErrNotFound.
func (s *Store) GetStreamDeckLayout(ctx context.Context, id string) (StreamDeckSettings, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT layout_json FROM stream_decks WHERE id = ?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && raw == "") {
		return StreamDeckSettings{}, ErrNotFound
	}
	if err != nil {
		return StreamDeckSettings{}, err
	}
	var settings StreamDeckSettings
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		return StreamDeckSettings{}, ErrInvalidInput
	}
	return validateStreamDeckSettings(settings)
}

// SetStreamDeckLayout stores the deck's own layout; nil removes it, so the
// deck shows the role layout again.
func (s *Store) SetStreamDeckLayout(ctx context.Context, id string, settings *StreamDeckSettings) (StreamDeckSettings, error) {
	raw := ""
	var validated StreamDeckSettings
	if settings != nil {
		var err error
		validated, err = validateStreamDeckSettings(*settings)
		if err != nil {
			return StreamDeckSettings{}, err
		}
		encoded, err := json.Marshal(validated)
		if err != nil {
			return StreamDeckSettings{}, err
		}
		raw = string(encoded)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE stream_decks SET layout_json = ? WHERE id = ?`, raw, id)
	if err != nil {
		return StreamDeckSettings{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return StreamDeckSettings{}, ErrNotFound
	}
	return validated, nil
}

func (s *Store) DeleteStreamDeck(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM stream_decks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ── runtime state ──

// deckRuntime: what only lives in memory: open Companion connections,
// pairing codes of unbound decks and the profile version the module sees.
type deckRuntime struct {
	mu        sync.Mutex
	connected map[string]int
	codeByID  map[string]string
	idByCode  map[string]string
	versions  map[string]deckProfileVersion
}

type deckProfileVersion struct {
	fingerprint uint64
	version     int
}

func (d *deckRuntime) init() {
	if d.connected == nil {
		d.connected = map[string]int{}
		d.codeByID = map[string]string{}
		d.idByCode = map[string]string{}
		d.versions = map[string]deckProfileVersion{}
	}
}

func (d *deckRuntime) setConnected(id string, delta int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.init()
	d.connected[id] += delta
	if d.connected[id] <= 0 {
		delete(d.connected, id)
	}
}

func (d *deckRuntime) isConnected(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.init()
	return d.connected[id] > 0
}

// pairingCode returns the 4-digit code an unbound deck shows (stable while
// the server runs, unique among decks).
func (d *deckRuntime) pairingCode(id string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.init()
	if code, ok := d.codeByID[id]; ok {
		return code
	}
	for {
		n, err := rand.Int(rand.Reader, big.NewInt(9000))
		if err != nil {
			n = big.NewInt(time.Now().UnixNano() % 9000)
		}
		code := fmt.Sprintf("%04d", n.Int64()+1000)
		if _, taken := d.idByCode[code]; taken {
			continue
		}
		d.codeByID[id] = code
		d.idByCode[code] = id
		return code
	}
}

func (d *deckRuntime) deckForCode(code string) (string, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.init()
	id, ok := d.idByCode[strings.TrimSpace(code)]
	return id, ok
}

func (d *deckRuntime) dropCode(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.init()
	if code, ok := d.codeByID[id]; ok {
		delete(d.idByCode, code)
		delete(d.codeByID, id)
	}
}

// profileVersion grows whenever what the deck shows changes (own layout
// saved, another role logged in at its place), so the module reloads it.
// Seconds since 1970 keep it growing across server restarts.
func (d *deckRuntime) profileVersion(id string, fingerprint uint64) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.init()
	current, ok := d.versions[id]
	if ok && current.fingerprint == fingerprint {
		return current.version
	}
	next := int(time.Now().Unix())
	if next <= current.version {
		next = current.version + 1
	}
	d.versions[id] = deckProfileVersion{fingerprint: fingerprint, version: next}
	return next
}

// ── companion target keys ──

func deckKey(deckID string) string { return companionDeckKeyPrefix + deckID }

func deckIDFromKey(key string) (string, bool) {
	return strings.CutPrefix(key, companionDeckKeyPrefix)
}

// deckSession: the login connected at the deck's place right now.
func (s *Server) deckSession(ctx context.Context, deckID string) (Session, bool) {
	if s.store == nil || s.hub == nil {
		return Session{}, false
	}
	deck, err := s.store.GetStreamDeck(ctx, deckID)
	if err != nil || deck.PlaceID == "" {
		return Session{}, false
	}
	return s.hub.LatestSessionForPlace(deck.PlaceID)
}

// companionTargetRole: the role whose rights apply to a Companion target.
// For a deck it is the role of whoever is logged in at its place ("" when
// nobody is).
func (s *Server) companionTargetRole(ctx context.Context, key string) string {
	deckID, ok := deckIDFromKey(key)
	if !ok {
		return key
	}
	if session, ok := s.deckSession(ctx, deckID); ok {
		return session.RoleID
	}
	return ""
}

// companionTargetUsername: who a Companion target controls right now.
func (s *Server) companionTargetUsername(ctx context.Context, key string) string {
	if deckID, ok := deckIDFromKey(key); ok {
		if session, ok := s.deckSession(ctx, deckID); ok {
			return strings.TrimSpace(session.Username)
		}
		return ""
	}
	if session, ok := s.sessions.LatestForRole(key); ok {
		return strings.TrimSpace(session.Username)
	}
	return ""
}

// companionLayout: the Stream Deck layout of a target. ErrNotFound means
// "use the defaults", like GetRoleStreamDeckSettings.
func (s *Server) companionLayout(ctx context.Context, key string) (StreamDeckSettings, error) {
	deckID, ok := deckIDFromKey(key)
	if !ok {
		return s.store.GetRoleStreamDeckSettings(ctx, key)
	}
	settings, err := s.store.GetStreamDeckLayout(ctx, deckID)
	if err == nil || !errors.Is(err, ErrNotFound) {
		return settings, err
	}
	roleID := s.companionTargetRole(ctx, key)
	if roleID == "" {
		return StreamDeckSettings{}, ErrNotFound
	}
	return s.store.GetRoleStreamDeckSettings(ctx, roleID)
}

func (s *Server) companionLayoutOrDefault(ctx context.Context, key string) (StreamDeckSettings, error) {
	settings, err := s.companionLayout(ctx, key)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalidInput) {
		return DefaultStreamDeckSettings(), nil
	}
	return settings, err
}

// companionTokenForKey: the session a deck's commands go to. A deck controls
// its place even if the same person is logged in somewhere else too.
func (s *Server) companionTokenForKey(ctx context.Context, key, username string) (string, bool) {
	if deckID, ok := deckIDFromKey(key); ok {
		session, ok := s.deckSession(ctx, deckID)
		if !ok {
			return "", false
		}
		return session.Token, true
	}
	return s.hub.LatestTokenForUsername(strings.TrimSpace(username))
}

func (s *Server) queueCompanionBrowserCommandForKey(ctx context.Context, key, username string, command CompanionCommand) (CompanionCommandResult, error) {
	if _, ok := deckIDFromKey(key); !ok {
		return s.queueCompanionBrowserCommand(username, command)
	}
	token, ok := s.companionTokenForKey(ctx, key, username)
	if !ok {
		return CompanionCommandResult{}, errors.New("target unavailable")
	}
	if !s.hub.SendToToken(token, WSOutbound{Type: "companion_command", Data: command}) {
		return CompanionCommandResult{}, errors.New("failed to deliver command")
	}
	return CompanionCommandResult{
		CommandID: command.CommandID,
		Command:   command.Command,
		OK:        true,
		Status:    "queued",
		Source:    "server",
		Timestamp: time.Now().UnixMilli(),
	}, nil
}

// deckUnbound: the deck has no place yet (it shows its pairing code).
func (s *Server) deckUnbound(ctx context.Context, key string) (StreamDeck, bool) {
	deckID, ok := deckIDFromKey(key)
	if !ok {
		return StreamDeck{}, false
	}
	deck, err := s.store.GetStreamDeck(ctx, deckID)
	if err != nil {
		return StreamDeck{}, false
	}
	return deck, deck.PlaceID == ""
}

// emitDeckPairingImages shows "Code 1234" and the deck's name on an unbound
// deck, so the person at that place can claim it.
func (s *Server) emitDeckPairingImages(ctx context.Context, key string, deck StreamDeck) {
	if s.imageStreamCoord == nil {
		return
	}
	settings, _ := s.companionLayoutOrDefault(ctx, key)
	page := s.currentCompanionPage(ctx, key)
	count := companionGridButtonCount(settings)
	code := s.deckState.pairingCode(deck.ID)
	for index := 0; index < count; index++ {
		state := ButtonState{State: "IDLE", ActionType: string(StreamDeckActionTypeNone)}
		switch index {
		case 0:
			// The code is what people type in: large, with a small caption.
			state.Label, state.Subtitle = code, "Pairing code"
		case 1:
			state.Label, state.Subtitle = deck.Name, "not paired"
		default:
			state.Label = " "
		}
		s.imageStreamCoord.BroadcastImageUpdateForTarget(key, "", state, page, index)
	}
}

// refreshDeck pushes new state and images to a deck after its binding or
// layout changed.
func (s *Server) refreshDeck(deckID string) {
	key := deckKey(deckID)
	s.resetCompanionCurrentPage(key)
	if s.imageStreamCoord != nil {
		s.imageStreamCoord.ResetTargetCache(key, "")
	}
	s.emitCompanionCurrentPageImages(context.Background(), key, "")
}

// refreshDecksAtPlace: someone logged in or out at a place, so its decks
// show another person's state (and maybe another role's layout).
func (s *Server) refreshDecksAtPlace(placeID string) {
	if placeID == "" || s.store == nil {
		return
	}
	decks, err := s.store.StreamDecksForPlace(context.Background(), placeID)
	if err != nil {
		return
	}
	for _, deck := range decks {
		s.publishCompanionState(deckKey(deck.ID))
		s.refreshDeck(deck.ID)
	}
}

// deckProfile: what /api/companion/profile and discovery return for a deck.
func (s *Server) deckProfile(ctx context.Context, deckID string) (CompanionProfileResponse, error) {
	key := deckKey(deckID)
	target := User{}
	if session, ok := s.deckSession(ctx, deckID); ok {
		target = User{ID: session.UserID, Username: session.Username, RoleID: session.RoleID}
	}
	profile, err := s.buildCompanionProfileResponse(ctx, target)
	if err != nil {
		return CompanionProfileResponse{}, err
	}
	settings, err := s.companionLayoutOrDefault(ctx, key)
	if err != nil {
		return CompanionProfileResponse{}, err
	}
	profile.StreamDeck = s.companionResolvedSettings(ctx, target.RoleID, settings)
	profile.CurrentPageNumber = s.currentCompanionPage(ctx, key)
	profile.ProfileVersion = s.deckLayoutVersion(ctx, deckID)
	profile.ProfileStatus = "published"
	profile.ProfileUpdatedAt = time.Now().UnixMilli()
	return profile, nil
}

// deckLayoutVersion: the profile version a deck connection reports; cheap
// enough for every presence change.
func (s *Server) deckLayoutVersion(ctx context.Context, deckID string) int {
	key := deckKey(deckID)
	settings, _ := s.companionLayoutOrDefault(ctx, key)
	encoded, _ := json.Marshal(settings)
	h := fnv.New64a()
	_, _ = h.Write(encoded)
	_, _ = h.Write([]byte(s.companionTargetRole(ctx, key)))
	return s.deckState.profileVersion(deckID, h.Sum64())
}

// ── HTTP ──

// deckProfileForRequest answers discovery/profile calls with ?deck=. handled
// is false for role connections; profile is nil when an error was written.
func (s *Server) deckProfileForRequest(w http.ResponseWriter, r *http.Request) (*CompanionProfileResponse, bool) {
	deckParam := strings.TrimSpace(r.URL.Query().Get("deck"))
	if deckParam == "" {
		return nil, false
	}
	deck, err := s.store.TouchStreamDeck(r.Context(), deckParam, remoteIP(r))
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidInput):
			http.Error(w, "invalid deck name", http.StatusBadRequest)
		case errors.Is(err, errTooManyStreamDecks):
			http.Error(w, "too many stream decks", http.StatusTooManyRequests)
		default:
			s.internalErr(w, err)
		}
		return nil, true
	}
	profile, err := s.deckProfile(r.Context(), deck.ID)
	if err != nil {
		s.internalErr(w, err)
		return nil, true
	}
	return &profile, true
}

type streamDeckAdminResponse struct {
	Decks  []StreamDeck `json:"decks"`
	Places []Place      `json:"places"`
}

type updateStreamDeckRequest struct {
	Name       string `json:"name"`
	PlaceID    string `json:"placeId"`
	PlaceLabel string `json:"placeLabel"`
}

func (s *Server) withDeckRuntime(ctx context.Context, decks []StreamDeck) []StreamDeck {
	for i := range decks {
		decks[i].Connected = s.deckState.isConnected(decks[i].ID)
		if decks[i].PlaceID == "" {
			decks[i].PairingCode = s.deckState.pairingCode(decks[i].ID)
			continue
		}
		if session, ok := s.hub.LatestSessionForPlace(decks[i].PlaceID); ok {
			decks[i].Username = session.Username
			decks[i].RoleID = session.RoleID
		}
	}
	return decks
}

// GET /api/admin/stream-decks
func (s *Server) handleAdminStreamDecks(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	decks, err := s.store.ListStreamDecks(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, streamDeckAdminResponse{
		Decks:  s.withDeckRuntime(r.Context(), decks),
		Places: s.hub.OnlinePlaces(),
	})
}

// PUT / DELETE /api/admin/stream-decks/{id}, DELETE .../{id}/layout
func (s *Server) handleAdminStreamDeckByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/admin/stream-decks/")
	rawID, resetLayout := strings.CutSuffix(rest, "/layout")
	id, _, ok := normalizeStreamDeckID(rawID)
	if !ok || id != rawID {
		http.Error(w, "invalid stream deck id", http.StatusBadRequest)
		return
	}
	var err error
	switch {
	case resetLayout && r.Method == http.MethodDelete:
		_, err = s.store.SetStreamDeckLayout(r.Context(), id, nil)
	case !resetLayout && r.Method == http.MethodPut:
		var req updateStreamDeckRequest
		if decodeErr := json.NewDecoder(r.Body).Decode(&req); decodeErr != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		err = s.store.UpdateStreamDeck(r.Context(), id, req.Name, req.PlaceID, req.PlaceLabel)
		if err == nil && strings.TrimSpace(req.PlaceID) != "" {
			s.deckState.dropCode(id)
		}
	case !resetLayout && r.Method == http.MethodDelete:
		err = s.store.DeleteStreamDeck(r.Context(), id)
		s.deckState.dropCode(id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		if s.writeStoreErr(w, err) {
			return
		}
		s.internalErr(w, err)
		return
	}
	s.publishCompanionState(deckKey(id))
	s.refreshDeck(id)
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type pairStreamDeckRequest struct {
	Code string `json:"code"`
}

// GET /api/user/stream-decks: decks bound to the caller's place.
// POST /api/user/stream-decks/pair {code}: bind an unbound deck to it.
// DELETE /api/user/stream-decks/{id}: release a deck of the caller's place.
func (s *Server) handleUserStreamDecks(w http.ResponseWriter, r *http.Request, session Session) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/user/stream-decks"), "/")
	switch {
	case rest == "" && r.Method == http.MethodGet:
		decks, err := s.store.StreamDecksForPlace(r.Context(), session.PlaceID)
		if err != nil {
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, s.withDeckRuntime(r.Context(), decks))
	case rest == "pair" && r.Method == http.MethodPost:
		if session.PlaceID == "" {
			http.Error(w, "this client has no place id; update the app", http.StatusBadRequest)
			return
		}
		var req pairStreamDeckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		id, ok := s.deckState.deckForCode(req.Code)
		if !ok {
			http.Error(w, "unknown code", http.StatusNotFound)
			return
		}
		deck, err := s.store.GetStreamDeck(r.Context(), id)
		if err != nil || deck.PlaceID != "" {
			http.Error(w, "unknown code", http.StatusNotFound)
			return
		}
		if err := s.store.UpdateStreamDeck(r.Context(), id, deck.Name, session.PlaceID, session.Username); err != nil {
			s.internalErr(w, err)
			return
		}
		s.deckState.dropCode(id)
		s.publishCompanionState(deckKey(id))
		s.refreshDeck(id)
		deck, _ = s.store.GetStreamDeck(r.Context(), id)
		s.writeJSON(w, http.StatusOK, deck)
	case rest != "" && rest != "pair" && r.Method == http.MethodDelete:
		deck, err := s.store.GetStreamDeck(r.Context(), rest)
		if err != nil || deck.PlaceID == "" || deck.PlaceID != session.PlaceID {
			http.Error(w, "not a stream deck of this place", http.StatusNotFound)
			return
		}
		if err := s.store.UpdateStreamDeck(r.Context(), deck.ID, deck.Name, "", ""); err != nil {
			s.internalErr(w, err)
			return
		}
		s.publishCompanionState(deckKey(deck.ID))
		s.refreshDeck(deck.ID)
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// userPlaceDeck: the deck whose layout the Stream Deck editor at this place
// edits (?deckId= picks one when a place has several).
func (s *Server) userPlaceDeck(r *http.Request, session Session) (StreamDeck, bool) {
	if session.PlaceID == "" {
		return StreamDeck{}, false
	}
	decks, err := s.store.StreamDecksForPlace(r.Context(), session.PlaceID)
	if err != nil || len(decks) == 0 {
		return StreamDeck{}, false
	}
	if wanted := strings.TrimSpace(r.URL.Query().Get("deckId")); wanted != "" {
		for _, deck := range decks {
			if deck.ID == wanted {
				return deck, true
			}
		}
	}
	sort.Slice(decks, func(i, j int) bool { return decks[i].Name < decks[j].Name })
	return decks[0], true
}

// handleDeckLayoutForUser: the Stream Deck editor at a place with a deck
// edits that deck's layout. Until one is saved it starts from the role's.
func (s *Server) handleDeckLayoutForUser(w http.ResponseWriter, r *http.Request, session Session, deck StreamDeck) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.companionLayoutOrDefault(r.Context(), deckKey(deck.ID))
		if err != nil {
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, settings)
		return
	case http.MethodPut:
		var req StreamDeckSettings
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		saved, err := s.store.SetStreamDeckLayout(r.Context(), deck.ID, &req)
		if err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.publishCompanionState(deckKey(deck.ID))
		s.refreshDeck(deck.ID)
		s.writeJSON(w, http.StatusOK, saved)
	case http.MethodDelete:
		if _, err := s.store.SetStreamDeckLayout(r.Context(), deck.ID, nil); err != nil {
			s.internalErr(w, err)
			return
		}
		s.publishCompanionState(deckKey(deck.ID))
		s.refreshDeck(deck.ID)
		settings, err := s.companionLayoutOrDefault(r.Context(), deckKey(deck.ID))
		if err != nil {
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, settings)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
