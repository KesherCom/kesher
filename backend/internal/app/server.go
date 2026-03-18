package app

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type AckSettings struct {
	Enabled bool `json:"enabled"`
}

type Server struct {
	cfg         Config
	logger      *slog.Logger
	store       *Store
	sessions    *SessionManager
	sessionMu   sync.Mutex
	hub         *Hub
	media       *MediaManager
	telegram    *TelegramBot
	certMagic   tlsProvider
	httpSrv     *http.Server
	redirectSrv *http.Server
	upgrader    websocket.Upgrader
	ackMu       sync.RWMutex
	ackEnabled  bool
	ackSet      bool
}

type tlsProvider interface {
	ManageSync(ctx context.Context, domainNames []string) error
	TLSConfig() *tls.Config
}

func (s *Server) listenAndServeHTTPS() error {
	switch strings.ToLower(strings.TrimSpace(s.cfg.TLSMode)) {
	case "internal":
		tlsCfg, err := newInternalTLSConfig(s.httpSrv.Addr)
		if err != nil {
			return fmt.Errorf("failed to generate internal tls certificate: %w", err)
		}
		ln, err := net.Listen("tcp", s.httpSrv.Addr)
		if err != nil {
			return err
		}
		return s.httpSrv.Serve(tls.NewListener(ln, tlsCfg))
	case "", "file":
		if s.cfg.TLSCertFile == "" || s.cfg.TLSKeyFile == "" {
			return errors.New("file TLS mode requires TLS_CERT_FILE and TLS_KEY_FILE")
		}
		return s.httpSrv.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
	case "certmagic":
		if s.certMagic == nil {
			return errors.New("TLS_MODE=certmagic is configured but CertMagic is not initialized")
		}
		if err := s.certMagic.ManageSync(context.Background(), s.cfg.CertMagicDomains); err != nil {
			return fmt.Errorf("failed to initialize certificate management: %w", err)
		}
		ln, err := net.Listen("tcp", s.httpSrv.Addr)
		if err != nil {
			return err
		}
		return s.httpSrv.Serve(tls.NewListener(ln, s.certMagic.TLSConfig()))
	default:
		return fmt.Errorf("unsupported TLS_MODE %q", s.cfg.TLSMode)
	}
}

type companionInbound struct {
	Type string           `json:"type"`
	Data CompanionCommand `json:"data"`
}

const (
	websocketPingInterval    = 30 * time.Second
	websocketReadTimeout     = 60 * time.Second
	websocketPingWriteWindow = 5 * time.Second
)

func refreshWebSocketReadDeadline(conn *websocket.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(websocketReadTimeout))
}

func writeWebSocketPing(conn *websocket.Conn, connMu *sync.Mutex) {
	if connMu != nil {
		connMu.Lock()
		defer connMu.Unlock()
	}
	_ = conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(websocketPingWriteWindow))
}

