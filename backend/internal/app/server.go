package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	cfg         Config
	logger      *slog.Logger
	store       *Store
	sessions    *SessionManager
	hub         *Hub
	media       *MediaManager
	httpSrv     *http.Server
	redirectSrv *http.Server
	upgrader    websocket.Upgrader
}

type companionInbound struct {
	Type string           `json:"type"`
	Data CompanionCommand `json:"data"`
}

func (s *Server) handleCompanionWS(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("companion websocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()
	presenceCh, unsubscribe := s.hub.SubscribePresence()
	defer unsubscribe()

	writeState := func() {
		state := CompanionBridgeState{
			Username: username,
			Bound:    false,
		}
		if presence, ok := s.hub.PresenceForUsername(username); ok {
			state.Bound = true
			state.Presence = &presence
		}
		if replyUserID, replyUsername, ok := s.hub.ReplyTargetForUsername(username); ok {
			state.ReplyDirectUserID = replyUserID
			state.ReplyDirectUsername = replyUsername
		}
		_ = conn.WriteJSON(WSOutbound{
			Type: "companion_state",
			Data: state,
		})
	}
	writeState()

	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case _, ok := <-presenceCh:
				if !ok {
					return
				}
				writeState()
			}
		}
	}()

	for {
		var in companionInbound
		if err := conn.ReadJSON(&in); err != nil {
			return
		}
		if in.Type != "command" {
			continue
		}
		commandID := strings.TrimSpace(in.Data.CommandID)
		token, ok := s.hub.LatestTokenForUsername(username)
		if !ok {
			_ = conn.WriteJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "target unavailable", "commandId": commandID},
			})
			continue
		}
		if in.Data.Command == "" {
			_ = conn.WriteJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "missing command", "commandId": commandID},
			})
			continue
		}
		if in.Data.Command == "set_voice_mode" && in.Data.Mode == "" {
			_ = conn.WriteJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "missing mode", "commandId": commandID},
			})
			continue
		}
		sent := s.hub.SendToToken(token, WSOutbound{
			Type: "companion_command",
			Data: in.Data,
		})
		if !sent {
			_ = conn.WriteJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "failed to deliver command", "commandId": commandID},
			})
			continue
		}
		_ = conn.WriteJSON(WSOutbound{
			Type: "companion_command_result",
			Data: map[string]any{"ok": true, "commandId": commandID},
		})
	}
}

