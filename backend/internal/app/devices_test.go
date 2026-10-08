package app

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newDeviceTestServer(t *testing.T) *Server {
	t.Helper()
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Server{store: store, sessions: NewSessionManager(time.Hour), hub: NewHub(store, logger), logger: logger}
}

const (
	testDeviceID     = "3f6c2a9e-1b7d-4c55-9f1e-0a2b3c4d5e6f"
	testDeviceSecret = "0123456789abcdef0123456789abcdef0123456789abcdef"
)

func deviceCall(t *testing.T, handler http.HandlerFunc, secret string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"deviceId": testDeviceID, "secret": secret, "hostname": "Stage Left Pi", "model": "Raspberry Pi 5", "version": "0.9.0",
	})
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/api/devices/x", bytes.NewReader(body)))
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func adminDeviceCall(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	admin := s.sessions.Create(User{Username: "admin"})
	if path == "/api/admin/devices" {
		s.handleAdminDevices(rec, req, admin)
	} else {
		s.handleAdminDeviceByID(rec, req, admin)
	}
	return rec
}

func TestDevicePairingApprovalAndLogin(t *testing.T) {
	s := newDeviceTestServer(t)

	// First contact: stored as pending, named after the hostname.
	rec, out := deviceCall(t, s.handleDeviceHello, testDeviceSecret)
	if rec.Code != http.StatusOK || out["status"] != DeviceStatusPending || out["name"] != "Stage-Left-Pi" {
		t.Fatalf("hello: %d %v", rec.Code, out)
	}
	// Not approved yet: no session.
	if rec, _ := deviceCall(t, s.handleDeviceLogin, testDeviceSecret); rec.Code != http.StatusForbidden {
		t.Fatalf("login before approval: %d", rec.Code)
	}
	// Someone else claiming the same device ID is refused.
	if rec, _ := deviceCall(t, s.handleDeviceHello, "ffffffffffffffffffffffffffffffffffff"); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong secret: %d", rec.Code)
	}

	// Admin sees it and approves it as "stage-left" with role audio.
	rec = adminDeviceCall(t, s, http.MethodGet, "/api/admin/devices", "")
	var list []Device
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].Status != DeviceStatusPending || list[0].Model != "Raspberry Pi 5" {
		t.Fatalf("admin list: %s", rec.Body.String())
	}
	if rec := adminDeviceCall(t, s, http.MethodPut, "/api/admin/devices/"+testDeviceID,
		`{"name":"stage-left","roleId":"audio","mode":"always_on","status":"approved"}`); rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}

	rec, out = deviceCall(t, s.handleDeviceLogin, testDeviceSecret)
	if rec.Code != http.StatusOK || out["token"] == "" {
		t.Fatalf("login: %d %v", rec.Code, out)
	}
	device, _ := out["device"].(map[string]any)
	if device["roleId"] != "audio" || device["mode"] != "always_on" || device["name"] != "stage-left" {
		t.Fatalf("device config: %v", out["device"])
	}
	first, _ := out["token"].(string)

	// Logging in again (restart) replaces its own session instead of conflicting.
	rec, out = deviceCall(t, s.handleDeviceLogin, testDeviceSecret)
	if rec.Code != http.StatusOK {
		t.Fatalf("second login: %d %v", rec.Code, out)
	}
	if _, ok := s.sessions.Get(first); ok {
		t.Fatal("old device session should be replaced")
	}

	// Changing its settings ends the session, so the node logs in again.
	second, _ := out["token"].(string)
	if rec := adminDeviceCall(t, s, http.MethodPut, "/api/admin/devices/"+testDeviceID,
		`{"name":"stage-left","roleId":"video","mode":"ptt","status":"approved"}`); rec.Code != http.StatusOK {
		t.Fatalf("update: %d", rec.Code)
	}
	if _, ok := s.sessions.Get(second); ok {
		t.Fatal("session should be revoked after a settings change")
	}
}

func TestDeviceLoginConflictsWithOtherUserOfRole(t *testing.T) {
	s := newDeviceTestServer(t)
	deviceCall(t, s.handleDeviceHello, testDeviceSecret)
	adminDeviceCall(t, s, http.MethodPut, "/api/admin/devices/"+testDeviceID,
		`{"name":"stage-left","roleId":"audio","mode":"ptt","status":"approved"}`)
	s.sessions.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})
	if rec, _ := deviceCall(t, s.handleDeviceLogin, testDeviceSecret); rec.Code != http.StatusConflict {
		t.Fatalf("expected conflict with another user of the role, got %d", rec.Code)
	}
}

func TestDeviceApprovalValidation(t *testing.T) {
	s := newDeviceTestServer(t)
	deviceCall(t, s.handleDeviceHello, testDeviceSecret)
	for _, body := range []string{
		`{"name":"x","roleId":"no-such-role","mode":"ptt","status":"approved"}`,
		`{"name":"has space","roleId":"audio","mode":"ptt","status":"approved"}`,
		`{"name":"x","roleId":"audio","mode":"loud","status":"approved"}`,
	} {
		if rec := adminDeviceCall(t, s, http.MethodPut, "/api/admin/devices/"+testDeviceID, body); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", body, rec.Code)
		}
	}
	if rec := adminDeviceCall(t, s, http.MethodDelete, "/api/admin/devices/"+testDeviceID, ""); rec.Code != http.StatusOK {
		t.Fatalf("delete: %d", rec.Code)
	}
	// After deletion the same device can pair again (new secret allowed).
	if rec, out := deviceCall(t, s.handleDeviceHello, "a-new-secret-after-reset-0123456789abcdef"); rec.Code != http.StatusOK || out["status"] != DeviceStatusPending {
		t.Fatalf("re-pair: %d %v", rec.Code, out)
	}
}