func startWebSocketKeepalive(conn *websocket.Conn, connMu *sync.Mutex) func() {
	pingTicker := time.NewTicker(websocketPingInterval)
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-pingTicker.C:
				writeWebSocketPing(conn, connMu)
			}
		}
	}()
	refreshWebSocketReadDeadline(conn)
	conn.SetPongHandler(func(string) error {
		refreshWebSocketReadDeadline(conn)
		return nil
	})
	return func() {
		close(stop)
		pingTicker.Stop()
	}
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
	var connMu sync.Mutex
	writeJSON := func(msg WSOutbound) {
		connMu.Lock()
		defer connMu.Unlock()
		_ = conn.WriteJSON(msg)
	}

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
		if signalFrom, signalMessage, signalActive := s.hub.SignalStateForUsername(username); signalActive {
			state.SignalActive = true
			state.SignalFrom = signalFrom
			state.SignalMessage = signalMessage
		}
		writeJSON(WSOutbound{
			Type: "companion_state",
			Data: state,
		})
	}
	writeState()

	stopKeepalive := startWebSocketKeepalive(conn, &connMu)
	defer stopKeepalive()

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
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				s.logger.Warn("companion websocket closed unexpectedly", "username", username, "error", err)
			}
			return
		}
		refreshWebSocketReadDeadline(conn)
		if in.Type != "command" {
			continue
		}
		commandID := strings.TrimSpace(in.Data.CommandID)
		token, ok := s.hub.LatestTokenForUsername(username)
		if !ok {
			writeJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "target unavailable", "commandId": commandID},
			})
			continue
		}
		if in.Data.Command == "" {
			writeJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "missing command", "commandId": commandID},
			})
			continue
		}
		if in.Data.Command == "set_voice_mode" && in.Data.Mode == "" {
			writeJSON(WSOutbound{
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
			writeJSON(WSOutbound{
				Type: "companion_command_result",
				Data: map[string]any{"ok": false, "error": "failed to deliver command", "commandId": commandID},
			})
			continue
		}
		writeJSON(WSOutbound{
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
		canTalk, err := s.store.RoomAllowsSenderRole(r.Context(), room.ID, targetUser.RoleID)
		if err != nil {
			continue
		}
		canListen, err := s.store.RoomAllowsReceiverRole(r.Context(), room.ID, targetUser.RoleID)
		if err != nil {
			continue
		}
		roomDiscovery = append(roomDiscovery, CompanionRoomDiscovery{
			ID:        room.ID,
			Name:      room.Name,
			CanTalk:   canTalk,
			CanListen: canListen,
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
		var (
			allowed bool
			err     error
		)
		if forSend {
			allowed, err = s.store.RoomAllowsSenderRole(ctx, roomID, roleID)
		} else {
			allowed, err = s.store.RoomAllowsReceiverRole(ctx, roomID, roleID)
		}
		if err == nil && allowed {
			out = append(out, roomID)
		}
	}
	return out
}

// mergeForcedListenRooms adds any forced-listen rooms for the role that are not
// already present in the listen set.
func (s *Server) mergeForcedListenRooms(ctx context.Context, roleID string, listenRooms []string) []string {
	forced, err := s.store.ForcedListenRoomIDs(ctx, roleID)
	if err != nil || len(forced) == 0 {
		return listenRooms
	}
	existing := make(map[string]struct{}, len(listenRooms))
	for _, r := range listenRooms {
		existing[r] = struct{}{}
	}
	for _, r := range forced {
		if _, ok := existing[r]; !ok {
			listenRooms = append(listenRooms, r)
		}
	}
	return listenRooms
}

func isRoleAllowed(allowedRoles map[string]struct{}, roleID string) bool {
	if len(allowedRoles) == 0 {
		return false
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
	if cfg.AdminPINFromEnv {
		if err := store.SetAdminPIN(context.Background(), cfg.AdminPIN); err != nil {
			return nil, err
		}
	}
	s := &Server{
		cfg:        cfg,
		logger:     logger,
		store:      store,
		sessions:   NewSessionManager(cfg.SessionTTL),
		hub:        NewHub(store, logger),
		ackEnabled: true,
		ackSet:     true,
		upgrader: websocket.Upgrader{
			CheckOrigin:      func(r *http.Request) bool { return true },
			HandshakeTimeout: 10 * time.Second,
		},
	}
	s.media = NewMediaManager(s.hub, logger)
	s.hub.SetMediaManager(s.media)
	if cfg.TelegramBotToken != "" {
		s.telegram = NewTelegramBot(cfg.TelegramBotToken, cfg.TelegramWebhookSecret, cfg.TelegramMode, store, s.hub, logger)
	}
	if strings.EqualFold(cfg.TLSMode, "certmagic") {
		certMagicCfg, err := newCertMagicConfig(cfg)
		if err != nil {
			return nil, err
		}
		s.certMagic = certMagicCfg
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/healthz", s.handleHealth)
	mux.HandleFunc("/api/public-bootstrap", s.handlePublicBootstrap)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/admin/login", s.handleAdminLogin)
	mux.HandleFunc("/api/login/takeover", s.handleLoginTakeover)
	mux.HandleFunc("/api/logout", s.withAuth(s.handleLogout))
	mux.HandleFunc("/api/bootstrap", s.withAuth(s.handleBootstrap))
	mux.HandleFunc("/api/status", s.withAuth(s.handleStatus))
	mux.HandleFunc("/api/user/stream-deck/settings", s.withAuth(s.handleUserStreamDeckSettings))
	mux.HandleFunc("/api/admin/roles", s.withAuth(s.handleAdminRoles))
	mux.HandleFunc("/api/admin/roles/", s.withAuth(s.handleAdminRoleByID))
	mux.HandleFunc("/api/admin/rooms", s.withAuth(s.handleAdminRooms))
	mux.HandleFunc("/api/admin/rooms/", s.withAuth(s.handleAdminRoomByID))
	// backwards-compatible aliases using new terminology
	mux.HandleFunc("/api/admin/party-lines", s.withAuth(s.handleAdminRooms))
	mux.HandleFunc("/api/admin/party-lines/", s.withAuth(s.handleAdminRoomByID))
	mux.HandleFunc("/api/admin/broadcast-groups", s.withAuth(s.handleAdminBroadcastGroups))
	mux.HandleFunc("/api/admin/broadcast-groups/", s.withAuth(s.handleAdminBroadcastGroupByID))
	mux.HandleFunc("/api/admin/pin", s.withAuth(s.handleAdminPin))
	mux.HandleFunc("/api/admin/chat-history/clear", s.withAuth(s.handleAdminClearChatHistory))
	mux.HandleFunc("/api/admin/ack-settings", s.withAuth(s.handleAdminAckSettings))
	mux.HandleFunc("/api/admin/configuration-export", s.withAuth(s.handleAdminConfigurationExport))
	mux.HandleFunc("/api/admin/configuration-import", s.withAuth(s.handleAdminConfigurationImport))
	mux.HandleFunc("/api/admin/routing-matrix", s.withAuth(s.handleAdminRoutingMatrix))
	mux.HandleFunc("/api/companion/discovery", s.handleCompanionDiscovery)
	mux.HandleFunc("/api/companion/ws", s.handleCompanionWS)
	mux.HandleFunc("/api/telegram/webhook", s.handleTelegramWebhook)
	mux.HandleFunc("/api/admin/telegram", s.withAuth(s.handleAdminTelegram))
	mux.HandleFunc("/api/admin/telegram/", s.withAuth(s.handleAdminTelegramByID))
	mux.HandleFunc("/api/admin/telegram-users", s.withAuth(s.handleAdminTelegramUsers))
	mux.HandleFunc("/api/admin/telegram-users/", s.withAuth(s.handleAdminTelegramUserByID))
	mux.HandleFunc("/api/realtime-stats", s.withAuth(s.handleRealtimeStats))
	mux.HandleFunc("/ws", s.handleWS)
	if cfg.StaticDir != "" || embeddedStaticAvailable() {
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
	// Start Telegram long polling if configured
	if s.telegram != nil && s.telegram.Mode() == "polling" {
		if err := s.telegram.DeleteWebhook(); err != nil {
			s.logger.Warn("failed to delete telegram webhook before polling", "error", err)
		}
		s.telegram.StartPolling()
	}
	if s.cfg.ProductionMode {
		s.logger.Info(
			"starting production servers",
			"httpsAddr", s.cfg.ProductionHTTPSAddr,
			"httpRedirectAddr", s.cfg.ProductionHTTPRedirectAddr,
			"tlsMode", s.cfg.TLSMode,
			"dbPath", s.cfg.DBPath,
		)
		redirectErrCh := make(chan error, 1)
		go func() {
			err := s.redirectSrv.ListenAndServe()
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				redirectErrCh <- err
			}
		}()
		err := s.listenAndServeHTTPS()
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
		err = s.listenAndServeHTTPS()
	}
	if !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.telegram != nil {
		s.telegram.StopPolling()
	}
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

type RealtimeStatsResponse struct {
	Hub              HubRealtimeStats   `json:"hub"`
	Media            MediaRealtimeStats `json:"media"`
	StorePolicyCache PolicyCacheStats   `json:"storePolicyCache"`
	TimestampUnixMs  int64              `json:"timestampUnixMs"`
}

func (s *Server) handleRealtimeStats(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	hubStats := HubRealtimeStats{}
	if s.hub != nil {
		hubStats = s.hub.RealtimeStats()
	}
	mediaStats := MediaRealtimeStats{}
	if s.media != nil {
		mediaStats = s.media.RealtimeStats()
	}
	storeCacheStats := PolicyCacheStats{}
	if s.store != nil {
		storeCacheStats = s.store.PolicyCacheStats()
	}
	s.writeJSON(w, http.StatusOK, RealtimeStatsResponse{
		Hub:              hubStats,
		Media:            mediaStats,
		StorePolicyCache: storeCacheStats,
		TimestampUnixMs:  time.Now().UnixMilli(),
	})
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
		AckEnabled:      s.isAckEnabled(),
		AppVersion:      GetVersionInfo(),
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
	if !isValidLoginRequest(req.Username, req.RoleID) {
		http.Error(w, "username and roleId required", http.StatusBadRequest)
		return
	}
	if strings.ContainsAny(req.Username, " \t\n\r") {
		http.Error(w, "username must not contain whitespace", http.StatusBadRequest)
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
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if existing, conflict := s.sessions.LatestForRole(req.RoleID); conflict {
		s.writeJSON(w, http.StatusConflict, LoginConflictResponse{
			RequiresTakeover: true,
			ConflictRoleID:   req.RoleID,
			ConflictRoleName: s.roleNameByID(r.Context(), req.RoleID),
			ConflictUsername: existing.Username,
		})
		return
	}
	user, err := s.store.UpsertUser(r.Context(), req.Username, req.RoleID)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			http.Error(w, "username must not contain whitespace", http.StatusBadRequest)
			return
		}
		s.internalErr(w, err)
		return
	}
	session := s.sessions.Create(user)
	s.writeJSON(w, http.StatusOK, LoginResponse{Token: session.Token, User: user})
}

func (s *Server) handleLoginTakeover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req LoginTakeoverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if !isValidLoginRequest(req.Username, req.RoleID) {
		http.Error(w, "username and roleId required", http.StatusBadRequest)
		return
	}
	if strings.ContainsAny(req.Username, " \t\n\r") {
		http.Error(w, "username must not contain whitespace", http.StatusBadRequest)
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

	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()

	revokedSessions := s.sessions.DeleteByRole(req.RoleID)
	revokedTokens := make(map[string]struct{}, len(revokedSessions))
	for _, revoked := range revokedSessions {
		revokedTokens[revoked.Token] = struct{}{}
	}
	for _, token := range s.hub.TokensForRole(req.RoleID) {
		if _, ok := revokedTokens[token]; !ok {
			s.sessions.Delete(token)
		}
		s.hub.RemoveWithReason(token, "takeover")
	}

	user, err := s.store.UpsertUser(r.Context(), req.Username, req.RoleID)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			http.Error(w, "username must not contain whitespace", http.StatusBadRequest)
			return
		}
		s.internalErr(w, err)
		return
	}
	session := s.sessions.Create(user)
	s.writeJSON(w, http.StatusOK, LoginResponse{Token: session.Token, User: user})
}

func (s *Server) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req AdminLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	configuredPIN, err := s.store.GetAdminPIN(r.Context())
	if err != nil || strings.TrimSpace(configuredPIN) == "" {
		http.Error(w, "admin pin unavailable", http.StatusForbidden)
		return
	}
	presentedPIN := strings.TrimSpace(req.PIN)
	if subtle.ConstantTimeCompare([]byte(presentedPIN), []byte(configuredPIN)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	session := s.sessions.Create(User{Username: "admin"})
	s.writeJSON(w, http.StatusOK, LoginResponse{Token: session.Token, User: User{Username: "admin"}})
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
		AckEnabled:      s.isAckEnabled(),
		AppVersion:      GetVersionInfo(),
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request, _ Session) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	roomListenerCounts := map[string]int{}
	if s.hub != nil {
		roomListenerCounts = s.hub.RoomListenerCounts()
	}
	s.writeJSON(w, http.StatusOK, StatusResponse{
		RoomListenerCounts: roomListenerCounts,
		TimestampUnixMs:    time.Now().UnixMilli(),
	})
}

func (s *Server) handleUserStreamDeckSettings(w http.ResponseWriter, r *http.Request, session Session) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.store.GetUserStreamDeckSettings(r.Context(), session.UserID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				s.writeJSON(w, http.StatusOK, DefaultStreamDeckSettings())
				return
			}
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, settings)
	case http.MethodPut:
		var req StreamDeckSettings
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		settings, err := s.store.UpsertUserStreamDeckSettings(r.Context(), session.UserID, req)
		if err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, settings)
	case http.MethodDelete:
		err := s.store.DeleteUserStreamDeckSettings(r.Context(), session.UserID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, DefaultStreamDeckSettings())
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
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

func isValidLoginRequest(username, roleID string) bool {
	return strings.TrimSpace(username) != "" && strings.TrimSpace(roleID) != ""
}

func (s *Server) roleNameByID(ctx context.Context, roleID string) string {
	roles, err := s.store.ListRoles(ctx)
	if err != nil {
		return ""
	}
	for _, role := range roles {
		if role.ID == roleID {
			return role.Name
		}
	}
	return ""
}

type upsertRoleRequest struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	DefaultRoomID     string `json:"defaultRoomId"`
	DefaultVoiceMode  string `json:"defaultVoiceMode"`
	DefaultSimpleView bool   `json:"defaultSimpleView"`
}

