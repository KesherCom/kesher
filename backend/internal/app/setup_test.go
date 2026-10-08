package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func setupCall(s *Server, method, path, body string, handler http.HandlerFunc) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(method, path, bytes.NewBufferString(body)))
	return rec
}

func TestFirstRunSetup(t *testing.T) {
	s := newDeviceTestServer(t)
	s.cfg.FirstRunSetup = true
	ctx := context.Background()

	// Fresh server: the page shows the setup, admin login is closed.
	rec := setupCall(s, http.MethodGet, "/api/public-bootstrap", "", s.handlePublicBootstrap)
	var pub PublicBootstrapResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	if !pub.SetupRequired {
		t.Fatalf("expected setupRequired, got %s", rec.Body.String())
	}
	if rec := setupCall(s, http.MethodPost, "/api/admin/login", `{"pin":"123456"}`, s.handleAdminLogin); rec.Code != http.StatusForbidden {
		t.Fatalf("default PIN must not work before setup, got %d", rec.Code)
	}

	// Invalid input is rejected.
	for _, body := range []string{`{"pin":"12","start":"example"}`, `{"pin":"12 34 56","start":"example"}`, `{"pin":"4711x","start":"other"}`} {
		if rec := setupCall(s, http.MethodPost, "/api/setup", body, s.handleSetup); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", body, rec.Code)
		}
	}

	// Setup with an empty start removes the example configuration.
	if rec := setupCall(s, http.MethodPost, "/api/setup", `{"pin":"4711x","start":"empty"}`, s.handleSetup); rec.Code != http.StatusOK {
		t.Fatalf("setup: %d %s", rec.Code, rec.Body.String())
	}
	if roles, _ := s.store.ListRoles(ctx); len(roles) != 0 {
		t.Fatalf("expected no roles after empty start, got %d", len(roles))
	}
	if s.setupRequired(ctx) {
		t.Fatal("setup should be done")
	}
	// Only once.
	if rec := setupCall(s, http.MethodPost, "/api/setup", `{"pin":"other1","start":"example"}`, s.handleSetup); rec.Code != http.StatusConflict {
		t.Fatalf("second setup: expected 409, got %d", rec.Code)
	}
	// The chosen PIN works, the default does not.
	if rec := setupCall(s, http.MethodPost, "/api/admin/login", `{"pin":"4711x"}`, s.handleAdminLogin); rec.Code != http.StatusOK {
		t.Fatalf("admin login with new PIN: %d %s", rec.Code, rec.Body.String())
	}
	if rec := setupCall(s, http.MethodPost, "/api/admin/login", `{"pin":"123456"}`, s.handleAdminLogin); rec.Code != http.StatusForbidden {
		t.Fatalf("default PIN after setup: expected 403, got %d", rec.Code)
	}
}

func TestFirstRunSetupKeepsExampleAndIsOffByDefault(t *testing.T) {
	s := newDeviceTestServer(t)
	if s.setupRequired(context.Background()) {
		t.Fatal("setup must be off unless FIRST_RUN_SETUP is set")
	}
	s.cfg.FirstRunSetup = true
	s.cfg.AdminPINFromEnv = true
	if s.setupRequired(context.Background()) {
		t.Fatal("an ADMIN_PIN from the environment counts as set up")
	}
	s.cfg.AdminPINFromEnv = false
	if rec := setupCall(s, http.MethodPost, "/api/setup", `{"pin":"4711","start":"example"}`, s.handleSetup); rec.Code != http.StatusOK {
		t.Fatalf("setup: %d", rec.Code)
	}
	if roles, _ := s.store.ListRoles(context.Background()); len(roles) == 0 {
		t.Fatal("example start keeps the seeded roles")
	}
}