func (s *Server) handleCompanionDiscovery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	targetUser, err := s.store.FindUserByUsername(r.Context(), username)
	if err != nil {
		http.Error(w, "unknown username", http.StatusNotFound)
		return
	}
	rooms, err := s.store.ListRooms(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	groups, err := s.store.ListBroadcastGroups(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	groups = filterBroadcastGroupsForRole(targetUser.RoleID, groups)
	roomDiscovery := make([]CompanionRoomDiscovery, 0, len(rooms))
	for _, room := range rooms {
		senderRoles, receiverRoles, err := s.store.RoomRolePolicies(r.Context(), room.ID)
		if err != nil {
			continue
		}
		roomDiscovery = append(roomDiscovery, CompanionRoomDiscovery{
			ID:        room.ID,
			Name:      room.Name,
			CanTalk:   isRoleAllowed(senderRoles, targetUser.RoleID),
			CanListen: isRoleAllowed(receiverRoles, targetUser.RoleID),
		})
	}
	s.writeJSON(w, http.StatusOK, CompanionDiscoveryResponse{
		Username:        targetUser.Username,
		RoleID:          targetUser.RoleID,
		Rooms:           roomDiscovery,
		Users:           users,
		BroadcastGroups: groups,
	})
}

func (s *Server) handleHTTPRedirectToHTTPS(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if parsedHost, _, err := net.SplitHostPort(r.Host); err == nil && parsedHost != "" {
		host = parsedHost
	}
	http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
}

func (s *Server) filterAllowedRoomsForRole(ctx context.Context, roleID string, roomIDs []string, forSend bool) []string {
	normalized := normalizeIDs(roomIDs)
	out := make([]string, 0, len(normalized))
	for _, roomID := range normalized {
		senderRoles, receiverRoles, err := s.store.RoomRolePolicies(ctx, roomID)
		if err != nil {
			continue
		}
		allowed := false
		if forSend {
			allowed = isRoleAllowed(senderRoles, roleID)
		} else {
			allowed = isRoleAllowed(receiverRoles, roleID)
		}
		if allowed {
			out = append(out, roomID)
		}
	}
	return out
}

func isRoleAllowed(allowedRoles map[string]struct{}, roleID string) bool {
	if len(allowedRoles) == 0 {
		return true
	}
	_, ok := allowedRoles[roleID]
	return ok
}

func NewServer(cfg Config) (*Server, error) {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	store, err := NewStore(cfg.DBPath)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:      cfg,
		logger:   logger,
		store:    store,
		sessions: NewSessionManager(cfg.SessionTTL),
		hub:      NewHub(store, logger),
		upgrader: websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }},
	}
	s.media = NewMediaManager(s.hub, logger)
	s.hub.SetMediaManager(s.media)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/healthz", s.handleHealth)
	mux.HandleFunc("/api/public-bootstrap", s.handlePublicBootstrap)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/logout", s.withAuth(s.handleLogout))
	mux.HandleFunc("/api/bootstrap", s.withAuth(s.handleBootstrap))
	mux.HandleFunc("/api/admin/roles", s.withAuth(s.handleAdminRoles))
	mux.HandleFunc("/api/admin/roles/", s.withAuth(s.handleAdminRoleByID))
	mux.HandleFunc("/api/admin/rooms", s.withAuth(s.handleAdminRooms))
	mux.HandleFunc("/api/admin/rooms/", s.withAuth(s.handleAdminRoomByID))
	mux.HandleFunc("/api/admin/broadcast-groups", s.withAuth(s.handleAdminBroadcastGroups))
	mux.HandleFunc("/api/admin/broadcast-groups/", s.withAuth(s.handleAdminBroadcastGroupByID))
	mux.HandleFunc("/api/companion/discovery", s.handleCompanionDiscovery)
	mux.HandleFunc("/api/companion/ws", s.handleCompanionWS)
	mux.HandleFunc("/ws", s.handleWS)
	if cfg.StaticDir != "" {
		mux.Handle("/", s.staticHandler())
	}
	serveAddr := cfg.Addr
	if cfg.ProductionMode {
		serveAddr = cfg.ProductionHTTPSAddr
	}
	s.httpSrv = &http.Server{
		Addr:              serveAddr,
		Handler:           s.withCORS(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	if cfg.ProductionMode {
		s.redirectSrv = &http.Server{
			Addr:              cfg.ProductionHTTPRedirectAddr,
			Handler:           http.HandlerFunc(s.handleHTTPRedirectToHTTPS),
			ReadHeaderTimeout: 5 * time.Second,
		}
	}
	return s, nil
}

func (s *Server) ListenAndServe() error {
	if s.cfg.ProductionMode {
		if s.cfg.TLSCertFile == "" || s.cfg.TLSKeyFile == "" {
			return errors.New("production mode requires TLS_CERT_FILE and TLS_KEY_FILE")
		}
		s.logger.Info(
			"starting production servers",
			"httpsAddr", s.cfg.ProductionHTTPSAddr,
			"httpRedirectAddr", s.cfg.ProductionHTTPRedirectAddr,
			"dbPath", s.cfg.DBPath,
		)
		redirectErrCh := make(chan error, 1)
		go func() {
			err := s.redirectSrv.ListenAndServe()
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				redirectErrCh <- err
			}
		}()
		err := s.httpSrv.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		if s.redirectSrv != nil {
			_ = s.redirectSrv.Close()
		}
		select {
		case redirectErr := <-redirectErrCh:
			return redirectErr
		default:
		}
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
	s.logger.Info("starting server", "addr", s.cfg.Addr, "dbPath", s.cfg.DBPath)
	var err error
	if s.cfg.TrustedLANHTTP {
		err = s.httpSrv.ListenAndServe()
	} else {
		if s.cfg.TLSCertFile == "" || s.cfg.TLSKeyFile == "" {
			return errors.New("https is enabled but TLS_CERT_FILE or TLS_KEY_FILE is not set")
		}
		err = s.httpSrv.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
	}
	if !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	_ = s.store.Close()
	var shutdownErr error
	if s.redirectSrv != nil {
		if err := s.redirectSrv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			shutdownErr = err
		}
	}
	if err := s.httpSrv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) && shutdownErr == nil {
		shutdownErr = err
	}
	return shutdownErr
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handlePublicBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	roles, err := s.store.ListRoles(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	rooms, err := s.store.ListRooms(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	groups, err := s.store.ListBroadcastGroups(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, PublicBootstrapResponse{
		Roles:           roles,
		Rooms:           rooms,
		BroadcastGroups: groups,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.RoleID == "" {
		http.Error(w, "username and roleId required", http.StatusBadRequest)
		return
	}
	ok, err := s.store.RoleExists(r.Context(), req.RoleID)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	if !ok {
		http.Error(w, "invalid role", http.StatusBadRequest)
		return
	}
	user, err := s.store.UpsertUser(r.Context(), req.Username, req.RoleID)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	session := s.sessions.Create(user)
	s.writeJSON(w, http.StatusOK, LoginResponse{Token: session.Token, User: user})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, session Session) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.hub.Remove(session.Token)
	s.sessions.Delete(session.Token)
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request, session Session) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	roles, err := s.store.ListRoles(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	rooms, err := s.store.ListRooms(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	groups, err := s.store.ListBroadcastGroups(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	var self User
	for _, u := range users {
		if u.ID == session.UserID {
			self = u
			break
		}
	}
	s.writeJSON(w, http.StatusOK, BootstrapResponse{
		Self:            self,
		Roles:           roles,
		Rooms:           rooms,
		BroadcastGroups: groups,
		Users:           users,
	})
}

func filterBroadcastGroupsForRole(roleID string, groups []BroadcastGroup) []BroadcastGroup {
	filtered := make([]BroadcastGroup, 0, len(groups))
	for _, group := range groups {
		if isRoleAllowed(toStringSet(group.AllowedRoleIDs), roleID) {
			filtered = append(filtered, group)
		}
	}
	return filtered
}

type upsertRoleRequest struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	DefaultRoomID     string `json:"defaultRoomId"`
	DefaultVoiceMode  string `json:"defaultVoiceMode"`
	DefaultSimpleView bool   `json:"defaultSimpleView"`
}

type upsertRoomRequest struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	SenderRoleIDs   []string `json:"senderRoleIds"`
	ReceiverRoleIDs []string `json:"receiverRoleIds"`
}

type upsertBroadcastGroupRequest struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	RoomIDs        []string `json:"roomIds"`
	AllowedRoleIDs []string `json:"allowedRoleIds"`
}

func (s *Server) handleAdminRoles(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, session) {
		return
	}
	switch r.Method {
	case http.MethodPost:
		var req upsertRoleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.CreateRole(r.Context(), req.ID, req.Name, req.DefaultRoomID, req.DefaultVoiceMode, req.DefaultSimpleView); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminRoleByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, session) {
		return
	}
	roleID := strings.TrimPrefix(r.URL.Path, "/api/admin/roles/")
	if roleID == "" || strings.Contains(roleID, "/") {
		http.Error(w, "invalid role id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req upsertRoleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.UpdateRole(r.Context(), roleID, req.Name, req.DefaultRoomID, req.DefaultVoiceMode, req.DefaultSimpleView); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case http.MethodDelete:
		if err := s.store.DeleteRole(r.Context(), roleID); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminRooms(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, session) {
		return
	}
	switch r.Method {
	case http.MethodPost:
		var req upsertRoomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.CreateRoom(r.Context(), req.ID, req.Name, req.SenderRoleIDs, req.ReceiverRoleIDs); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminRoomByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, session) {
		return
	}
	roomID := strings.TrimPrefix(r.URL.Path, "/api/admin/rooms/")
	if roomID == "" || strings.Contains(roomID, "/") {
		http.Error(w, "invalid room id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req upsertRoomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.UpdateRoom(r.Context(), roomID, req.Name, req.SenderRoleIDs, req.ReceiverRoleIDs); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case http.MethodDelete:
		if err := s.store.DeleteRoom(r.Context(), roomID); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminBroadcastGroups(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, session) {
		return
	}
	switch r.Method {
	case http.MethodPost:
		var req upsertBroadcastGroupRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.CreateBroadcastGroup(r.Context(), req.ID, req.Name, req.RoomIDs, req.AllowedRoleIDs); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminBroadcastGroupByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, session) {
		return
	}
	groupID := strings.TrimPrefix(r.URL.Path, "/api/admin/broadcast-groups/")
	if groupID == "" || strings.Contains(groupID, "/") {
		http.Error(w, "invalid broadcast group id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req upsertBroadcastGroupRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.UpdateBroadcastGroup(r.Context(), groupID, req.Name, req.RoomIDs, req.AllowedRoleIDs); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case http.MethodDelete:
		if err := s.store.DeleteBroadcastGroup(r.Context(), groupID); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) requireAdmin(_ http.ResponseWriter, _ Session) bool {
	return true
}

func (s *Server) writeStoreErr(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, ErrInvalidInput):
		http.Error(w, "invalid input", http.StatusBadRequest)
		return true
	case errors.Is(err, ErrConflict):
		http.Error(w, "conflict", http.StatusConflict)
		return true
	case errors.Is(err, ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
		return true
	default:
		return false
	}
}

func (s *Server) withAuth(next func(http.ResponseWriter, *http.Request, Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if auth == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		session, ok := s.sessions.Get(auth)
		if !ok {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		next(w, r, session)
	}
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AllowCORS {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	session, ok := s.sessions.Get(token)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("websocket upgrade failed", "error", err)
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		_ = conn.Close()
		return
	}
	roles, err := s.store.ListRoles(r.Context())
	if err != nil {
		_ = conn.Close()
		return
	}
	rooms, err := s.store.ListRooms(r.Context())
	if err != nil {
		_ = conn.Close()
		return
	}
	var user User
	for _, u := range users {
		if u.ID == session.UserID {
			user = u
			break
		}
	}
	initialVoiceMode := "ptt"
	initialMicEnabled := false
	for _, role := range roles {
		if role.ID != session.RoleID {
			continue
		}
		if role.DefaultVoiceMode == "always_on" {
			initialVoiceMode = "always_on"
			initialMicEnabled = true
		}
		break
	}
	defaultRoomID := defaultRoomForSession(session, roles, rooms)
	listenRooms := []string{}
	talkRooms := []string{}
	if defaultRoomID != "" {
		listenRooms = []string{defaultRoomID}
		talkRooms = []string{defaultRoomID}
	}
	listenRooms = s.filterAllowedRoomsForRole(r.Context(), session.RoleID, listenRooms, false)
	talkRooms = s.filterAllowedRoomsForRole(r.Context(), session.RoleID, talkRooms, true)
	defaultRoomID = firstNonEmpty(talkRooms, listenRooms, "")
	c := &client{
		session:         session,
		user:            user,
		activeRoom:      defaultRoomID,
		listenRooms:     toRoomSet(listenRooms),
		talkRooms:       toRoomSet(talkRooms),
		voiceMode:       initialVoiceMode,
		micEnabled:      initialMicEnabled,
		broadcastGroups: make(map[string]struct{}),
		send:            make(chan WSOutbound, 32),
	}
	s.hub.Add(c)
	if err := s.media.EnsurePeer(session.Token, user); err != nil {
		s.logger.Error("failed to initialize media peer", "error", err)
	}
	defer s.hub.Remove(session.Token)
	currentRoom := c.activeRoom
	mediaReady := false

	go func() {
		for msg := range c.send {
			_ = conn.WriteJSON(msg)
		}
	}()

	for {
		var in WSInbound
		if err := conn.ReadJSON(&in); err != nil {
			_ = conn.Close()
			return
		}
		switch in.Type {
		case "webrtc_ready":
			mediaReady = true
			s.media.EnsureNegotiation(session.Token)
			s.media.SyncRouting()
		case "set_active_room":
			raw, _ := json.Marshal(in.Data)
			var e ActiveRoomEvent
			_ = json.Unmarshal(raw, &e)
			allowedListen := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, []string{e.RoomID}, false)
			allowedTalk := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, []string{e.RoomID}, true)
			currentRoom = firstNonEmpty(allowedTalk, allowedListen, "")
			s.hub.SetActiveRoom(session.Token, currentRoom)
			s.hub.SetRoomMatrix(session.Token, allowedListen, allowedTalk)
			if mediaReady {
				s.media.SyncRouting()
			}
		case "set_room_matrix":
			raw, _ := json.Marshal(in.Data)
			var e RoomMatrixEvent
			_ = json.Unmarshal(raw, &e)
			allowedListen := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, e.ListenRoomIDs, false)
			allowedTalk := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, e.TalkRoomIDs, true)
			if e.ActiveRoomID != "" {
				activeTalk := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, []string{e.ActiveRoomID}, true)
				activeListen := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, []string{e.ActiveRoomID}, false)
				currentRoom = firstNonEmpty(activeTalk, activeListen, firstNonEmpty(allowedTalk, allowedListen, currentRoom))
			} else {
				currentRoom = firstNonEmpty(allowedTalk, allowedListen, currentRoom)
			}
			s.hub.SetActiveRoom(session.Token, currentRoom)
			s.hub.SetRoomMatrix(session.Token, allowedListen, allowedTalk)
			if mediaReady {
				s.media.SyncRouting()
			}
		case "chat":
			s.routeInbound(r.Context(), session, in, "chat")
		case "signal":
			s.routeInbound(r.Context(), session, in, "signal")
		case "voice_state":
			raw, _ := json.Marshal(in.Data)
			var e RoutedEvent
			_ = json.Unmarshal(raw, &e)
			if !s.isInboundAllowed(r.Context(), session, e) {
				continue
			}
			s.hub.SetVoiceState(session.Token, e.Body)
			if e.Scope == "direct" {
				if e.Body == "ptt_start" {
					s.media.SetDirectTargetActive(session.Token, e.TargetID, true)
				}
				if e.Body == "ptt_stop" {
					s.media.SetDirectTargetActive(session.Token, e.TargetID, false)
				}
			}
			if e.Scope == "broadcast" {
				if e.Body == "ptt_start" {
					s.hub.SetBroadcastActive(session.Token, e.TargetID, true)
					s.media.SetBroadcastGroupActive(session.Token, e.TargetID, true)
				}
				if e.Body == "ptt_stop" {
					s.hub.SetBroadcastActive(session.Token, e.TargetID, false)
					s.media.SetBroadcastGroupActive(session.Token, e.TargetID, false)
				}
			}
			s.routeInbound(r.Context(), session, in, "voice_state")
		case "webrtc_answer":
			raw, _ := json.Marshal(in.Data)
			var e WebRTCAnswer
			_ = json.Unmarshal(raw, &e)
			if e.SDP != "" {
				if err := s.media.HandleAnswer(session.Token, e.SDP); err != nil {
					s.logger.Warn("failed to process webrtc answer", "error", err)
				}
			}
		case "webrtc_ice_candidate":
			raw, _ := json.Marshal(in.Data)
			var e WebRTCIceCandidate
			_ = json.Unmarshal(raw, &e)
			if e.Candidate != "" {
				if err := s.media.HandleICECandidate(session.Token, e); err != nil {
					s.logger.Warn("failed to process webrtc ice candidate", "error", err)
				}
			}
		}
	}
}