type upsertRoomRequest struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	SenderRoleIDs       []string `json:"senderRoleIds"`
	ReceiverRoleIDs     []string `json:"receiverRoleIds"`
	ForcedListenRoleIDs []string `json:"forcedListenRoleIds"`
}

type upsertBroadcastGroupRequest struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	RoomIDs        []string `json:"roomIds"`
	AllowedRoleIDs []string `json:"allowedRoleIds"`
}

func (s *Server) handleAdminRoles(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
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
	if !s.requireAdmin(w, r, session) {
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
	if !s.requireAdmin(w, r, session) {
		return
	}
	switch r.Method {
	case http.MethodPost:
		var req upsertRoomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.CreateRoom(r.Context(), req.ID, req.Name, req.SenderRoleIDs, req.ReceiverRoleIDs, req.ForcedListenRoleIDs); err != nil {
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
	if !s.requireAdmin(w, r, session) {
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
		if err := s.store.UpdateRoom(r.Context(), roomID, req.Name, req.SenderRoleIDs, req.ReceiverRoleIDs, req.ForcedListenRoleIDs); err != nil {
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
	if !s.requireAdmin(w, r, session) {
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
	if !s.requireAdmin(w, r, session) {
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

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request, _ Session) bool {
	configuredPIN, err := s.store.GetAdminPIN(r.Context())
	if err != nil || strings.TrimSpace(configuredPIN) == "" {
		http.Error(w, "admin pin unavailable", http.StatusForbidden)
		return false
	}
	presentedPIN := strings.TrimSpace(r.Header.Get("X-Admin-Pin"))
	if subtle.ConstantTimeCompare([]byte(presentedPIN), []byte(configuredPIN)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	return true
}

type updateAdminPINRequest struct {
	NewPIN string `json:"newPin"`
}

func (s *Server) handleAdminPin(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req updateAdminPINRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.store.SetAdminPIN(r.Context(), req.NewPIN); err != nil {
		if s.writeStoreErr(w, err) {
			return
		}
		s.internalErr(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAdminClearChatHistory(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.hub != nil {
		s.hub.ClearChatHistory()
		s.hub.BroadcastChatHistoryCleared()
	}
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAdminAckSettings(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.writeJSON(w, http.StatusOK, AckSettings{Enabled: s.isAckEnabled()})
	case http.MethodPut:
		var req AckSettings
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		s.setAckEnabled(req.Enabled)
		if s.hub != nil {
			roles, err := s.store.ListRoles(r.Context())
			if err != nil {
				http.Error(w, "failed to fetch roles", http.StatusInternalServerError)
				return
			}
			rooms, err := s.store.ListRooms(r.Context())
			if err != nil {
				http.Error(w, "failed to fetch rooms", http.StatusInternalServerError)
				return
			}
			groups, err := s.store.ListBroadcastGroups(r.Context())
			if err != nil {
				http.Error(w, "failed to fetch broadcast groups", http.StatusInternalServerError)
				return
			}
			s.hub.BroadcastConfigUpdate(PublicBootstrapResponse{
				Roles:           roles,
				Rooms:           rooms,
				BroadcastGroups: groups,
				AckEnabled:      s.isAckEnabled(),
				AppVersion:      GetVersionInfo(),
			})
		}
		s.writeJSON(w, http.StatusOK, AckSettings{Enabled: s.isAckEnabled()})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminConfigurationExport(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	doc, err := s.exportConfigurationDocument(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment; filename=kesher-showfile.json")
	s.writeJSON(w, http.StatusOK, doc)
}

func (s *Server) handleAdminConfigurationImport(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req ConfigurationImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	state, sections, revokedUsernames, err := s.importConfigurationDocument(r.Context(), req)
	if err != nil {
		s.logger.Warn("configuration import rejected",
			"admin", session.Username,
			"requestedSections", req.Sections,
			"documentSections", req.Document.Meta.Sections,
			"error", err.Error(),
		)
		if errors.Is(err, ErrInvalidInput) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if s.writeStoreErr(w, err) {
			return
		}
		http.Error(w, "invalid input", http.StatusBadRequest)
		return
	}
	s.revokeSessionsForUsernames(revokedUsernames)
	s.broadcastImportedConfiguration(state)
	s.writeJSON(w, http.StatusOK, ConfigurationImportResponse{ImportedSections: sections})
}

func (s *Server) isAckEnabled() bool {
	s.ackMu.RLock()
	defer s.ackMu.RUnlock()
	if !s.ackSet {
		return true
	}
	return s.ackEnabled
}

func (s *Server) setAckEnabled(enabled bool) {
	s.ackMu.Lock()
	s.ackEnabled = enabled
	s.ackSet = true
	s.ackMu.Unlock()
}

func (s *Server) handleTelegramWebhook(w http.ResponseWriter, r *http.Request) {
	if s.telegram == nil {
		http.Error(w, "telegram bot not configured", http.StatusServiceUnavailable)
		return
	}
	s.telegram.HandleWebhook(w, r)
}

type upsertTelegramMappingRequest struct {
	ChatID string `json:"chatId"`
	Label  string `json:"label"`
	RoomID string `json:"roomId"`
}

type createTelegramAllowlistRequest struct {
	TelegramUsername string `json:"telegramUsername"`
	KesherUsername   string `json:"kesherUsername"`
}

func (s *Server) handleAdminTelegram(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		mappings, err := s.store.ListTelegramMappings(r.Context())
		if err != nil {
			s.internalErr(w, err)
			return
		}
		if mappings == nil {
			mappings = []TelegramMapping{}
		}
		mode := ""
		if s.telegram != nil {
			mode = s.telegram.Mode()
		}
		s.writeJSON(w, http.StatusOK, TelegramStatusResponse{
			BotConfigured: s.telegram != nil,
			Mode:          mode,
			Mappings:      mappings,
		})
	case http.MethodPost:
		var req upsertTelegramMappingRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		id := newID()
		if err := s.store.CreateTelegramMapping(r.Context(), id, req.ChatID, req.Label, req.RoomID); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, map[string]string{"id": id})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminTelegramByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/telegram/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req upsertTelegramMappingRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.UpdateTelegramMapping(r.Context(), id, req.ChatID, req.Label, req.RoomID); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case http.MethodDelete:
		if err := s.store.DeleteTelegramMapping(r.Context(), id); err != nil {
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

func (s *Server) handleAdminTelegramUsers(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		entries, err := s.store.ListTelegramAllowlistEntries(r.Context())
		if err != nil {
			s.internalErr(w, err)
			return
		}
		if entries == nil {
			entries = []TelegramAllowlistEntry{}
		}
		s.writeJSON(w, http.StatusOK, entries)
	case http.MethodPost:
		var req createTelegramAllowlistRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}

		// Get all available roles to pick a default one
		roles, err := s.store.ListRoles(r.Context())
		if err != nil || len(roles) == 0 {
			s.internalErr(w, fmt.Errorf("no roles available for new user"))
			return
		}

		// Use the first available role (usually "producer" or similar)
		defaultRoleID := roles[0].ID

		// Automatically create or upsert the Kesher user with the default role
		_, err = s.store.UpsertUser(r.Context(), req.KesherUsername, defaultRoleID)
		if err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, fmt.Errorf("failed to create kesher user: %w", err))
			return
		}

		// Create the allowlist entry
		id := newID()
		if err := s.store.CreateTelegramAllowlistEntry(r.Context(), id, req.TelegramUsername, req.KesherUsername); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusCreated, map[string]string{"id": id})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminTelegramUserByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/telegram-users/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.store.DeleteTelegramAllowlistEntry(r.Context(), id); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		// If there's an active Telegram session for this user, disconnect it
		// (Implementation note: telegram.go will enforce this on next message)
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminRoutingMatrix(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	switch r.Method {
	case http.MethodPut:
		var entries []RoomPermissionEntry
		if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.BulkUpdateRoomPermissions(r.Context(), entries); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		// Broadcast updated config to all connected clients so they
		// see permission changes immediately without refreshing.
		if roles, err := s.store.ListRoles(r.Context()); err == nil {
			if rooms, err := s.store.ListRooms(r.Context()); err == nil {
				if groups, err := s.store.ListBroadcastGroups(r.Context()); err == nil {
					s.hub.BroadcastConfigUpdate(PublicBootstrapResponse{
						Roles:           roles,
						Rooms:           rooms,
						BroadcastGroups: groups,
						AckEnabled:      s.isAckEnabled(),
						AppVersion:      GetVersionInfo(),
					})
				}
			}
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
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
	c := &client{
		session:         session,
		user:            user,
		closeNow:        conn.Close,
		listenRooms:     toRoomSet(listenRooms),
		talkRooms:       toRoomSet(talkRooms),
		voiceMode:       initialVoiceMode,
		micEnabled:      initialMicEnabled,
		broadcastGroups: make(map[string]struct{}),
		send:            make(chan WSOutbound, 128),
		sendPriority:    make(chan WSOutbound, 128),
	}
	s.hub.Add(c)
	s.hub.SendChatHistorySnapshot(session.Token)
	if err := s.media.EnsurePeer(session.Token, user); err != nil {
		s.logger.Error("failed to initialize media peer", "error", err)
	}
	defer s.hub.Remove(session.Token)
	mediaReady := false
	var connMu sync.Mutex

	go func() {
		write := func(msg WSOutbound) bool {
			connMu.Lock()
			defer connMu.Unlock()
			return conn.WriteJSON(msg) == nil
		}
		for {
			select {
			case msg, ok := <-c.sendPriority:
				if !ok {
					return
				}
				if !write(msg) {
					return
				}
				continue
			default:
			}
			select {
			case msg, ok := <-c.sendPriority:
				if !ok {
					return
				}
				if !write(msg) {
					return
				}
			case msg, ok := <-c.send:
				if !ok {
					return
				}
				if !write(msg) {
					return
				}
			}
		}
	}()

	stopKeepalive := startWebSocketKeepalive(conn, &connMu)
	defer stopKeepalive()

	for {
		var in WSInbound
		if err := conn.ReadJSON(&in); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				s.logger.Warn("websocket closed unexpectedly", "token", session.Token, "error", err)
			}
			_ = conn.Close()
			return
		}
		refreshWebSocketReadDeadline(conn)
		switch in.Type {
		case "webrtc_ready":
			mediaReady = true
			s.media.EnsureNegotiation(session.Token)
			s.media.SyncRouting()
		case "set_room_matrix":
			raw, _ := json.Marshal(in.Data)
			var e RoomMatrixEvent
			_ = json.Unmarshal(raw, &e)
			prevListen := s.hub.ListenRoomsForToken(session.Token)
			allowedListen := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, e.ListenRoomIDs, false)
			allowedListen = s.mergeForcedListenRooms(r.Context(), session.RoleID, allowedListen)
			allowedTalk := s.filterAllowedRoomsForRole(r.Context(), session.RoleID, e.TalkRoomIDs, true)
			s.hub.SetRoomMatrix(session.Token, allowedListen, allowedTalk)
			newlyListened := addedRooms(prevListen, allowedListen)
			if len(newlyListened) > 0 {
				s.hub.SendRoomChatHistory(session.Token, newlyListened)
			}
			if mediaReady {
				s.media.SyncRouting()
			}
		case "chat":
			s.routeInbound(r.Context(), session, in, "chat")
		case "chat_ack":
			if !s.isAckEnabled() {
				continue
			}
			raw, _ := json.Marshal(in.Data)
			var e ChatAckInbound
			_ = json.Unmarshal(raw, &e)
			s.hub.RouteChatAck(session.Token, e)
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
			if e.Scope == "room" && (e.Body == "always_on" || e.Body == "ptt_start") {
				s.media.SetIdleRoomFallbackSuppressed(session.Token, false)
			}
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
	if outType == "chat" {
		resolved, status, ok := s.resolveChatRouting(ctx, sender, e)
		if !ok {
			if status != nil {
				s.sendRoutingStatus(sender.Token, *status)
			}
			return
		}
		e = resolved
		if strings.TrimSpace(e.MessageID) == "" {
			e.MessageID = newID()
		}
		if !s.isAckEnabled() {
			e.AckRequired = false
		}
	}
	if e.Scope == "" || e.TargetID == "" {
		return
	}
	if e.Source == "" {
		e.Source = "web"
	}
	if !s.isInboundAllowed(ctx, sender, e) {
		return
	}
	s.hub.RouteEvent(sender.Token, outType, e)
}

func (s *Server) resolveChatRouting(ctx context.Context, sender Session, e RoutedEvent) (RoutedEvent, *RoutingStatusEvent, bool) {
	body := strings.TrimSpace(e.Body)
	if body == "" {
		return RoutedEvent{}, nil, false
	}

	prefix, targetLabel, messageBody, hasPrefix := parseChatPrefix(body)
	if !hasPrefix {
		talkRoomID, ok := s.hub.ActiveTalkRoomForToken(sender.Token)
		if !ok {
			return RoutedEvent{}, &RoutingStatusEvent{
				Code:       "unzustellbar",
				TargetType: "room",
				Message:    "Unzustellbar: Keine aktive Talk-Partyline.",
			}, false
		}
		e.Scope = "room"
		e.TargetType = "room"
		e.TargetID = talkRoomID
		e.Body = body
		return e, nil, true
	}

	if messageBody == "" {
		return RoutedEvent{}, nil, false
	}

	switch prefix {
	case '#':
		roomID, ok := s.resolveRoomTargetID(ctx, targetLabel)
		if !ok {
			return RoutedEvent{}, &RoutingStatusEvent{
				Code:       "unzustellbar",
				TargetType: "room",
				Target:     targetLabel,
				Message:    "Unzustellbar: Partyline nicht gefunden.",
			}, false
		}
		e.Scope = "room"
		e.TargetType = "room"
		e.TargetID = roomID
		e.Body = messageBody
		return e, nil, true
	case '@':
		if activeUser, ok := s.hub.ActiveUserByUsername(targetLabel); ok {
			if activeUser.ID == sender.UserID {
				return RoutedEvent{}, &RoutingStatusEvent{
					Code:       "unzustellbar",
					TargetType: "user",
					Target:     targetLabel,
					Message:    "Unzustellbar: Du kannst dir selbst keine Nachricht schicken.",
				}, false
			}
			e.Scope = "direct"
			e.TargetType = "user"
			e.TargetID = activeUser.ID
			e.Body = messageBody
			return e, nil, true
		}
		if persistedUser, err := s.store.FindUserByUsername(ctx, targetLabel); err == nil {
			if persistedUser.ID == sender.UserID {
				return RoutedEvent{}, &RoutingStatusEvent{
					Code:       "unzustellbar",
					TargetType: "user",
					Target:     targetLabel,
					Message:    "Unzustellbar: Du kannst dir selbst keine Nachricht schicken.",
				}, false
			}
			e.Scope = "direct"
			e.TargetType = "user"
			e.TargetID = persistedUser.ID
			e.Body = messageBody
			return e, nil, true
		}
		roleID, ok := s.resolveRoleTargetID(ctx, targetLabel)
		if !ok {
			return RoutedEvent{}, &RoutingStatusEvent{
				Code:       "unzustellbar",
				TargetType: "user",
				Target:     targetLabel,
				Message:    "Unzustellbar: Benutzer oder Rolle nicht gefunden.",
			}, false
		}
		if !s.hub.HasActiveSessionsForRole(roleID) {
			return RoutedEvent{}, &RoutingStatusEvent{
				Code:       "unzustellbar",
				TargetType: "role",
				Target:     targetLabel,
				Message:    "Unzustellbar: Keine aktiven Nutzer fuer diese Rolle.",
			}, false
		}
		e.Scope = "direct"
		e.TargetType = "role"
		e.TargetID = roleID
		e.Body = messageBody
		return e, nil, true
	default:
		return RoutedEvent{}, nil, false
	}
}

func parseChatPrefix(body string) (rune, string, string, bool) {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return 0, "", "", false
	}
	if !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "@") {
		return 0, "", "", false
	}
	parts := strings.Fields(trimmed)
	if len(parts) == 0 {
		return 0, "", "", false
	}
	prefixToken := parts[0]
	prefix := rune(prefixToken[0])
	target := strings.TrimSpace(prefixToken[1:])
	message := strings.TrimSpace(strings.TrimPrefix(trimmed, prefixToken))
	if target == "" {
		return 0, "", "", false
	}
	return prefix, target, message, true
}

func addedRooms(previous []string, next []string) []string {
	prevSet := make(map[string]struct{}, len(previous))
	for _, roomID := range previous {
		if roomID == "" {
			continue
		}
		prevSet[roomID] = struct{}{}
	}
	added := make([]string, 0, len(next))
	for _, roomID := range next {
		if roomID == "" {
			continue
		}
		if _, exists := prevSet[roomID]; exists {
			continue
		}
		added = append(added, roomID)
	}
	return added
}

func (s *Server) resolveRoomTargetID(ctx context.Context, target string) (string, bool) {
	rooms, err := s.store.ListRooms(ctx)
	if err != nil {
		return "", false
	}
	for _, room := range rooms {
		if strings.EqualFold(room.ID, target) || strings.EqualFold(room.Name, target) {
			return room.ID, true
		}
	}
	return "", false
}

func (s *Server) resolveRoleTargetID(ctx context.Context, target string) (string, bool) {
	roles, err := s.store.ListRoles(ctx)
	if err != nil {
		return "", false
	}
	for _, role := range roles {
		if strings.EqualFold(role.ID, target) || strings.EqualFold(role.Name, target) {
			return role.ID, true
		}
	}
	return "", false
}

func (s *Server) sendRoutingStatus(token string, status RoutingStatusEvent) {
	status.Timestamp = time.Now().UnixMilli()
	s.hub.SendToToken(token, WSOutbound{Type: "status", Data: status})
}

func (s *Server) isInboundAllowed(ctx context.Context, sender Session, e RoutedEvent) bool {
	switch e.Scope {
	case "room":
		allowed, err := s.store.RoomAllowsSenderRole(ctx, e.TargetID, sender.RoleID)
		return err == nil && allowed
	case "broadcast":
		allowed, err := s.store.BroadcastGroupAllowsRole(ctx, e.TargetID, sender.RoleID)
		if err != nil || !allowed {
			return false
		}
		roomIDs, err := s.store.BroadcastGroupRoomIDs(ctx, e.TargetID)
		if err != nil {
			return false
		}
		for _, roomID := range roomIDs {
			canSend, err := s.store.RoomAllowsSenderRole(ctx, roomID, sender.RoleID)
			if err == nil && canSend {
				return true
			}
		}
		return false
	default:
		return true
	}
}

func (s *Server) staticHandler() http.Handler {
	if s.cfg.StaticDir == "" {
		return s.embeddedStaticHandler()
	}
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
	})
}

func (s *Server) embeddedStaticHandler() http.Handler {
	assets, err := fs.Sub(embeddedStaticFS, "embedded_web")
	if err != nil {
		return http.NotFoundHandler()
	}
	fileServer := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/" {
			http.ServeFileFS(w, r, assets, "index.html")
			return
		}
		requestedPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if info, err := fs.Stat(assets, requestedPath); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFileFS(w, r, assets, "index.html")
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

func newID() string {
	return uuid.NewString()
}
