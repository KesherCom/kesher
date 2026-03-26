package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExportConfigurationDocumentIncludesMetadataHeader(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store}
	doc, err := s.exportConfigurationDocument(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if doc.Meta.Format != configurationDocumentFormat {
		t.Fatalf("unexpected document format: %q", doc.Meta.Format)
	}
	if doc.Meta.SchemaVersion != configurationDocumentSchemaVersion {
		t.Fatalf("unexpected schema version: %d", doc.Meta.SchemaVersion)
	}
	if len(doc.Meta.Sections) != len(allConfigurationSections) {
		t.Fatalf("expected all sections in metadata, got %v", doc.Meta.Sections)
	}
	if doc.AckSettings == nil {
		t.Fatal("expected ack settings to be exported")
	}
}

func TestExportConfigurationDocumentIncludesStreamDeckSettings(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	user, err := store.UpsertUser(context.Background(), "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}
	if _, err := store.UpsertUserStreamDeckSettings(context.Background(), user.ID, settings); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store}
	doc, err := s.exportConfigurationDocument(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.StreamDeck) != 1 {
		t.Fatalf("expected 1 stream deck assignment, got %d", len(doc.StreamDeck))
	}
	if doc.StreamDeck[0].Username != "alice" {
		t.Fatalf("unexpected stream deck username: %q", doc.StreamDeck[0].Username)
	}
	if doc.StreamDeck[0].Settings.Pages[0].Buttons[0].Action == nil || doc.StreamDeck[0].Settings.Pages[0].Buttons[0].Action.Type != StreamDeckActionTypeReplyToCaller {
		t.Fatalf("unexpected stream deck action: %+v", doc.StreamDeck[0].Settings.Pages[0].Buttons[0].Action)
	}
}

