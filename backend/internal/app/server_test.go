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

func TestFilterBroadcastGroupsForRole(t *testing.T) {
	groups := []BroadcastGroup{
		{ID: "all", Name: "All", AllowedRoleIDs: nil},
		{ID: "audio-only", Name: "Audio", AllowedRoleIDs: []string{"audio"}},
		{ID: "video-only", Name: "Video", AllowedRoleIDs: []string{"video"}},
	}
	filtered := filterBroadcastGroupsForRole("audio", groups)
	if len(filtered) != 1 {
		t.Fatalf("expected 1 group for audio role, got %d", len(filtered))
	}
	if filtered[0].ID != "audio-only" {
		t.Fatalf("expected audio-only group, got %s", filtered[0].ID)
	}
}

func TestEmbeddedStaticHandlerRootDoesNotRedirect(t *testing.T) {
	if !embeddedStaticAvailable() {
		t.Skip("embedded static assets not available")
	}
	s := &Server{cfg: Config{StaticDir: ""}}
	h := s.embeddedStaticHandler()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for embedded root, got %d", rec.Code)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("expected no redirect location header, got %q", location)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("expected embedded root response body to be non-empty")
	}
}

func TestServerHandleAdminPinUpdateSuccess(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	session := s.sessions.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})

	req := httptest.NewRequest(http.MethodPut, "/api/admin/pin", bytes.NewBufferString(`{"newPin":"654321"}`))
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminPin(rec, req, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	pin, err := store.GetAdminPIN(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if pin != "654321" {
		t.Fatalf("expected updated pin, got %q", pin)
	}
}

func TestServerHandleAdminPinUpdateWrongCurrentPINForbidden(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	session := s.sessions.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})

	req := httptest.NewRequest(http.MethodPut, "/api/admin/pin", bytes.NewBufferString(`{"newPin":"654321"}`))
	req.Header.Set("X-Admin-Pin", "bad-pin")
	rec := httptest.NewRecorder()
	s.handleAdminPin(rec, req, session)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestServerHandleRealtimeStatsMissingPINForbidden(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{
		store:    store,
		sessions: NewSessionManager(time.Minute),
	}
	session := s.sessions.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})
	req := httptest.NewRequest(http.MethodGet, "/api/realtime-stats", nil)
	rec := httptest.NewRecorder()
	s.handleRealtimeStats(rec, req, session)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestServerHandleRealtimeStatsWrongPINForbidden(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{
		store:    store,
		sessions: NewSessionManager(time.Minute),
	}
	session := s.sessions.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})
	req := httptest.NewRequest(http.MethodGet, "/api/realtime-stats", nil)
	req.Header.Set("X-Admin-Pin", "bad-pin")
	rec := httptest.NewRecorder()
	s.handleRealtimeStats(rec, req, session)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestServerHandleRealtimeStatsSuccess(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	media := NewMediaManager(hub, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s := &Server{
		store:    store,
		hub:      hub,
		media:    media,
		sessions: NewSessionManager(time.Minute),
	}
	session := s.sessions.Create(User{ID: "u1", Username: "tim", RoleID: "audio"})
	req := httptest.NewRequest(http.MethodGet, "/api/realtime-stats", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleRealtimeStats(rec, req, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp RealtimeStatsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.TimestampUnixMs <= 0 {
		t.Fatalf("expected timestamp to be set, got %d", resp.TimestampUnixMs)
	}
}

func TestServerHandleAdminRolesMissingPINForbidden(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, cfg: Config{AdminPIN: "123456"}}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/roles", bytes.NewBufferString(`{"id":"qa","name":"QA"}`))
	rec := httptest.NewRecorder()
	s.handleAdminRoles(rec, req, Session{RoleID: "audio"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestServerHandleLoginMethodNotAllowed(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	req := httptest.NewRequest(http.MethodGet, "/api/login", nil)
	rec := httptest.NewRecorder()
	s.handleLogin(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestServerHandleLoginInvalidJSON(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewBufferString("{"))
	rec := httptest.NewRecorder()
	s.handleLogin(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestServerHandleLoginInvalidRole(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	body := bytes.NewBufferString("{\"username\":\"tim\",\"roleId\":\"unknown\"}")
	req := httptest.NewRequest(http.MethodPost, "/api/login", body)
	rec := httptest.NewRecorder()
	s.handleLogin(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestServerHandleLoginSuccess(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	body := bytes.NewBufferString("{\"username\":\"tim\",\"roleId\":\"audio\"}")
	req := httptest.NewRequest(http.MethodPost, "/api/login", body)
	rec := httptest.NewRecorder()
	s.handleLogin(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp LoginResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode login response: %v", err)
	}
	if resp.Token == "" || resp.User.Username != "tim" || resp.User.RoleID != "audio" {
		t.Fatalf("unexpected login response: %+v", resp)
	}
}

func TestServerHandlePublicBootstrapMethodNotAllowed(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, cfg: Config{AdminPIN: "123456"}}
	req := httptest.NewRequest(http.MethodPost, "/api/public-bootstrap", nil)
	rec := httptest.NewRecorder()
	s.handlePublicBootstrap(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestServerHandleAdminRolesMethodNotAllowed(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, cfg: Config{AdminPIN: "123456"}}
	req := httptest.NewRequest(http.MethodGet, "/api/admin/roles", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminRoles(rec, req, Session{RoleID: "audio"})
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestServerHandleAdminRolesInvalidJSON(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, cfg: Config{AdminPIN: "123456"}}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/roles", bytes.NewBufferString("{"))
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminRoles(rec, req, Session{RoleID: "audio"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestServerHandleAdminRolesCreateSuccess(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, cfg: Config{AdminPIN: "123456"}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	reqBody := bytes.NewBufferString("{\"id\":\"qa\",\"name\":\"QA\",\"defaultRoomId\":\"foh\",\"defaultVoiceMode\":\"ptt\",\"defaultSimpleView\":true}")
	req := httptest.NewRequest(http.MethodPost, "/api/admin/roles", reqBody)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminRoles(rec, req, Session{RoleID: "audio"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}
	roles, err := store.ListRoles(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, role := range roles {
		if role.ID == "qa" && role.DefaultRoomID == "foh" && role.DefaultVoiceMode == "ptt" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected newly created role to be persisted")
	}
}

func TestServerIsInboundAllowedRoomScope(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio"}, []string{"video"}, nil); err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	allowed := s.isInboundAllowed(context.Background(), Session{RoleID: "audio"}, RoutedEvent{Scope: "room", TargetID: "foh"})
	if !allowed {
		t.Fatal("expected room event to be allowed for audio sender role")
	}
	denied := s.isInboundAllowed(context.Background(), Session{RoleID: "lighting"}, RoutedEvent{Scope: "room", TargetID: "foh"})
	if denied {
		t.Fatal("expected room event to be denied for disallowed sender role")
	}
}

func TestServerIsInboundAllowedBroadcastScope(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio"}, []string{"video"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateBroadcastGroup(context.Background(), "audio-bg", "Audio BG", []string{"foh"}, []string{"audio"}); err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	allowed := s.isInboundAllowed(context.Background(), Session{RoleID: "audio"}, RoutedEvent{Scope: "broadcast", TargetID: "audio-bg"})
	if !allowed {
		t.Fatal("expected broadcast to be allowed when role is in group and room sender policy")
	}
	denied := s.isInboundAllowed(context.Background(), Session{RoleID: "video"}, RoutedEvent{Scope: "broadcast", TargetID: "audio-bg"})
	if denied {
		t.Fatal("expected broadcast to be denied when sender role is not allowed")
	}
}

func TestServerRouteInboundAllowedRoutesToHub(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio"}, []string{"video"}, nil); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	sender := &client{
		session:     Session{Token: "sender-token", RoleID: "audio"},
		user:        User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:        make(chan WSOutbound, 8),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	receiver := &client{
		session:     Session{Token: "receiver-token", RoleID: "video"},
		user:        User{ID: "u2", Username: "receiver", RoleID: "video"},
		send:        make(chan WSOutbound, 8),
		listenRooms: toRoomSet([]string{"foh"}),
	}
	hub.Add(sender)
	hub.Add(receiver)
	drain(sender.send)
	drain(receiver.send)
	s := &Server{store: store, hub: hub}
	s.routeInbound(context.Background(), sender.session, WSInbound{
		Data: RoutedEvent{Scope: "room", TargetID: "foh", Body: "hello"},
	}, "chat")
	select {
	case out := <-receiver.send:
		if out.Type != "chat" {
			t.Fatalf("expected chat event, got %s", out.Type)
		}
	default:
		t.Fatal("expected routed chat message for receiver")
	}
}

func TestServerRouteInboundRejectsInvalidPayload(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	sender := &client{
		session: Session{Token: "sender-token", RoleID: "audio"},
		user:    User{ID: "u1", Username: "sender", RoleID: "audio"},
		send:    make(chan WSOutbound, 8),
	}
	receiver := &client{
		session: Session{Token: "receiver-token", RoleID: "video"},
		user:    User{ID: "u2", Username: "receiver", RoleID: "video"},
		send:    make(chan WSOutbound, 8),
	}
	hub.Add(sender)
	hub.Add(receiver)
	drain(sender.send)
	drain(receiver.send)
	s := &Server{store: store, hub: hub}
	s.routeInbound(context.Background(), sender.session, WSInbound{Data: make(chan int)}, "chat")
	s.routeInbound(context.Background(), sender.session, WSInbound{Data: RoutedEvent{Scope: "", TargetID: "u2"}}, "chat")
	select {
	case out := <-receiver.send:
		t.Fatalf("did not expect message for invalid payload, got type %s", out.Type)
	default:
	}
}

func TestDefaultRoomForSessionPrefersRoleDefaultThenFirstRoom(t *testing.T) {
	session := Session{RoleID: "audio"}
	roles := []Role{
		{ID: "audio", DefaultRoomID: "foh"},
		{ID: "video", DefaultRoomID: "video-control"},
	}
	rooms := []Room{{ID: "stage"}, {ID: "foh"}}
	if got := defaultRoomForSession(session, roles, rooms); got != "foh" {
		t.Fatalf("expected role default room, got %q", got)
	}
	session = Session{RoleID: "unknown"}
	if got := defaultRoomForSession(session, roles, rooms); got != "stage" {
		t.Fatalf("expected first room fallback, got %q", got)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	got := firstNonEmpty([]string{"", "foh"}, []string{"stage"}, "fallback")
	if got != "foh" {
		t.Fatalf("unexpected first non-empty from primary: %q", got)
	}
	got = firstNonEmpty([]string{""}, []string{"", "stage"}, "fallback")
	if got != "stage" {
		t.Fatalf("unexpected first non-empty from secondary: %q", got)
	}
	got = firstNonEmpty(nil, nil, "fallback")
	if got != "fallback" {
		t.Fatalf("unexpected fallback value: %q", got)
	}
}

func TestServerFilterAllowedRoomsForRole(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpdateRoom(context.Background(), "foh", "FOH", []string{"audio"}, []string{"audio", "video"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateRoom(context.Background(), "stage", "Stage", []string{"video"}, []string{"video"}, nil); err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	if got := s.filterAllowedRoomsForRole(context.Background(), "audio", []string{"foh", "stage"}, true); len(got) != 1 || got[0] != "foh" {
		t.Fatalf("unexpected send room filter result: %v", got)
	}
	if got := s.filterAllowedRoomsForRole(context.Background(), "audio", []string{"foh", "stage"}, false); len(got) != 1 || got[0] != "foh" {
		t.Fatalf("unexpected listen room filter result: %v", got)
	}
}

func TestServerWithAuthMissingToken(t *testing.T) {
	s := &Server{sessions: NewSessionManager(time.Minute)}
	h := s.withAuth(func(http.ResponseWriter, *http.Request, Session) {
		t.Fatal("expected handler not to be called")
	})
	req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestServerWithAuthInvalidToken(t *testing.T) {
	s := &Server{sessions: NewSessionManager(time.Minute)}
	h := s.withAuth(func(http.ResponseWriter, *http.Request, Session) {
		t.Fatal("expected handler not to be called")
	})
	req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer invalid")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestServerWithAuthValidTokenCallsNext(t *testing.T) {
	s := &Server{sessions: NewSessionManager(time.Minute)}
	user := User{ID: "u1", Username: "tim", RoleID: "audio"}
	session := s.sessions.Create(user)
	called := false
	h := s.withAuth(func(_ http.ResponseWriter, _ *http.Request, got Session) {
		called = true
		if got.Token != session.Token {
			t.Fatalf("unexpected session passed to handler: %q", got.Token)
		}
	})
	req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer "+session.Token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatal("expected next handler to be called")
	}
}

func TestServerWithCORSOptionsRequest(t *testing.T) {
	s := &Server{cfg: Config{AllowCORS: true}}
	h := s.withCORS(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("expected options to short-circuit")
	}))
	req := httptest.NewRequest(http.MethodOptions, "/api/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("expected CORS headers to be set")
	}
}

func TestServerWriteStoreErrMappings(t *testing.T) {
	s := &Server{}
	tests := []struct {
		err      error
		code     int
		handled  bool
		testName string
	}{
		{err: ErrInvalidInput, code: http.StatusBadRequest, handled: true, testName: "invalid input"},
		{err: ErrConflict, code: http.StatusConflict, handled: true, testName: "conflict"},
		{err: ErrNotFound, code: http.StatusNotFound, handled: true, testName: "not found"},
		{err: context.Canceled, code: 0, handled: false, testName: "unhandled"},
	}
	for _, tc := range tests {
		t.Run(tc.testName, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handled := s.writeStoreErr(rec, tc.err)
			if handled != tc.handled {
				t.Fatalf("unexpected handled state: got %v want %v", handled, tc.handled)
			}
			if tc.handled && rec.Code != tc.code {
				t.Fatalf("unexpected status code: got %d want %d", rec.Code, tc.code)
			}
		})
	}
}