func (s *Server) routeInbound(ctx context.Context, sender Session, in WSInbound, outType string) {
	raw, _ := json.Marshal(in.Data)
	var e RoutedEvent
	if err := json.Unmarshal(raw, &e); err != nil {
		return
	}
	if e.Scope == "" || e.TargetID == "" {
		return
	}
	if !s.isInboundAllowed(ctx, sender, e) {
		return
	}
	s.hub.RouteEvent(sender.Token, outType, e)
}

func (s *Server) isInboundAllowed(ctx context.Context, sender Session, e RoutedEvent) bool {
	switch e.Scope {
	case "room":
		senderRoles, _, err := s.store.RoomRolePolicies(ctx, e.TargetID)
		return err == nil && isRoleAllowed(senderRoles, sender.RoleID)
	case "broadcast":
		allowedRoles, err := s.store.BroadcastGroupAllowedRoleSet(ctx, e.TargetID)
		if err != nil || !isRoleAllowed(allowedRoles, sender.RoleID) {
			return false
		}
		roomSet, err := s.store.BroadcastGroupRoomSet(ctx, e.TargetID)
		if err != nil {
			return false
		}
		for roomID := range roomSet {
			senderRoles, _, err := s.store.RoomRolePolicies(ctx, roomID)
			if err != nil {
				continue
			}
			if isRoleAllowed(senderRoles, sender.RoleID) {
				return true
			}
		}
		return false
	default:
		return true
	}
}

func (s *Server) staticHandler() http.Handler {
	fileServer := http.FileServer(http.Dir(s.cfg.StaticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/" {
			http.ServeFile(w, r, s.cfg.StaticDir+"/index.html")
			return
		}
		requestedPath := filepath.Join(s.cfg.StaticDir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(requestedPath); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, s.cfg.StaticDir+"/index.html")
		return
	})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) internalErr(w http.ResponseWriter, err error) {
	s.logger.Error("request failed", "error", err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}

func defaultRoomForSession(session Session, roles []Role, rooms []Room) string {
	for _, role := range roles {
		if role.ID == session.RoleID && role.DefaultRoomID != "" {
			return role.DefaultRoomID
		}
	}
	if len(rooms) > 0 {
		return rooms[0].ID
	}
	return ""
}

func firstNonEmpty(primary []string, secondary []string, fallback string) string {
	for _, values := range [][]string{primary, secondary} {
		for _, value := range values {
			if value != "" {
				return value
			}
		}
	}
	return fallback
}