func TestImportConfigurationReplacesSelectedSectionsAndPreservesOthers(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.CreateRole(context.Background(), "qa", "QA", "foh", "ptt", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertUser(context.Background(), "alice", "audio"); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	state, sections, revoked, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionRoles, configurationSectionAckSettings},
			},
			Roles: []Role{
				{ID: "audio", Name: "A1", DefaultRoomID: "foh", DefaultVoiceMode: "ptt"},
				{ID: "video", Name: "Video", DefaultRoomID: "stage", DefaultVoiceMode: "always_on"},
				{ID: "broadcast", Name: "Broadcast", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
				{ID: "camera", Name: "Camera", DefaultRoomID: "stage", DefaultVoiceMode: "ptt", DefaultSimpleView: true},
				{ID: "pastor", Name: "Pastor", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
				{ID: "producer", Name: "Producer", DefaultRoomID: "foh", DefaultVoiceMode: "ptt"},
				{ID: "lighting", Name: "Lighting", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
				{ID: "qa", Name: "Quality", DefaultRoomID: "foh", DefaultVoiceMode: "ptt"},
			},
			AckSettings: &AckSettings{Enabled: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 0 {
		t.Fatalf("expected no revoked users, got %v", revoked)
	}
	if !slicesEqual(sections, []string{configurationSectionRoles, configurationSectionAckSettings}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
	if len(state.Rooms) == 0 || len(state.BroadcastGroups) == 0 {
		t.Fatal("expected non-selected sections to be preserved")
	}
	if state.AckEnabled {
		t.Fatal("expected imported ack setting to be false")
	}
	roles, err := store.ListRoles(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, role := range roles {
		if role.ID == "qa" && role.Name == "Quality" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected imported role to be stored")
	}
	users, err := store.ListUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("expected existing users to stay untouched, got %+v", users)
	}
	if s.isAckEnabled() {
		t.Fatal("expected server ack flag to be updated")
	}
}

func TestImportConfigurationRevokesChangedUserSessions(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	user, err := store.UpsertUser(context.Background(), "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s := &Server{store: store, sessions: NewSessionManager(time.Minute), hub: hub}
	session := s.sessions.Create(user)
	hub.Add(&client{
		session:      session,
		user:         user,
		connectedAt:  time.Now(),
		send:         make(chan WSOutbound, 1),
		sendPriority: make(chan WSOutbound, 1),
		listenRooms:  map[string]struct{}{},
		talkRooms:    map[string]struct{}{},
	})

	state, _, revoked, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionUsers},
			},
			Users: []ConfigurationUserAssignment{{Username: "alice", RoleID: "video"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s.revokeSessionsForUsernames(revoked)
	if _, ok := s.sessions.Get(session.Token); ok {
		t.Fatal("expected changed user session to be revoked")
	}
	users, err := store.ListUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if users[0].RoleID != "video" {
		t.Fatalf("expected updated user role, got %+v", users[0])
	}
	if len(state.Users) == 0 || state.Users[0].RoleID != "video" {
		t.Fatalf("expected replaced state to reflect imported users, got %+v", state.Users)
	}
	if token, ok := hub.LatestTokenForUsername("alice"); ok && token == session.Token {
		t.Fatal("expected websocket client to be removed after revoke")
	}
}

func TestImportConfigurationUsersSectionRemovesMissingUsers(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.UpsertUser(context.Background(), "alice", "audio"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertUser(context.Background(), "bob", "video"); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store, sessions: NewSessionManager(time.Minute), ackEnabled: true, ackSet: true}
	_, _, revoked, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionUsers},
			},
			Users: []ConfigurationUserAssignment{{Username: "alice", RoleID: "audio"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	users, err := store.ListUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("expected missing imported users to be removed, got %+v", users)
	}
	if len(revoked) != 1 || revoked[0] != "bob" {
		t.Fatalf("expected removed user to be revoked, got %v", revoked)
	}
}

func TestImportConfigurationReplacesTelegramAllowlist(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.UpsertUser(context.Background(), "tim", "audio"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateTelegramAllowlistEntry(context.Background(), "old-id", "old_telegram", "tim"); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	state, sections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionTelegramAllowlist},
			},
			TelegramAllowlist: []TelegramAllowlistEntry{
				{ID: "new-id", TelegramUsername: "tim_telegram", KesherUsername: "tim"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slicesEqual(sections, []string{configurationSectionTelegramAllowlist}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
	if len(state.TelegramAllowlist) != 1 || state.TelegramAllowlist[0].TelegramUsername != "tim_telegram" {
		t.Fatalf("unexpected imported allowlist state: %+v", state.TelegramAllowlist)
	}
	entries, err := store.ListTelegramAllowlistEntries(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 allowlist entry after replace, got %d", len(entries))
	}
	if entries[0].TelegramUsername != "tim_telegram" || entries[0].KesherUsername != "tim" {
		t.Fatalf("unexpected allowlist entry after import: %+v", entries[0])
	}
}

func TestImportConfigurationAcceptsOmittedEmptyTelegramAllowlistField(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	_, sections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionTelegramAllowlist},
			},
			// telegramAllowlist intentionally omitted (nil) to mirror JSON omitempty round-trips.
		},
	})
	if err != nil {
		t.Fatalf("expected omitted empty telegramAllowlist field to be accepted, got %v", err)
	}
	if !slicesEqual(sections, []string{configurationSectionTelegramAllowlist}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
}

func TestImportConfigurationReplacesStreamDeckSettings(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	user, err := store.UpsertUser(context.Background(), "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	initial := DefaultStreamDeckSettings()
	initial.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}
	if _, err := store.UpsertUserStreamDeckSettings(context.Background(), user.ID, initial); err != nil {
		t.Fatal(err)
	}

	updated := DefaultStreamDeckSettings()
	updated.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	_, sections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionStreamDeck},
			},
			StreamDeck: []ConfigurationUserStreamDeckSettings{
				{Username: "alice", Settings: updated},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slicesEqual(sections, []string{configurationSectionStreamDeck}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
	loaded, err := store.GetUserStreamDeckSettings(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Pages[0].Buttons[0].Action == nil || loaded.Pages[0].Buttons[0].Action.Type != StreamDeckActionTypePageUp {
		t.Fatalf("expected imported stream deck action, got %+v", loaded.Pages[0].Buttons[0].Action)
	}
}

func TestHandleAdminConfigurationExportReturnsJSONDocument(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	adminSession := s.sessions.Create(User{Username: "admin"})
	req := httptest.NewRequest(http.MethodGet, "/api/admin/configuration-export", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminConfigurationExport(rec, req, adminSession)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var doc ConfigurationDocument
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if doc.Meta.Format != configurationDocumentFormat {
		t.Fatalf("unexpected format: %q", doc.Meta.Format)
	}
	if rec.Header().Get("Content-Disposition") == "" {
		t.Fatal("expected attachment header to be set")
	}
}

func TestHandleAdminConfigurationImportRejectsInvalidMetadata(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	adminSession := s.sessions.Create(User{Username: "admin"})
	body := bytes.NewBufferString(`{"document":{"meta":{"format":"bad","schemaVersion":1,"exportedAt":"2026-03-14T10:00:00Z","sections":["roles"]},"roles":[]}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/configuration-import", body)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminConfigurationImport(rec, req, adminSession)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func slicesEqual(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
