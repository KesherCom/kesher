package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestTelegramMappingCRUD(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	s := &Server{
		store:    store,
		cfg:      Config{AdminPIN: "123456"},
		sessions: NewSessionManager(time.Minute),
	}
	s.hub = NewHub(store, logger)

	body := bytes.NewBufferString(`{"username":"admin","roleId":"audio"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/login", body)
	rec := httptest.NewRecorder()
	s.handleLogin(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", rec.Code, rec.Body.String())
	}
	var loginResp LoginResponse
	_ = json.NewDecoder(rec.Body).Decode(&loginResp)
	session, _ := s.sessions.Get(loginResp.Token)

	req = httptest.NewRequest(http.MethodGet, "/api/admin/telegram", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegram(rec, req, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var status TelegramStatusResponse
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if len(status.Mappings) != 0 {
		t.Fatalf("expected empty mappings, got %d", len(status.Mappings))
	}

	payload := `{"chatId":"-100123","label":"Sound","roomId":"foh"}`
	req = httptest.NewRequest(http.MethodPost, "/api/admin/telegram", bytes.NewBufferString(payload))
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegram(rec, req, session)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var created map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&created)
	mappingID := created["id"]
	if mappingID == "" {
		t.Fatal("expected non-empty id in response")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/telegram", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegram(rec, req, session)
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if len(status.Mappings) != 1 {
		t.Fatalf("expected 1 mapping, got %d", len(status.Mappings))
	}
	if status.Mappings[0].ChatID != "-100123" {
		t.Fatalf("expected chatId -100123, got %s", status.Mappings[0].ChatID)
	}

	updatePayload := `{"chatId":"-100999","label":"Video","roomId":"stage"}`
	req = httptest.NewRequest(http.MethodPut, "/api/admin/telegram/"+mappingID, bytes.NewBufferString(updatePayload))
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegramByID(rec, req, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/admin/telegram/"+mappingID, nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegramByID(rec, req, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/admin/telegram", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegram(rec, req, session)
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if len(status.Mappings) != 0 {
		t.Fatalf("expected 0 mappings after delete, got %d", len(status.Mappings))
	}
}

func TestTelegramWebhookNotConfigured(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	req := httptest.NewRequest(http.MethodPost, "/api/telegram/webhook", bytes.NewBufferString("{}"))
	rec := httptest.NewRecorder()
	s.handleTelegramWebhook(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

func TestTelegramAdminByIDInvalidID(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	s := &Server{
		store:    store,
		cfg:      Config{AdminPIN: "123456"},
		sessions: NewSessionManager(time.Minute),
	}
	s.hub = NewHub(store, logger)

	body := bytes.NewBufferString(`{"username":"admin","roleId":"audio"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/login", body)
	rec := httptest.NewRecorder()
	s.handleLogin(rec, req)
	var loginResp LoginResponse
	_ = json.NewDecoder(rec.Body).Decode(&loginResp)
	session, _ := s.sessions.Get(loginResp.Token)

	req = httptest.NewRequest(http.MethodDelete, "/api/admin/telegram/", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec = httptest.NewRecorder()
	s.handleAdminTelegramByID(rec, req, session)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty id, got %d", rec.Code)
	}
}
