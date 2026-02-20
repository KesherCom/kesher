package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	cfg      Config
	logger   *slog.Logger
	store    *Store
	sessions *SessionManager
	hub      *Hub
	media    *MediaManager
	httpSrv  *http.Server
	upgrader websocket.Upgrader
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
	mux.HandleFunc("/ws", s.handleWS)
	if cfg.StaticDir != "" {
		mux.Handle("/", s.staticHandler())
	}
	s.httpSrv = &http.Server{
		Addr:              cfg.Addr,
		Handler:           s.withCORS(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s, nil
}

func (s *Server) ListenAndServe() error {
	s.logger.Info("starting server", "addr", s.cfg.Addr, "dbPath", s.cfg.DBPath)
	err := s.httpSrv.ListenAndServe()
	if !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	_ = s.store.Close()
	return s.httpSrv.Shutdown(ctx)
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
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
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
	var user User
	for _, u := range users {
		if u.ID == session.UserID {
			user = u
			break
		}
	}
	c := &client{
		session:    session,
		user:       user,
		activeRoom: "foh",
		voiceMode:  "always_on",
		micEnabled: true,
		send:       make(chan WSOutbound, 32),
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
			s.media.SwitchRoom(session.Token, currentRoom)
		case "set_active_room":
			raw, _ := json.Marshal(in.Data)
			var e ActiveRoomEvent
			_ = json.Unmarshal(raw, &e)
			s.hub.SetActiveRoom(session.Token, e.RoomID)
			currentRoom = e.RoomID
			if mediaReady {
				s.media.SwitchRoom(session.Token, e.RoomID)
			}
		case "chat":
			s.routeInbound(session.Token, in, "chat")
		case "signal":
			s.routeInbound(session.Token, in, "signal")
		case "voice_state":
			raw, _ := json.Marshal(in.Data)
			var e RoutedEvent
			_ = json.Unmarshal(raw, &e)
			s.hub.SetVoiceState(session.Token, e.Body)
			s.routeInbound(session.Token, in, "voice_state")
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

func (s *Server) routeInbound(senderToken string, in WSInbound, outType string) {
	raw, _ := json.Marshal(in.Data)
	var e RoutedEvent
	if err := json.Unmarshal(raw, &e); err != nil {
		return
	}
	if e.Scope == "" || e.TargetID == "" {
		return
	}
	s.hub.RouteEvent(senderToken, outType, e)
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
		fileServer.ServeHTTP(w, r)
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
