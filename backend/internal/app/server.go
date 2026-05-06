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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type AckSettings struct {
	Enabled bool `json:"enabled"`
}

var errCompanionUserNotAllowed = errors.New("companion target user is not allowed")

type Server struct {
	cfg                              Config
	logger                           *slog.Logger
	adminLogs                        *adminLogStore
	store                            *Store
	sessions                         *SessionManager
	sessionMu                        sync.Mutex
	hub                              *Hub
	media                            *MediaManager
	telegram                         *TelegramBot
	certMagic                        tlsProvider
	httpSrv                          *http.Server
	redirectSrv                      *http.Server
	upgrader                         websocket.Upgrader
	ackMu                            sync.RWMutex
	ackEnabled                       bool
	ackSet                           bool
	companionMu                      sync.RWMutex
	companionWS                      map[string]map[chan CompanionCommandResult]struct{}
	companionState                   map[string]map[chan struct{}]struct{}
	companionPageByRole              map[string]int
	companionPageButtonDown          map[string]bool
	companionPageNavAnchorByRole     map[string]int
	companionHeldTargets             map[string]string
	companionPendingCallByUser       map[string]bool
	companionPendingCallerByUser     map[string]string
	companionPendingCallScopeByUser  map[string]string
	companionPendingCallSourceByUser map[string]string
	companionAckedSignalByUser       map[string]string
	companionSelectListenHoldDelay   time.Duration
	imageStreamCoord                 *ImageStreamCoordinator
	companionImageEffectMapMu        sync.Mutex
	companionImageEffectMapCached    string
	companionImageEffectMapModTime   time.Time
	companionImageEffectMapChecked   time.Time
	companionImageEffectMapErr       string
	udpAudio                         *UDPAudioRelay
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
	websocketPingInterval                 = 30 * time.Second
	websocketReadTimeout                  = 60 * time.Second
	websocketPingWriteWindow              = 5 * time.Second
	companionSelectListenHoldDelayDefault = 2 * time.Second
	companionIncomingCallBlinkInterval    = 300 * time.Millisecond
	companionIncomingCallEffectValue      = 3
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

func (s *Server) loadCompanionImageEffectMapJSON() string {
	path := strings.TrimSpace(s.cfg.CompanionImageEffectMapFile)
	if path == "" {
		return ""
	}

	now := time.Now()
	s.companionImageEffectMapMu.Lock()
	defer s.companionImageEffectMapMu.Unlock()

	if now.Sub(s.companionImageEffectMapChecked) < time.Second {
		return s.companionImageEffectMapCached
	}
	s.companionImageEffectMapChecked = now

	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			s.companionImageEffectMapCached = ""
			s.companionImageEffectMapModTime = time.Time{}
			s.companionImageEffectMapErr = ""
			return ""
		}
		errMsg := err.Error()
		if errMsg != s.companionImageEffectMapErr {
			s.logger.Warn("failed to stat companion image effect map", "path", path, "error", err)
			s.companionImageEffectMapErr = errMsg
		}
		return s.companionImageEffectMapCached
	}

	if !info.ModTime().After(s.companionImageEffectMapModTime) {
		return s.companionImageEffectMapCached
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		errMsg := err.Error()
		if errMsg != s.companionImageEffectMapErr {
			s.logger.Warn("failed to read companion image effect map", "path", path, "error", err)
			s.companionImageEffectMapErr = errMsg
		}
		return s.companionImageEffectMapCached
	}

	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		s.companionImageEffectMapCached = ""
		s.companionImageEffectMapModTime = info.ModTime()
		s.companionImageEffectMapErr = ""
		return ""
	}
	if !json.Valid([]byte(trimmed)) {
		errMsg := "invalid JSON"
		if errMsg != s.companionImageEffectMapErr {
			s.logger.Warn("invalid companion image effect map JSON", "path", path)
			s.companionImageEffectMapErr = errMsg
		}
		return s.companionImageEffectMapCached
	}

	s.companionImageEffectMapCached = trimmed
	s.companionImageEffectMapModTime = info.ModTime()
	s.companionImageEffectMapErr = ""
	return s.companionImageEffectMapCached
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
	if !s.requireCompanionSecret(w, r) {
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("username")) != "" {
		http.Error(w, "username query parameter is no longer supported; use roleId", http.StatusBadRequest)
		return
	}
	roleID := strings.TrimSpace(r.URL.Query().Get("roleId"))
	if roleID == "" {
		autoRoleID, err := s.store.ResolveSinglePublishedCompanionRole(r.Context())
		if err != nil {
			if errors.Is(err, ErrConflict) {
				http.Error(w, "multiple published profiles found; provide roleId", http.StatusConflict)
				return
			}
			http.Error(w, "roleId required unless exactly one profile is published", http.StatusBadRequest)
			return
		}
		roleID = autoRoleID
	}
	if roleID != "" {
		knownRole, err := s.store.RoleExists(r.Context(), roleID)
		if err != nil {
			s.internalErr(w, err)
			return
		}
		if !knownRole {
			http.Error(w, "unknown roleId", http.StatusNotFound)
			return
		}
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("companion websocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()
	resolveUsername := func() string {
		if roleID == "" {
			return ""
		}
		session, ok := s.sessions.LatestForRole(roleID)
		if !ok {
			return ""
		}
		return strings.TrimSpace(session.Username)
	}
	presenceCh, unsubscribe := s.hub.SubscribePresence()
	defer unsubscribe()
	resultKey := roleID
	resultCh, unsubscribeResults := s.subscribeCompanionResults(resultKey)
	defer unsubscribeResults()
	stateCh, unsubscribeState := s.subscribeCompanionState(resultKey)
	defer unsubscribeState()
	var connMu sync.Mutex
	writeJSON := func(msg WSOutbound) {
		connMu.Lock()
		defer connMu.Unlock()
		_ = conn.WriteJSON(msg)
	}
	writeCommandResult := func(result CompanionCommandResult) {
		if result.Timestamp == 0 {
			result.Timestamp = time.Now().UnixMilli()
		}
		if strings.TrimSpace(result.Source) == "" {
			result.Source = "bridge"
		}
		writeJSON(WSOutbound{Type: "companion_command_result", Data: result})
	}

	writeState := func() {
		resolvedUsername := resolveUsername()
		state := CompanionBridgeState{
			Username: resolvedUsername,
			Bound:    false,
		}
		state.ImageEffectMapJSON = s.loadCompanionImageEffectMapJSON()
		profileRoleID := strings.TrimSpace(roleID)
		if profileRoleID != "" {
			state.CurrentPageNumber = s.currentCompanionPage(r.Context(), profileRoleID)
			if profile, err := s.store.GetCompanionProfileByRole(r.Context(), profileRoleID); err == nil {
				state.ProfileVersion = profile.ProfileVersion
				state.ProfileStatus = profile.ProfileStatus
				state.ProfileUpdatedAt = profile.ProfileUpdatedAt
			} else if errors.Is(err, ErrNotFound) {
				state.ProfileStatus = "unpublished"
			}
		}
		if resolvedUsername != "" {
			if presence, ok := s.hub.PresenceForUsername(resolvedUsername); ok {
				state.Bound = true
				state.Presence = &presence
				state.SessionCount = s.hub.SessionCountForUsername(resolvedUsername)
				state.MultiSessionWarning = state.SessionCount > 1
			}
			if replyUserID, replyUsername, ok := s.hub.ReplyTargetForUsername(resolvedUsername); ok {
				state.ReplyDirectUserID = replyUserID
				state.ReplyDirectUsername = replyUsername
			}
			if signalFrom, signalMessage, signalScope, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(resolvedUsername); signalActive {
				s.setCompanionPendingIncomingCall(resolvedUsername, true)
				s.setCompanionPendingIncomingCaller(resolvedUsername, signalFrom)
				s.setCompanionPendingIncomingCallScope(resolvedUsername, signalScope)
				s.setCompanionPendingIncomingCallSource(resolvedUsername, signalSourceType, signalSourceID)
				state.SignalActive = true
				state.SignalFrom = signalFrom
				state.SignalMessage = signalMessage
			} else if s.hasCompanionPendingIncomingCall(resolvedUsername) {
				state.SignalActive = true
				if caller, ok := s.companionPendingIncomingCaller(resolvedUsername); ok {
					state.SignalFrom = caller
				}
			}
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
	blinkTicker := time.NewTicker(companionIncomingCallBlinkInterval)
	defer blinkTicker.Stop()
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
				// Refresh button images when presence changes (e.g. listen state from browser)
				resolvedRoleID := strings.TrimSpace(roleID)
				if resolvedRoleID != "" {
					s.emitCompanionCurrentPageImages(r.Context(), resolvedRoleID, resolveUsername())
				}
			case result, ok := <-resultCh:
				if !ok {
					return
				}
				writeCommandResult(result)
			case _, ok := <-stateCh:
				if !ok {
					return
				}
				writeState()
				resolvedRoleID := strings.TrimSpace(roleID)
				if resolvedRoleID != "" {
					s.emitCompanionCurrentPageImages(r.Context(), resolvedRoleID, resolveUsername())
				}
			case <-blinkTicker.C:
				resolvedRoleID := strings.TrimSpace(roleID)
				if resolvedRoleID == "" {
					continue
				}
				resolvedUsername := strings.TrimSpace(resolveUsername())
				if resolvedUsername == "" {
					continue
				}
				if signalFrom, _, signalScope, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(resolvedUsername); signalActive {
					s.setCompanionPendingIncomingCall(resolvedUsername, true)
					s.setCompanionPendingIncomingCaller(resolvedUsername, signalFrom)
					s.setCompanionPendingIncomingCallScope(resolvedUsername, signalScope)
					s.setCompanionPendingIncomingCallSource(resolvedUsername, signalSourceType, signalSourceID)
				}
				if !s.hasCompanionPendingIncomingCall(resolvedUsername) {
					continue
				}
				s.emitCompanionCurrentPageImages(r.Context(), resolvedRoleID, resolvedUsername)
			}
		}
	}()

	for {
		var in companionInbound
		if err := conn.ReadJSON(&in); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				targetLabel := "roleId=" + roleID
				s.logger.Warn("companion websocket closed unexpectedly", "target", targetLabel, "error", err)
			}
			return
		}
		refreshWebSocketReadDeadline(conn)
		if in.Type != "command" {
			continue
		}
		commandID := strings.TrimSpace(in.Data.CommandID)
		writeRejected := func(errMsg string) {
			writeCommandResult(CompanionCommandResult{
				CommandID: commandID,
				Command:   in.Data.Command,
				OK:        false,
				Status:    "failed",
				Error:     errMsg,
				Source:    "bridge",
			})
		}
		if in.Data.Command == "" {
			writeRejected("missing command")
			continue
		}
		if in.Data.Command == "press_button" && s.logger != nil {
			s.logger.Info("companion ws press_button raw",
				"roleId", strings.TrimSpace(roleID),
				"commandId", commandID,
				"buttonIndex", in.Data.ButtonIndex,
				"state", strings.TrimSpace(in.Data.State),
				"pageNumber", in.Data.PageNumber,
			)
		}
		resolvedRoleID := strings.TrimSpace(roleID)
		if in.Data.Command == "press_button" {
			if resolvedRoleID == "" {
				writeRejected("target role unavailable")
				continue
			}
			result := s.executeCompanionButtonPress(r.Context(), resolvedRoleID, resolveUsername(), in.Data)
			writeCommandResult(result)
			continue
		}
		if pageResult, handled := s.executeCompanionPageCommand(r.Context(), resolvedRoleID, resolveUsername(), in.Data); handled {
			if pageResult.Timestamp == 0 {
				pageResult.Timestamp = time.Now().UnixMilli()
			}
			if strings.TrimSpace(pageResult.Source) == "" {
				pageResult.Source = "bridge"
			}
			if strings.TrimSpace(pageResult.CommandID) == "" {
				pageResult.CommandID = commandID
			}
			if strings.TrimSpace(pageResult.Command) == "" {
				pageResult.Command = in.Data.Command
			}
			writeCommandResult(pageResult)
			continue
		}
		resolvedUsername := resolveUsername()
		if resolvedUsername == "" {
			writeRejected("target unavailable")
			continue
		}
		token, ok := s.hub.LatestTokenForUsername(resolvedUsername)
		if !ok {
			writeRejected("target unavailable")
			continue
		}
		if in.Data.Command == "set_voice_mode" && in.Data.Mode == "" {
			writeRejected("missing mode")
			continue
		}
		if in.Data.Command == "toggle_listen_room" {
			roomID := strings.TrimSpace(in.Data.TargetID)
			if roomID == "" {
				writeRejected("missing targetId")
				continue
			}
			allowedListen, err := s.store.RoomAllowsReceiverRole(r.Context(), roomID, resolvedRoleID)
			if err != nil {
				writeRejected(err.Error())
				continue
			}
			if !allowedListen {
				writeRejected("not allowed to listen to room")
				continue
			}
			presence, ok := s.hub.PresenceForUsername(resolvedUsername)
			if !ok {
				writeRejected("target unavailable")
				continue
			}
			stateKey := fmt.Sprintf("listen-bridge:%s:%s", resolvedUsername, roomID)
			listening := false
			for _, entry := range presence.ListenRooms {
				if entry == roomID {
					listening = true
					break
				}
			}
			s.companionMu.RLock()
			if expected, ok := s.companionHeldTargets[stateKey]; ok {
				if expected == "on" {
					listening = true
				} else if expected == "off" {
					listening = false
				}
			}
			s.companionMu.RUnlock()
			nextListening := !listening
			s.companionMu.Lock()
			if nextListening {
				s.companionHeldTargets[stateKey] = "on"
			} else {
				s.companionHeldTargets[stateKey] = "off"
			}
			s.companionMu.Unlock()

			nextListen := make([]string, 0, len(presence.ListenRooms)+1)
			for _, entry := range presence.ListenRooms {
				if entry != roomID {
					nextListen = append(nextListen, entry)
				}
			}
			if nextListening {
				nextListen = append(nextListen, roomID)
			}
			sent := s.hub.SendToToken(token, WSOutbound{
				Type: "companion_command",
				Data: CompanionCommand{
					Command:       "set_room_matrix",
					ListenRoomIDs: nextListen,
					TalkRoomIDs:   append([]string(nil), presence.TalkRooms...),
				},
			})
			if !sent {
				writeRejected("failed to deliver command")
				continue
			}
			writeCommandResult(CompanionCommandResult{
				CommandID: commandID,
				Command:   in.Data.Command,
				OK:        true,
				Status:    "queued",
				Source:    "bridge",
			})
			continue
		}
		if in.Data.Command == "connection_diagnostics" || in.Data.Command == "connection_diagnostics_reconnect" || in.Data.Command == "connection_roundtrip_check" || in.Data.Command == "image_slot_diagnostics" {
			writeCommandResult(CompanionCommandResult{
				CommandID: commandID,
				Command:   in.Data.Command,
				OK:        true,
				Status:    "executed",
				Source:    "bridge",
			})
			continue
		}
		normalized, err := s.normalizeCompanionRelayCommand(r.Context(), resolvedRoleID, resolvedUsername, in.Data)
		if err != nil {
			writeCommandResult(CompanionCommandResult{
				CommandID: commandID,
				Command:   in.Data.Command,
				OK:        false,
				Status:    "rejected",
				Error:     err.Error(),
				Source:    "bridge",
			})
			continue
		}
		normalized.CommandID = in.Data.CommandID
		sent := s.hub.SendToToken(token, WSOutbound{
			Type: "companion_command",
			Data: normalized,
		})
		if !sent {
			writeRejected("failed to deliver command")
			continue
		}
		writeCommandResult(CompanionCommandResult{
			CommandID: commandID,
			Command:   in.Data.Command,
			OK:        true,
			Status:    "queued",
			Source:    "bridge",
		})
	}
}

func companionPageOrder(settings StreamDeckSettings) []int {
	seen := make(map[int]struct{}, len(settings.Pages))
	ordered := make([]int, 0, len(settings.Pages))
	for _, entry := range settings.Pages {
		if _, ok := seen[entry.Page]; ok {
			continue
		}
		seen[entry.Page] = struct{}{}
		ordered = append(ordered, entry.Page)
	}
	if len(ordered) == 0 {
		ordered = append(ordered, settings.SelectedPage)
	}
	sort.Ints(ordered)
	return ordered
}

func companionPageByNumber(settings StreamDeckSettings) map[int]StreamDeckPageConfig {
	pageByNumber := make(map[int]StreamDeckPageConfig, len(settings.Pages))
	for _, page := range settings.Pages {
		pageByNumber[page.Page] = page
	}
	return pageByNumber
}

func companionRootPageOrder(settings StreamDeckSettings) []int {
	ordered := make([]int, 0, len(settings.Pages))
	for _, page := range settings.Pages {
		if page.ParentPage == nil {
			ordered = append(ordered, page.Page)
		}
	}
	if len(ordered) == 0 {
		return companionPageOrder(settings)
	}
	sort.Ints(ordered)
	return ordered
}

func companionHomePage(settings StreamDeckSettings, dynamic bool) int {
	if dynamic {
		return 0
	}
	order := companionRootPageOrder(settings)
	if len(order) > 0 {
		return order[0]
	}
	return 0
}

type companionRuntimePage struct {
	Page       StreamDeckPageConfig
	Dynamic    bool
	TotalPages int
}

type companionPageEntry struct {
	label  string
	button StreamDeckButtonConfig
}

func companionSettingsHasExplicitDataActions(settings StreamDeckSettings) bool {
	for _, page := range settings.Pages {
		for _, button := range page.Buttons {
			if button.Action == nil {
				continue
			}
			switch button.Action.Type {
			case StreamDeckActionTypeNone, StreamDeckActionTypePageUp, StreamDeckActionTypePageDown,
				StreamDeckActionTypePageJump, StreamDeckActionTypePageHome, StreamDeckActionTypePageBack:
				continue
			default:
				return true
			}
		}
	}
	return false
}

func companionCloneButtons(buttons []StreamDeckButtonConfig) []StreamDeckButtonConfig {
	cloned := make([]StreamDeckButtonConfig, 0, len(buttons))
	for _, button := range buttons {
		next := button
		if button.Action != nil {
			action := *button.Action
			next.Action = &action
		}
		cloned = append(cloned, next)
	}
	return cloned
}

func companionBuildEmptyButtons(settings StreamDeckSettings) []StreamDeckButtonConfig {
	buttonCount := companionGridButtonCount(settings)
	buttons := make([]StreamDeckButtonConfig, 0, buttonCount)
	for index := 0; index < buttonCount; index++ {
		buttons = append(buttons, StreamDeckButtonConfig{Index: index})
	}
	return buttons
}

func companionRenderManualPage(settings StreamDeckSettings, page StreamDeckPageConfig) StreamDeckPageConfig {
	buttons := companionCloneButtons(page.Buttons)
	if len(buttons) == 0 {
		buttons = companionBuildEmptyButtons(settings)
	}
	if page.ParentPage != nil && len(buttons) > 0 {
		buttons[0] = StreamDeckButtonConfig{
			Index: 0,
			Label: "Back",
			Action: &StreamDeckButtonAction{
				Type: StreamDeckActionTypePageBack,
			},
		}
	}
	page.Buttons = buttons
	return page
}

func (s *Server) companionAutoRoleEntries(ctx context.Context, roleID string) []companionPageEntry {
	roles, err := s.store.ListRoles(ctx)
	if err != nil {
		return nil
	}
	entries := make([]companionPageEntry, 0, len(roles))
	for _, role := range roles {
		allowed, err := s.companionRoleCanDirectToRole(ctx, roleID, role.ID)
		if err != nil || !allowed {
			continue
		}
		entries = append(entries, companionPageEntry{
			label: strings.TrimSpace(role.Name),
			button: StreamDeckButtonConfig{
				Label:  strings.TrimSpace(role.Name),
				Action: &StreamDeckButtonAction{Type: StreamDeckActionTypeDirectRole, RoleID: strings.TrimSpace(role.ID)},
			},
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		left := strings.ToLower(entries[i].label)
		right := strings.ToLower(entries[j].label)
		if left == right {
			return entries[i].button.Action.RoleID < entries[j].button.Action.RoleID
		}
		return left < right
	})
	return entries
}

func (s *Server) companionAutoPartyLineEntries(ctx context.Context, roleID string) []companionPageEntry {
	rooms, err := s.store.ListRooms(ctx)
	if err != nil {
		return nil
	}
	entries := make([]companionPageEntry, 0, len(rooms))
	for _, room := range rooms {
		canTalk, err := s.store.RoomAllowsSenderRole(ctx, room.ID, roleID)
		if err != nil {
			continue
		}
		canListen, err := s.store.RoomAllowsReceiverRole(ctx, room.ID, roleID)
		if err != nil {
			continue
		}
		if !canTalk && !canListen {
			continue
		}
		actionType := StreamDeckActionTypeListenRoom
		if canTalk {
			actionType = StreamDeckActionTypePTTRoom
		}
		entries = append(entries, companionPageEntry{
			label: strings.TrimSpace(room.Name),
			button: StreamDeckButtonConfig{
				Label:  strings.TrimSpace(room.Name),
				Action: &StreamDeckButtonAction{Type: actionType, RoomID: strings.TrimSpace(room.ID)},
			},
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		left := strings.ToLower(entries[i].label)
		right := strings.ToLower(entries[j].label)
		if left == right {
			return entries[i].button.Action.RoomID < entries[j].button.Action.RoomID
		}
		return left < right
	})
	return entries
}

func companionAutoEntriesForPage(ctx context.Context, s *Server, roleID string, page StreamDeckPageConfig) []companionPageEntry {
	switch page.PageType {
	case StreamDeckPageTypeAllRoles:
		return s.companionAutoRoleEntries(ctx, roleID)
	case StreamDeckPageTypeAllPartyLines:
		return s.companionAutoPartyLineEntries(ctx, roleID)
	default:
		return nil
	}
}

func companionRenderAutoPage(settings StreamDeckSettings, page StreamDeckPageConfig, entries []companionPageEntry, pageIndex int) companionRuntimePage {
	buttonCount := companionGridButtonCount(settings)
	buttons := companionBuildEmptyButtons(settings)
	hasParent := page.ParentPage != nil
	startSlot := 0
	if hasParent {
		buttons[0] = StreamDeckButtonConfig{Index: 0, Label: "Back", Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageBack}}
		startSlot = 1
	}
	navSlots := 0
	if len(entries) > 0 {
		navSlots = 2
	}
	payloadSlots := buttonCount - startSlot - navSlots
	if payloadSlots <= 0 {
		payloadSlots = buttonCount - startSlot
	}
	totalPages := 1
	if payloadSlots > 0 && len(entries) > 0 {
		totalPages = (len(entries) + payloadSlots - 1) / payloadSlots
	}
	if totalPages <= 0 {
		totalPages = 1
	}
	if pageIndex < 0 {
		pageIndex = 0
	}
	if pageIndex >= totalPages {
		pageIndex = totalPages - 1
	}
	if payloadSlots > 0 {
		start := pageIndex * payloadSlots
		end := start + payloadSlots
		if end > len(entries) {
			end = len(entries)
		}
		slot := startSlot
		for itemIndex := start; itemIndex < end && slot < buttonCount; itemIndex++ {
			mapped := entries[itemIndex].button
			mapped.Index = slot
			buttons[slot] = mapped
			slot++
		}
	}
	if len(entries) > payloadSlots && buttonCount >= 2 {
		prevSlot := buttonCount - 2
		nextSlot := buttonCount - 1
		if pageIndex > 0 {
			buttons[prevSlot] = StreamDeckButtonConfig{Index: prevSlot, Label: "Page -", Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown}}
		}
		if pageIndex < totalPages-1 {
			buttons[nextSlot] = StreamDeckButtonConfig{Index: nextSlot, Label: "Page +", Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}}
		}
	}
	page.Buttons = buttons
	return companionRuntimePage{Page: page, Dynamic: totalPages > 1, TotalPages: totalPages}
}

func (s *Server) companionResolvedSettings(ctx context.Context, roleID string, settings StreamDeckSettings) StreamDeckSettings {
	if len(settings.Pages) == 0 {
		return settings
	}
	maxPage := 0
	for _, page := range settings.Pages {
		if page.Page > maxPage {
			maxPage = page.Page
		}
	}
	nextGeneratedPage := maxPage + 1
	expanded := StreamDeckSettings{
		Version:      settings.Version,
		GridColumns:  settings.GridColumns,
		GridRows:     settings.GridRows,
		SelectedPage: settings.SelectedPage,
		Pages:        make([]StreamDeckPageConfig, 0, len(settings.Pages)),
	}
	for _, rawPage := range settings.Pages {
		switch rawPage.PageType {
		case StreamDeckPageTypeAllRoles, StreamDeckPageTypeAllPartyLines:
			entries := companionAutoEntriesForPage(ctx, s, roleID, rawPage)
			buttonCount := companionGridButtonCount(settings)
			startSlot := 0
			if rawPage.ParentPage != nil {
				startSlot = 1
			}
			payloadSlots := buttonCount - startSlot - 2
			if payloadSlots <= 0 {
				payloadSlots = buttonCount - startSlot
			}
			if payloadSlots <= 0 {
				payloadSlots = 1
			}
			totalPages := 1
			if len(entries) > 0 {
				totalPages = (len(entries) + payloadSlots - 1) / payloadSlots
				if totalPages <= 0 {
					totalPages = 1
				}
			}
			generatedPageNumbers := make([]int, totalPages)
			generatedPageNumbers[0] = rawPage.Page
			for i := 1; i < totalPages; i++ {
				generatedPageNumbers[i] = nextGeneratedPage
				nextGeneratedPage++
			}
			for index := 0; index < totalPages; index++ {
				buttons := companionBuildEmptyButtons(settings)
				slot := startSlot
				start := index * payloadSlots
				end := start + payloadSlots
				if end > len(entries) {
					end = len(entries)
				}
				for itemIndex := start; itemIndex < end && slot < buttonCount; itemIndex++ {
					button := entries[itemIndex].button
					button.Index = slot
					buttons[slot] = button
					slot++
				}
				if rawPage.ParentPage != nil {
					buttons[0] = StreamDeckButtonConfig{Index: 0, Label: "Back", Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageBack}}
				}
				if totalPages > 1 && buttonCount >= 2 {
					prevSlot := buttonCount - 2
					nextSlot := buttonCount - 1
					if index > 0 {
						buttons[prevSlot] = StreamDeckButtonConfig{Index: prevSlot, Label: "Page -", Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageJump, TargetPage: generatedPageNumbers[index-1]}}
					}
					if index < totalPages-1 {
						buttons[nextSlot] = StreamDeckButtonConfig{Index: nextSlot, Label: "Page +", Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageJump, TargetPage: generatedPageNumbers[index+1]}}
					}
				}
				title := rawPage.Title
				if strings.TrimSpace(title) == "" {
					switch rawPage.PageType {
					case StreamDeckPageTypeAllRoles:
						title = "All roles"
					case StreamDeckPageTypeAllPartyLines:
						title = "All party-lines"
					}
				}
				if totalPages > 1 {
					title = strings.TrimSpace(title)
					if title == "" {
						title = "Folder"
					}
					title = fmt.Sprintf("%s %d/%d", title, index+1, totalPages)
				}
				expanded.Pages = append(expanded.Pages, StreamDeckPageConfig{
					Page:       generatedPageNumbers[index],
					Title:      title,
					PageType:   StreamDeckPageTypeManual,
					ParentPage: rawPage.ParentPage,
					Buttons:    buttons,
				})
			}
		default:
			expanded.Pages = append(expanded.Pages, companionRenderManualPage(settings, rawPage))
		}
	}
	if expanded.SelectedPage < 0 {
		expanded.SelectedPage = companionHomePage(expanded, false)
	}
	return expanded
}

func (s *Server) buildCompanionChannelRuntimePage(ctx context.Context, roleID string, settings StreamDeckSettings, cursor int) (companionRuntimePage, bool) {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" || s.store == nil {
		return companionRuntimePage{}, false
	}
	rooms, err := s.store.ListRooms(ctx)
	if err != nil {
		return companionRuntimePage{}, false
	}

	type runtimeChannel struct {
		name   string
		id     string
		action StreamDeckActionType
	}
	channels := make([]runtimeChannel, 0, len(rooms))
	for _, room := range rooms {
		canTalk, err := s.store.RoomAllowsSenderRole(ctx, room.ID, roleID)
		if err != nil {
			continue
		}
		canListen, err := s.store.RoomAllowsReceiverRole(ctx, room.ID, roleID)
		if err != nil {
			continue
		}
		if !canTalk && !canListen {
			continue
		}
		action := StreamDeckActionTypeListenRoom
		if canTalk {
			action = StreamDeckActionTypePTTRoom
		}
		channels = append(channels, runtimeChannel{
			name:   strings.TrimSpace(room.Name),
			id:     strings.TrimSpace(room.ID),
			action: action,
		})
	}
	if len(channels) == 0 {
		return companionRuntimePage{}, false
	}

	sort.SliceStable(channels, func(i, j int) bool {
		leftName := strings.ToLower(channels[i].name)
		rightName := strings.ToLower(channels[j].name)
		if leftName == rightName {
			return channels[i].id < channels[j].id
		}
		return leftName < rightName
	})

	buttonCount := companionGridButtonCount(settings)
	if buttonCount < 3 {
		return companionRuntimePage{}, false
	}
	payloadSlots := buttonCount - 2
	if payloadSlots <= 0 {
		return companionRuntimePage{}, false
	}
	totalPages := (len(channels) + payloadSlots - 1) / payloadSlots
	if totalPages <= 0 {
		totalPages = 1
	}
	if cursor < 0 {
		cursor = 0
	}
	if cursor >= totalPages {
		cursor = totalPages - 1
	}

	start := cursor * payloadSlots
	end := start + payloadSlots
	if end > len(channels) {
		end = len(channels)
	}

	buttons := make([]StreamDeckButtonConfig, 0, buttonCount)
	for i := 0; i < buttonCount; i++ {
		buttons = append(buttons, StreamDeckButtonConfig{Index: i})
	}
	for slot := 0; slot < payloadSlots && (start+slot) < end; slot++ {
		channel := channels[start+slot]
		buttons[slot] = StreamDeckButtonConfig{
			Index: slot,
			Label: channel.name,
			Action: &StreamDeckButtonAction{
				Type:   channel.action,
				RoomID: channel.id,
			},
		}
	}

	prevSlot := buttonCount - 2
	nextSlot := buttonCount - 1
	if cursor > 0 {
		buttons[prevSlot] = StreamDeckButtonConfig{
			Index:  prevSlot,
			Label:  "Page -",
			Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown},
		}
	}
	if cursor < totalPages-1 {
		buttons[nextSlot] = StreamDeckButtonConfig{
			Index:  nextSlot,
			Label:  "Page +",
			Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp},
		}
	}

	return companionRuntimePage{
		Page:       StreamDeckPageConfig{Page: cursor, Buttons: buttons},
		Dynamic:    true,
		TotalPages: totalPages,
	}, true
}

func (s *Server) resolveCompanionRuntimePage(ctx context.Context, roleID string, settings StreamDeckSettings, currentPage int) companionRuntimePage {
	if page, ok := companionPageByNumber(settings)[currentPage]; ok {
		if page.PageType == StreamDeckPageTypeAllRoles || page.PageType == StreamDeckPageTypeAllPartyLines {
			entries := companionAutoEntriesForPage(ctx, s, roleID, page)
			return companionRenderAutoPage(settings, page, entries, 0)
		}
	}
	if !s.cfg.CompanionDynamicPaging {
		return companionResolveStaticRuntimePage(settings, currentPage)
	}
	if companionSettingsHasExplicitDataActions(settings) {
		return companionResolveRuntimePage(settings, currentPage)
	}
	if runtime, ok := s.buildCompanionChannelRuntimePage(ctx, roleID, settings, currentPage); ok {
		return runtime
	}
	return companionResolveRuntimePage(settings, currentPage)
}

func companionGridButtonCount(settings StreamDeckSettings) int {
	count := settings.GridColumns * settings.GridRows
	if count <= 0 {
		return StreamDeckButtonCount
	}
	return count
}

func companionCollectSlidingDataButtons(settings StreamDeckSettings) []StreamDeckButtonConfig {
	if len(settings.Pages) == 0 {
		return nil
	}
	order := companionPageOrder(settings)
	if len(order) == 0 {
		return nil
	}
	pageByNumber := make(map[int]StreamDeckPageConfig, len(settings.Pages))
	for _, page := range settings.Pages {
		pageByNumber[page.Page] = page
	}
	data := make([]StreamDeckButtonConfig, 0)
	for _, pageNo := range order {
		page, ok := pageByNumber[pageNo]
		if !ok {
			continue
		}
		orderedButtons := append([]StreamDeckButtonConfig(nil), page.Buttons...)
		sort.Slice(orderedButtons, func(i, j int) bool {
			return orderedButtons[i].Index < orderedButtons[j].Index
		})
		for _, button := range orderedButtons {
			if button.Action == nil {
				continue
			}
			switch button.Action.Type {
			case StreamDeckActionTypeNone, StreamDeckActionTypePageUp, StreamDeckActionTypePageDown,
				StreamDeckActionTypePageJump, StreamDeckActionTypePageHome:
				continue
			default:
				data = append(data, button)
			}
		}
	}
	return data
}

func companionBuildSlidingRuntimePage(settings StreamDeckSettings, cursor int) (companionRuntimePage, bool) {
	buttonCount := companionGridButtonCount(settings)
	if buttonCount < 3 {
		return companionRuntimePage{}, false
	}
	dataButtons := companionCollectSlidingDataButtons(settings)
	if len(dataButtons) == 0 {
		return companionRuntimePage{}, false
	}
	payloadSlots := buttonCount - 2
	if payloadSlots <= 0 {
		return companionRuntimePage{}, false
	}
	totalPages := (len(dataButtons) + payloadSlots - 1) / payloadSlots
	if totalPages <= 0 {
		totalPages = 1
	}
	if cursor < 0 {
		cursor = 0
	}
	if cursor >= totalPages {
		cursor = totalPages - 1
	}
	start := cursor * payloadSlots
	end := start + payloadSlots
	if end > len(dataButtons) {
		end = len(dataButtons)
	}

	buttons := make([]StreamDeckButtonConfig, 0, buttonCount)
	for i := 0; i < buttonCount; i++ {
		buttons = append(buttons, StreamDeckButtonConfig{Index: i})
	}

	for slot := 0; slot < payloadSlots && (start+slot) < end; slot++ {
		mapped := dataButtons[start+slot]
		mapped.Index = slot
		buttons[slot] = mapped
	}

	prevSlot := buttonCount - 2
	nextSlot := buttonCount - 1
	if cursor > 0 {
		buttons[prevSlot] = StreamDeckButtonConfig{
			Index:  prevSlot,
			Label:  "Page -",
			Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown},
		}
	}
	if cursor < totalPages-1 {
		buttons[nextSlot] = StreamDeckButtonConfig{
			Index:  nextSlot,
			Label:  "Page +",
			Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp},
		}
	}

	return companionRuntimePage{
		Page: StreamDeckPageConfig{
			Page:    cursor,
			Buttons: buttons,
		},
		Dynamic:    true,
		TotalPages: totalPages,
	}, true
}

func companionResolveStaticRuntimePage(settings StreamDeckSettings, currentPage int) companionRuntimePage {
	page := companionRenderManualPage(settings, companionResolvePageConfig(settings, currentPage))
	order := companionPageOrder(settings)
	totalPages := len(order)
	if totalPages <= 0 {
		totalPages = 1
	}
	return companionRuntimePage{Page: page, Dynamic: false, TotalPages: totalPages}
}

func companionResolveRuntimePage(settings StreamDeckSettings, currentPage int) companionRuntimePage {
	if runtime, ok := companionBuildSlidingRuntimePage(settings, currentPage); ok {
		return runtime
	}
	return companionResolveStaticRuntimePage(settings, currentPage)
}

func companionResolvePageConfig(settings StreamDeckSettings, currentPage int) StreamDeckPageConfig {
	if len(settings.Pages) == 0 {
		fallback := DefaultStreamDeckSettings()
		if len(fallback.Pages) > 0 {
			return fallback.Pages[0]
		}
		return StreamDeckPageConfig{Page: currentPage, Buttons: nil}
	}
	for _, candidate := range settings.Pages {
		if candidate.Page == currentPage {
			return candidate
		}
	}
	return settings.Pages[0]
}

func (s *Server) executeCompanionPageCommand(ctx context.Context, roleID, username string, command CompanionCommand) (CompanionCommandResult, bool) {
	cmd := strings.TrimSpace(command.Command)
	if cmd != "navigate_to_page" && cmd != "page_up" && cmd != "page_down" && cmd != "page_jump" && cmd != "page_home" && cmd != "page_back" {
		return CompanionCommandResult{}, false
	}
	result := CompanionCommandResult{
		CommandID: command.CommandID,
		Command:   command.Command,
		Source:    "bridge",
		Timestamp: time.Now().UnixMilli(),
	}
	if strings.TrimSpace(roleID) == "" {
		result.OK = false
		result.Status = "failed"
		result.Error = "target role unavailable"
		return result, true
	}
	settings, err := s.store.GetRoleStreamDeckSettings(ctx, roleID)
	if err != nil {
		settings = DefaultStreamDeckSettings()
	}
	settings = s.companionResolvedSettings(ctx, roleID, settings)

	targetPage := s.currentCompanionPage(ctx, roleID)
	runtime := s.resolveCompanionRuntimePage(ctx, roleID, settings, targetPage)
	if runtime.Dynamic {
		maxPage := runtime.TotalPages - 1
		if maxPage < 0 {
			maxPage = 0
		}
		switch cmd {
		case "navigate_to_page", "page_jump":
			targetPage = command.PageNumber
		case "page_home":
			targetPage = companionHomePage(settings, true)
		case "page_back":
			if page, ok := companionPageByNumber(settings)[targetPage]; ok && page.ParentPage != nil {
				targetPage = *page.ParentPage
			}
		case "page_up":
			targetPage = targetPage + 1
		default:
			targetPage = targetPage - 1
		}
		if targetPage < 0 {
			targetPage = 0
		}
		if targetPage > maxPage {
			targetPage = maxPage
		}
	} else {
		pageOrder := companionPageOrder(settings)
		switch cmd {
		case "navigate_to_page", "page_jump":
			targetPage = command.PageNumber
			found := false
			for _, pageNo := range pageOrder {
				if pageNo == targetPage {
					found = true
					break
				}
			}
			if !found && len(pageOrder) > 0 {
				targetPage = pageOrder[0]
			}
		case "page_home":
			targetPage = companionHomePage(settings, false)
		case "page_back":
			if page, ok := companionPageByNumber(settings)[targetPage]; ok && page.ParentPage != nil {
				targetPage = *page.ParentPage
			}
		default:
			currentIndex := 0
			for i, pageNo := range pageOrder {
				if pageNo == targetPage {
					currentIndex = i
					break
				}
			}
			offset := 1
			if cmd == "page_down" {
				offset = -1
			}
			nextIndex := currentIndex + offset
			if nextIndex < 0 {
				nextIndex = 0
			}
			if nextIndex >= len(pageOrder) {
				nextIndex = len(pageOrder) - 1
			}
			if len(pageOrder) > 0 {
				targetPage = pageOrder[nextIndex]
			}
		}
	}

	s.setCompanionCurrentPage(roleID, targetPage)
	if s.imageStreamCoord != nil {
		s.imageStreamCoord.ResetTargetCache(roleID, username)
	}
	s.emitCompanionCurrentPageImages(ctx, roleID, username)
	result.OK = true
	result.Status = "executed"
	return result, true
}

func (s *Server) companionRoleCanDirectToRole(ctx context.Context, sourceRoleID, targetRoleID string) (bool, error) {
	targetRoleID = strings.TrimSpace(targetRoleID)
	if targetRoleID == "" {
		return false, nil
	}
	rooms, err := s.store.ListRooms(ctx)
	if err != nil {
		return false, err
	}
	for _, room := range rooms {
		senderAllowed, err := s.store.RoomAllowsSenderRole(ctx, room.ID, sourceRoleID)
		if err != nil || !senderAllowed {
			continue
		}
		receiverAllowed, err := s.store.RoomAllowsReceiverRole(ctx, room.ID, targetRoleID)
		if err == nil && receiverAllowed {
			return true, nil
		}
	}
	return false, nil
}

func (s *Server) companionRoleCanDirectToUser(ctx context.Context, sourceRoleID, sourceUsername, targetUserID string) (bool, error) {
	targetUserID = strings.TrimSpace(targetUserID)
	if targetUserID == "" {
		return false, nil
	}
	targetUser, err := s.store.FindUserByID(ctx, targetUserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if strings.TrimSpace(sourceUsername) != "" && strings.EqualFold(strings.TrimSpace(targetUser.Username), strings.TrimSpace(sourceUsername)) {
		return false, nil
	}
	return s.companionRoleCanDirectToRole(ctx, sourceRoleID, targetUser.RoleID)
}

func (s *Server) normalizeCompanionRelayCommand(ctx context.Context, sourceRoleID, sourceUsername string, command CompanionCommand) (CompanionCommand, error) {
	normalized := command
	normalized.Command = strings.TrimSpace(command.Command)
	if normalized.Command == "" {
		return CompanionCommand{}, errors.New("missing command")
	}

	switch normalized.Command {
	case "set_voice_mode":
		normalized.Mode = strings.TrimSpace(command.Mode)
		if normalized.Mode != "always_on" && normalized.Mode != "ptt" {
			return CompanionCommand{}, errors.New("invalid mode")
		}
		return normalized, nil
	case "ptt":
		scope := strings.TrimSpace(command.Scope)
		if scope == "" {
			scope = "room"
		}
		normalized.Scope = scope
		state := strings.TrimSpace(command.State)
		if state == "" {
			state = "ptt_stop"
		}
		if state != "ptt_start" && state != "ptt_stop" {
			return CompanionCommand{}, errors.New("invalid ptt state")
		}
		normalized.State = state
		targetID := strings.TrimSpace(command.TargetID)
		if targetID == "" {
			return CompanionCommand{}, errors.New("missing targetId")
		}
		normalized.TargetID = targetID
		switch scope {
		case "room":
			allowed, err := s.store.RoomAllowsSenderRole(ctx, targetID, sourceRoleID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to talk to room")
			}
		case "direct":
			allowed, err := s.companionRoleCanDirectToUser(ctx, sourceRoleID, sourceUsername, targetID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to direct PTT target user")
			}
		case "broadcast":
			allowed, err := s.store.BroadcastGroupAllowsRole(ctx, targetID, sourceRoleID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to broadcast to target group")
			}
		default:
			return CompanionCommand{}, errors.New("unsupported ptt scope")
		}
		return normalized, nil
	case "signal":
		scope := strings.TrimSpace(command.Scope)
		if scope == "" {
			scope = "room"
		}
		normalized.Scope = scope
		targetID := strings.TrimSpace(command.TargetID)
		if targetID == "" {
			return CompanionCommand{}, errors.New("missing targetId")
		}
		normalized.TargetID = targetID
		normalized.Signal = strings.TrimSpace(command.Signal)
		if normalized.Signal == "" {
			return CompanionCommand{}, errors.New("missing signal")
		}
		switch scope {
		case "room":
			allowed, err := s.store.RoomAllowsSenderRole(ctx, targetID, sourceRoleID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to signal room")
			}
		case "direct":
			allowed, err := s.companionRoleCanDirectToUser(ctx, sourceRoleID, sourceUsername, targetID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to signal target user")
			}
		case "broadcast":
			allowed, err := s.store.BroadcastGroupAllowsRole(ctx, targetID, sourceRoleID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to signal broadcast group")
			}
		default:
			return CompanionCommand{}, errors.New("unsupported signal scope")
		}
		return normalized, nil
	case "set_room_matrix":
		if command.ListenRoomIDs == nil && command.TalkRoomIDs == nil {
			return CompanionCommand{}, errors.New("missing room matrix payload")
		}
		listen := normalizeIDs(command.ListenRoomIDs)
		for _, roomID := range listen {
			allowed, err := s.store.RoomAllowsReceiverRole(ctx, roomID, sourceRoleID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to listen to room")
			}
		}
		talk := normalizeIDs(command.TalkRoomIDs)
		for _, roomID := range talk {
			allowed, err := s.store.RoomAllowsSenderRole(ctx, roomID, sourceRoleID)
			if err != nil {
				return CompanionCommand{}, err
			}
			if !allowed {
				return CompanionCommand{}, errors.New("not allowed to talk to room")
			}
		}
		normalized.ListenRoomIDs = s.mergeForcedListenRooms(ctx, sourceRoleID, listen)
		normalized.TalkRoomIDs = talk
		return normalized, nil
	case "input_gain_delta":
		if command.VolumeDelta == 0 {
			return CompanionCommand{}, errors.New("missing volumeDelta")
		}
		return normalized, nil
	case "navigate_to_page", "page_up", "page_down", "page_jump", "page_home", "page_back":
		return normalized, nil
	case "set_streamdeck_brightness", "clear_streamdeck_panel", "reset_streamdeck":
		return normalized, nil
	default:
		return CompanionCommand{}, errors.New("unsupported command")
	}
}

func (s *Server) subscribeCompanionResults(roleID string) (chan CompanionCommandResult, func()) {
	ch := make(chan CompanionCommandResult, 16)
	s.companionMu.Lock()
	if s.companionWS[roleID] == nil {
		s.companionWS[roleID] = make(map[chan CompanionCommandResult]struct{})
	}
	s.companionWS[roleID][ch] = struct{}{}
	s.companionMu.Unlock()

	unsubscribe := func() {
		s.companionMu.Lock()
		if subscribers, ok := s.companionWS[roleID]; ok {
			if _, exists := subscribers[ch]; exists {
				delete(subscribers, ch)
			}
			if len(subscribers) == 0 {
				delete(s.companionWS, roleID)
			}
		}
		s.companionMu.Unlock()
	}
	return ch, unsubscribe
}

func (s *Server) subscribeCompanionState(roleID string) (chan struct{}, func()) {
	ch := make(chan struct{}, 4)
	s.companionMu.Lock()
	if s.companionState[roleID] == nil {
		s.companionState[roleID] = make(map[chan struct{}]struct{})
	}
	s.companionState[roleID][ch] = struct{}{}
	s.companionMu.Unlock()

	unsubscribe := func() {
		s.companionMu.Lock()
		if subscribers, ok := s.companionState[roleID]; ok {
			if _, exists := subscribers[ch]; exists {
				delete(subscribers, ch)
			}
			if len(subscribers) == 0 {
				delete(s.companionState, roleID)
			}
		}
		s.companionMu.Unlock()
	}
	return ch, unsubscribe
}

func (s *Server) publishCompanionResult(roleID string, result CompanionCommandResult) {
	s.companionMu.RLock()
	subscribers := s.companionWS[roleID]
	if len(subscribers) == 0 {
		s.companionMu.RUnlock()
		return
	}
	channels := make([]chan CompanionCommandResult, 0, len(subscribers))
	for ch := range subscribers {
		channels = append(channels, ch)
	}
	s.companionMu.RUnlock()

	for _, ch := range channels {
		select {
		case ch <- result:
		default:
		}
	}
}

func (s *Server) publishCompanionState(roleID string) {
	s.companionMu.RLock()
	subscribers := s.companionState[roleID]
	if len(subscribers) == 0 {
		s.companionMu.RUnlock()
		return
	}
	channels := make([]chan struct{}, 0, len(subscribers))
	for ch := range subscribers {
		channels = append(channels, ch)
	}
	s.companionMu.RUnlock()
	for _, ch := range channels {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (s *Server) resetCompanionCurrentPage(roleID string) {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return
	}
	s.companionMu.Lock()
	delete(s.companionPageByRole, roleID)
	s.companionMu.Unlock()
	s.publishCompanionState(roleID)
}

func (s *Server) currentCompanionPage(ctx context.Context, roleID string) int {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return 0
	}
	s.companionMu.RLock()
	if s.companionPageByRole == nil {
		s.companionMu.RUnlock()
		s.companionMu.Lock()
		if s.companionPageByRole == nil {
			s.companionPageByRole = make(map[string]int)
		}
		s.companionMu.Unlock()
		s.companionMu.RLock()
	}
	page, ok := s.companionPageByRole[roleID]
	s.companionMu.RUnlock()
	if ok {
		return page
	}
	settings, err := s.store.GetRoleStreamDeckSettings(ctx, roleID)
	if err != nil {
		settings = DefaultStreamDeckSettings()
	}
	page = settings.SelectedPage
	s.companionMu.Lock()
	s.companionPageByRole[roleID] = page
	s.companionMu.Unlock()
	return page
}

func (s *Server) setCompanionCurrentPage(roleID string, page int) {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionPageByRole == nil {
		s.companionPageByRole = make(map[string]int)
	}
	s.companionPageByRole[roleID] = page
	s.companionMu.Unlock()
	s.publishCompanionState(roleID)
}

func (s *Server) markCompanionPageButtonDown(roleID string, buttonIndex int) {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return
	}
	key := fmt.Sprintf("%s:%d", roleID, buttonIndex)
	s.companionMu.Lock()
	if s.companionPageButtonDown == nil {
		s.companionPageButtonDown = make(map[string]bool)
	}
	s.companionPageButtonDown[key] = true
	s.companionMu.Unlock()
}

func (s *Server) consumeCompanionPageButtonDown(roleID string, buttonIndex int) bool {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return false
	}
	key := fmt.Sprintf("%s:%d", roleID, buttonIndex)
	s.companionMu.Lock()
	defer s.companionMu.Unlock()
	if s.companionPageButtonDown == nil {
		return false
	}
	if !s.companionPageButtonDown[key] {
		return false
	}
	delete(s.companionPageButtonDown, key)
	return true
}

func (s *Server) setCompanionPageNavAnchor(roleID string, buttonIndex int) {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionPageNavAnchorByRole == nil {
		s.companionPageNavAnchorByRole = make(map[string]int)
	}
	s.companionPageNavAnchorByRole[roleID] = buttonIndex
	s.companionMu.Unlock()
}

func (s *Server) hasCompanionPageNavAnchor(roleID string, buttonIndex int) bool {
	roleID = strings.TrimSpace(roleID)
	if roleID == "" {
		return false
	}
	s.companionMu.RLock()
	defer s.companionMu.RUnlock()
	if s.companionPageNavAnchorByRole == nil {
		return false
	}
	anchoredIndex, ok := s.companionPageNavAnchorByRole[roleID]
	if !ok {
		return false
	}
	return anchoredIndex == buttonIndex
}

func companionResolveUniqueNavigationAction(buttons []StreamDeckButtonConfig) *StreamDeckButtonConfig {
	var resolved *StreamDeckButtonConfig
	for i := range buttons {
		candidate := buttons[i]
		if candidate.Action == nil {
			continue
		}
		if candidate.Action.Type != StreamDeckActionTypePageUp && candidate.Action.Type != StreamDeckActionTypePageDown &&
			candidate.Action.Type != StreamDeckActionTypePageJump && candidate.Action.Type != StreamDeckActionTypePageHome {
			continue
		}
		if resolved != nil {
			return nil
		}
		copyCandidate := candidate
		resolved = &copyCandidate
	}
	return resolved
}

func (s *Server) publishCompanionPresenceUpdate(ctx context.Context, roleID string) {
	// Signal Companion clients that presence has updated (listen state changed)
	// so they refresh their listen-related button images
	s.publishCompanionState(roleID)
}

func (s *Server) setCompanionPendingIncomingCall(username string, pending bool) {
	username = strings.TrimSpace(username)
	if username == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionPendingCallByUser == nil {
		s.companionPendingCallByUser = make(map[string]bool)
	}
	if pending {
		s.companionPendingCallByUser[username] = true
	} else {
		delete(s.companionPendingCallByUser, username)
		delete(s.companionPendingCallerByUser, username)
		delete(s.companionPendingCallScopeByUser, username)
		delete(s.companionPendingCallSourceByUser, username)
	}
	s.companionMu.Unlock()
}

func (s *Server) setCompanionPendingIncomingCallScope(username, scope string) {
	username = strings.TrimSpace(username)
	scope = strings.TrimSpace(scope)
	if username == "" || scope == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionPendingCallScopeByUser == nil {
		s.companionPendingCallScopeByUser = make(map[string]string)
	}
	s.companionPendingCallScopeByUser[username] = scope
	s.companionMu.Unlock()
}

func (s *Server) companionPendingIncomingCallScope(username string) string {
	username = strings.TrimSpace(username)
	if username == "" {
		return ""
	}
	s.companionMu.RLock()
	scope := s.companionPendingCallScopeByUser[username]
	s.companionMu.RUnlock()
	return strings.TrimSpace(scope)
}

func (s *Server) setCompanionPendingIncomingCallSource(username, sourceType, sourceID string) {
	username = strings.TrimSpace(username)
	sourceType = strings.TrimSpace(sourceType)
	sourceID = strings.TrimSpace(sourceID)
	if username == "" || sourceType == "" || sourceID == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionPendingCallSourceByUser == nil {
		s.companionPendingCallSourceByUser = make(map[string]string)
	}
	s.companionPendingCallSourceByUser[username] = sourceType + "|" + sourceID
	s.companionMu.Unlock()
}

func (s *Server) companionPendingIncomingCallSource(username string) (string, string, bool) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", "", false
	}
	s.companionMu.RLock()
	value := s.companionPendingCallSourceByUser[username]
	s.companionMu.RUnlock()
	parts := strings.SplitN(strings.TrimSpace(value), "|", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "", "", false
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), true
}

func (s *Server) setCompanionPendingIncomingCaller(username, caller string) {
	username = strings.TrimSpace(username)
	caller = strings.TrimSpace(caller)
	if username == "" || caller == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionPendingCallerByUser == nil {
		s.companionPendingCallerByUser = make(map[string]string)
	}
	s.companionPendingCallerByUser[username] = caller
	s.companionMu.Unlock()
}

func companionSignalFingerprint(signalFrom, signalMessage, signalScope, sourceType, sourceID string) string {
	return strings.TrimSpace(signalFrom) + "|" + strings.TrimSpace(signalMessage) + "|" + strings.TrimSpace(signalScope) + "|" + strings.TrimSpace(sourceType) + "|" + strings.TrimSpace(sourceID)
}

func (s *Server) clearCompanionIncomingSignalAck(username string) {
	username = strings.TrimSpace(username)
	if username == "" {
		return
	}
	s.companionMu.Lock()
	if s.companionAckedSignalByUser != nil {
		delete(s.companionAckedSignalByUser, username)
	}
	s.companionMu.Unlock()
}

func (s *Server) companionIncomingSignal(username string) (string, string, string, string, string, bool) {
	username = strings.TrimSpace(username)
	if username == "" || s.hub == nil {
		return "", "", "", "", "", false
	}
	signalFrom, signalMessage, signalScope, signalSourceType, signalSourceID, signalActive := s.hub.SignalStateWithMetadataForUsername(username)
	if !signalActive {
		s.clearCompanionIncomingSignalAck(username)
		return "", "", "", "", "", false
	}
	fingerprint := companionSignalFingerprint(signalFrom, signalMessage, signalScope, signalSourceType, signalSourceID)
	s.companionMu.RLock()
	ackedFingerprint := ""
	if s.companionAckedSignalByUser != nil {
		ackedFingerprint = s.companionAckedSignalByUser[username]
	}
	s.companionMu.RUnlock()
	if ackedFingerprint != "" && ackedFingerprint == fingerprint {
		return "", "", "", "", "", false
	}
	return signalFrom, signalMessage, signalScope, signalSourceType, signalSourceID, true
}

func (s *Server) acknowledgeCompanionIncomingCall(username string) {
	username = strings.TrimSpace(username)
	if username == "" {
		return
	}
	if signalFrom, signalMessage, signalScope, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(username); signalActive {
		fingerprint := companionSignalFingerprint(signalFrom, signalMessage, signalScope, signalSourceType, signalSourceID)
		s.companionMu.Lock()
		if s.companionAckedSignalByUser == nil {
			s.companionAckedSignalByUser = make(map[string]string)
		}
		s.companionAckedSignalByUser[username] = fingerprint
		s.companionMu.Unlock()
	}
	s.setCompanionPendingIncomingCall(username, false)
}

func (s *Server) companionPendingIncomingCaller(username string) (string, bool) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", false
	}
	s.companionMu.RLock()
	caller, ok := s.companionPendingCallerByUser[username]
	s.companionMu.RUnlock()
	caller = strings.TrimSpace(caller)
	if !ok || caller == "" {
		return "", false
	}
	return caller, true
}

func (s *Server) hasCompanionPendingIncomingCall(username string) bool {
	username = strings.TrimSpace(username)
	if username == "" {
		return false
	}
	s.companionMu.RLock()
	pending := s.companionPendingCallByUser[username]
	s.companionMu.RUnlock()
	return pending
}

func (s *Server) rememberCompanionHeldTarget(key, targetID string) {
	if key == "" || targetID == "" {
		return
	}
	s.companionMu.Lock()
	s.companionHeldTargets[key] = targetID
	s.companionMu.Unlock()
}

func (s *Server) consumeCompanionHeldTarget(key string) string {
	if key == "" {
		return ""
	}
	s.companionMu.Lock()
	targetID := s.companionHeldTargets[key]
	delete(s.companionHeldTargets, key)
	s.companionMu.Unlock()
	return targetID
}

func (s *Server) companionHeldTarget(key string) (string, bool) {
	if key == "" {
		return "", false
	}
	s.companionMu.RLock()
	targetID, ok := s.companionHeldTargets[key]
	s.companionMu.RUnlock()
	if !ok || strings.TrimSpace(targetID) == "" {
		return "", false
	}
	return targetID, true
}

func companionIncomingSourceMatchesButton(action *StreamDeckButtonAction, sourceType, sourceID string) bool {
	if action == nil {
		return false
	}
	sourceType = strings.TrimSpace(sourceType)
	sourceID = strings.TrimSpace(sourceID)
	if sourceType == "" || sourceID == "" {
		return false
	}
	switch sourceType {
	case "role":
		return action.Type == StreamDeckActionTypeDirectRole && strings.TrimSpace(action.RoleID) == sourceID
	case "room":
		if strings.TrimSpace(action.RoomID) != sourceID {
			return false
		}
		switch action.Type {
		case StreamDeckActionTypePTTRoom, StreamDeckActionTypeSelectTalkRoom, StreamDeckActionTypeSelectListen, StreamDeckActionTypeListenRoom, StreamDeckActionTypeCallRoom:
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func (s *Server) selectListenCompanionHoldDelay() time.Duration {
	if s.companionSelectListenHoldDelay > 0 {
		return s.companionSelectListenHoldDelay
	}
	return companionSelectListenHoldDelayDefault
}

func (s *Server) companionButtonSnapshotState(ctx context.Context, roleID string, pageNumber int, username string, presence PresenceState, button StreamDeckButtonConfig) ButtonState {
	state := ButtonState{State: "IDLE"}
	if button.Action == nil || button.Action.Type == StreamDeckActionTypeNone {
		return state
	}
	if button.Action.Type == StreamDeckActionTypeReplyToCaller {
		state.Label, state.Subtitle = s.resolveReplyToCallerLabels(button, username)
	} else if button.Action.Type == StreamDeckActionTypeIncomingCall {
		state.Label, state.Subtitle = s.resolveIncomingCallIndicatorLabels(button, username)
	}

	action := button.Action
	holdKey := fmt.Sprintf("%s:%d:%d", strings.TrimSpace(roleID), pageNumber, button.Index)
	roomID := strings.TrimSpace(action.RoomID)
	broadcastGroupID := strings.TrimSpace(action.BroadcastGroupID)

	contains := func(values []string, target string) bool {
		target = strings.TrimSpace(target)
		if target == "" {
			return false
		}
		for _, value := range values {
			if strings.TrimSpace(value) == target {
				return true
			}
		}
		return false
	}

	switch action.Type {
	case StreamDeckActionTypePTTRoom, StreamDeckActionTypePTTSelected,
		StreamDeckActionTypeDirectUser, StreamDeckActionTypeDirectRole,
		StreamDeckActionTypeReplyToCaller:
		if roomID != "" && contains(presence.ListenRooms, roomID) {
			state.IsListening = true
		}
		if _, ok := s.companionHeldTarget(holdKey); ok {
			state.State = "TALK"
		}
	case StreamDeckActionTypeBroadcastPTT:
		if _, ok := s.companionHeldTarget(holdKey); ok {
			state.State = "BROADCAST"
		}
	case StreamDeckActionTypeListenRoom:
		listening := contains(presence.ListenRooms, roomID)
		if listening {
			state.State = "LISTEN"
			state.IsListening = true
		}
	case StreamDeckActionTypeSelectTalkRoom, StreamDeckActionTypeSelectListen:
		if roomID != "" && contains(presence.ListenRooms, roomID) {
			state.IsListening = true
		}
		if roomID != "" && contains(presence.TalkRooms, roomID) {
			state.IsPTTSelected = true
		}
	case StreamDeckActionTypeMuteToggle:
		if strings.TrimSpace(presence.VoiceMode) == "always_on" {
			state.State = "TALK"
		}
	}

	if action.Type == StreamDeckActionTypeReplyToCaller {
		hasPendingDirectCall := s.hasCompanionPendingIncomingCall(strings.TrimSpace(username)) && s.companionPendingIncomingCallScope(strings.TrimSpace(username)) == "direct"
		if signalFrom, _, signalScope, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(strings.TrimSpace(username)); signalActive {
			s.setCompanionPendingIncomingCall(strings.TrimSpace(username), true)
			s.setCompanionPendingIncomingCaller(strings.TrimSpace(username), signalFrom)
			s.setCompanionPendingIncomingCallScope(strings.TrimSpace(username), signalScope)
			s.setCompanionPendingIncomingCallSource(strings.TrimSpace(username), signalSourceType, signalSourceID)
			hasPendingDirectCall = signalScope == "direct"
		}
		if hasPendingDirectCall {
			state.EffectValue = companionIncomingCallEffectValue
			if state.State != "TALK" {
				blinkOn := (time.Now().UnixMilli()/companionIncomingCallBlinkInterval.Milliseconds())%2 == 0
				if blinkOn {
					state.State = "TALK"
				} else {
					state.State = "IDLE"
				}
			}
		}
	}

	if action.Type == StreamDeckActionTypeIncomingCall {
		hasPendingCall := s.hasCompanionPendingIncomingCall(strings.TrimSpace(username))
		if signalFrom, _, signalScope, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(strings.TrimSpace(username)); signalActive {
			hasPendingCall = true
			s.setCompanionPendingIncomingCall(strings.TrimSpace(username), true)
			s.setCompanionPendingIncomingCaller(strings.TrimSpace(username), signalFrom)
			s.setCompanionPendingIncomingCallScope(strings.TrimSpace(username), signalScope)
			s.setCompanionPendingIncomingCallSource(strings.TrimSpace(username), signalSourceType, signalSourceID)
			state.Subtitle = strings.TrimSpace(signalFrom)
		}
		if strings.TrimSpace(state.Subtitle) == "" {
			if caller, ok := s.companionPendingIncomingCaller(strings.TrimSpace(username)); ok {
				state.Subtitle = caller
			}
		}
		if hasPendingCall {
			state.EffectValue = companionIncomingCallEffectValue
			blinkOn := (time.Now().UnixMilli()/companionIncomingCallBlinkInterval.Milliseconds())%2 == 0
			if blinkOn {
				state.State = "TALK"
			} else {
				state.State = "IDLE"
			}
		}
	}

	hasPendingSourceCall := s.hasCompanionPendingIncomingCall(strings.TrimSpace(username))
	pendingSourceType, pendingSourceID, hasPendingSource := s.companionPendingIncomingCallSource(strings.TrimSpace(username))
	if signalFrom, _, signalScope, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(strings.TrimSpace(username)); signalActive {
		s.setCompanionPendingIncomingCall(strings.TrimSpace(username), true)
		s.setCompanionPendingIncomingCaller(strings.TrimSpace(username), signalFrom)
		s.setCompanionPendingIncomingCallScope(strings.TrimSpace(username), signalScope)
		s.setCompanionPendingIncomingCallSource(strings.TrimSpace(username), signalSourceType, signalSourceID)
		hasPendingSourceCall = true
		pendingSourceType = signalSourceType
		pendingSourceID = signalSourceID
		hasPendingSource = signalSourceType != "" && signalSourceID != ""
	}
	if hasPendingSourceCall && hasPendingSource && companionIncomingSourceMatchesButton(action, pendingSourceType, pendingSourceID) {
		state.EffectValue = companionIncomingCallEffectValue
		blinkOn := (time.Now().UnixMilli()/companionIncomingCallBlinkInterval.Milliseconds())%2 == 0
		if blinkOn {
			state.State = "TALK"
		}
	}

	if action.Type == StreamDeckActionTypeListenRoom && state.State == "LISTEN" && roomID != "" {
		state.IsListening = true
	}
	if state.State == "BROADCAST" && broadcastGroupID != "" {
		state.Channel = broadcastGroupID
	}
	return state
}

func (s *Server) executeCompanionButtonPress(ctx context.Context, roleID string, username string, command CompanionCommand) CompanionCommandResult {
	result := CompanionCommandResult{
		CommandID: command.CommandID,
		Command:   command.Command,
		OK:        false,
		Status:    "failed",
		Source:    "server",
		Timestamp: time.Now().UnixMilli(),
	}
	settings, err := s.store.GetRoleStreamDeckSettings(ctx, roleID)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			result.Error = err.Error()
			return result
		}
		settings = DefaultStreamDeckSettings()
	}
	settings = s.companionResolvedSettings(ctx, roleID, settings)
	currentPage := s.currentCompanionPage(ctx, roleID)
	runtimePage := s.resolveCompanionRuntimePage(ctx, roleID, settings, currentPage)
	page := runtimePage.Page
	var button *StreamDeckButtonConfig
	for i := range page.Buttons {
		if page.Buttons[i].Index == command.ButtonIndex {
			button = &page.Buttons[i]
			break
		}
	}
	if (button == nil || button.Action == nil || button.Action.Type == StreamDeckActionTypeNone) && s.hasCompanionPageNavAnchor(roleID, command.ButtonIndex) {
		button = companionResolveUniqueNavigationAction(page.Buttons)
	}
	if (button == nil || button.Action == nil || button.Action.Type == StreamDeckActionTypeNone) && runtimePage.Dynamic {
		buttonCount := companionGridButtonCount(settings)
		prevSlot := buttonCount - 2
		nextSlot := buttonCount - 1
		if command.ButtonIndex == nextSlot && currentPage > 0 {
			button = &StreamDeckButtonConfig{
				Index:  nextSlot,
				Label:  "Page -",
				Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageDown},
			}
		} else if command.ButtonIndex == prevSlot && currentPage < runtimePage.TotalPages-1 {
			button = &StreamDeckButtonConfig{
				Index:  prevSlot,
				Label:  "Page +",
				Action: &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp},
			}
		}
	}
	if button == nil || button.Action == nil || button.Action.Type == StreamDeckActionTypeNone {
		if s.logger != nil {
			s.logger.Info("companion press_button no-op",
				"roleId", roleID,
				"username", username,
				"buttonIndex", command.ButtonIndex,
				"phase", command.State,
				"currentPage", currentPage,
				"dynamic", runtimePage.Dynamic,
				"totalPages", runtimePage.TotalPages,
			)
		}
		s.emitCompanionButtonImage(ctx, roleID, username, page.Page, nil, ButtonState{State: "IDLE"})
		result.OK = true
		result.Status = "executed"
		return result
	}

	phase := strings.TrimSpace(command.State)
	if phase == "" {
		phase = "down"
	}
	if s.logger != nil {
		s.logger.Info("companion press_button mapped",
			"roleId", roleID,
			"username", username,
			"buttonIndex", command.ButtonIndex,
			"phase", phase,
			"currentPage", currentPage,
			"runtimePage", page.Page,
			"dynamic", runtimePage.Dynamic,
			"totalPages", runtimePage.TotalPages,
			"actionType", button.Action.Type,
			"actionRoomId", button.Action.RoomID,
			"actionUserId", button.Action.UserID,
			"actionRoleId", button.Action.RoleID,
			"actionBroadcastGroupId", button.Action.BroadcastGroupID,
		)
	}
	if phase == "down" && button.Action != nil && s.hasCompanionPendingIncomingCall(strings.TrimSpace(username)) {
		sourceType, sourceID, hasSource := s.companionPendingIncomingCallSource(strings.TrimSpace(username))
		if !hasSource {
			if _, _, _, signalSourceType, signalSourceID, signalActive := s.companionIncomingSignal(strings.TrimSpace(username)); signalActive {
				if strings.TrimSpace(signalSourceType) != "" && strings.TrimSpace(signalSourceID) != "" {
					sourceType = signalSourceType
					sourceID = signalSourceID
					hasSource = true
					s.setCompanionPendingIncomingCallSource(strings.TrimSpace(username), signalSourceType, signalSourceID)
				}
			}
		}
		if hasSource && companionIncomingSourceMatchesButton(button.Action, sourceType, sourceID) {
			s.acknowledgeCompanionIncomingCall(username)
		}
	}
	holdKey := fmt.Sprintf("%s:%d:%d", roleID, currentPage, command.ButtonIndex)
	emitCompanionCurrentPageImages := func() {
		s.emitCompanionCurrentPageImages(ctx, roleID, username)
	}
	emitCompanionButtonImage := func(bank int, button *StreamDeckButtonConfig, state ButtonState) {
		s.emitCompanionButtonImage(ctx, roleID, username, bank, button, state)
	}
	presence, _ := s.hub.PresenceForUsername(username)
	queueBrowserCommand := func(next CompanionCommand) CompanionCommandResult {
		queued, err := s.queueCompanionBrowserCommand(username, next)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		queued.CommandID = command.CommandID
		queued.Command = command.Command
		return queued
	}
	queueBrowserCommands := func(commands ...CompanionCommand) CompanionCommandResult {
		last := result
		for _, next := range commands {
			last = queueBrowserCommand(next)
			if !last.OK {
				return last
			}
		}
		return last
	}

	rejectUnauthorized := func(reason string) CompanionCommandResult {
		result.Error = reason
		result.Status = "rejected"
		return result
	}

	isRoomTalkAllowed := func(roomID string) (bool, error) {
		return s.store.RoomAllowsSenderRole(ctx, strings.TrimSpace(roomID), roleID)
	}
	isRoomListenAllowed := func(roomID string) (bool, error) {
		return s.store.RoomAllowsReceiverRole(ctx, strings.TrimSpace(roomID), roleID)
	}
	isDirectRoleAllowed := func(targetRoleID string) (bool, error) {
		targetRoleID = strings.TrimSpace(targetRoleID)
		if targetRoleID == "" {
			return false, nil
		}
		rooms, err := s.store.ListRooms(ctx)
		if err != nil {
			return false, err
		}
		for _, room := range rooms {
			senderAllowed, err := s.store.RoomAllowsSenderRole(ctx, room.ID, roleID)
			if err != nil || !senderAllowed {
				continue
			}
			receiverAllowed, err := s.store.RoomAllowsReceiverRole(ctx, room.ID, targetRoleID)
			if err == nil && receiverAllowed {
				return true, nil
			}
		}
		return false, nil
	}
	isDirectUserAllowed := func(targetUserID string) (bool, error) {
		targetUserID = strings.TrimSpace(targetUserID)
		if targetUserID == "" {
			return false, nil
		}
		targetUser, err := s.store.FindUserByID(ctx, targetUserID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return false, nil
			}
			return false, err
		}
		if presence.UserID != "" && presence.UserID == targetUser.ID {
			return false, nil
		}
		return isDirectRoleAllowed(targetUser.RoleID)
	}
	isBroadcastAllowed := func(groupID string) (bool, error) {
		groupID = strings.TrimSpace(groupID)
		if groupID == "" {
			return false, nil
		}
		allowed, err := s.store.BroadcastGroupAllowsRole(ctx, groupID, roleID)
		if err != nil || !allowed {
			return false, err
		}
		roomIDs, err := s.store.BroadcastGroupRoomIDs(ctx, groupID)
		if err != nil {
			return false, err
		}
		for _, roomID := range roomIDs {
			canTalk, err := s.store.RoomAllowsSenderRole(ctx, roomID, roleID)
			if err == nil && canTalk {
				return true, nil
			}
		}
		return false, nil
	}

	switch button.Action.Type {
	case StreamDeckActionTypePageUp, StreamDeckActionTypePageDown:
		if phase == "up" {
			if s.consumeCompanionPageButtonDown(roleID, command.ButtonIndex) {
				result.OK = true
				result.Status = "executed"
				return result
			}
		} else {
			s.markCompanionPageButtonDown(roleID, command.ButtonIndex)
		}
		if phase != "down" && phase != "up" {
			result.OK = true
			result.Status = "executed"
			return result
		}
		targetPage := currentPage
		if runtimePage.Dynamic {
			if button.Action.Type == StreamDeckActionTypePageUp {
				targetPage = currentPage + 1
			} else {
				targetPage = currentPage - 1
			}
			maxPage := runtimePage.TotalPages - 1
			if maxPage < 0 {
				maxPage = 0
			}
			if targetPage < 0 {
				targetPage = 0
			}
			if targetPage > maxPage {
				targetPage = maxPage
			}
		} else {
			pageOrder := companionPageOrder(settings)
			pageToIndex := make(map[int]int, len(pageOrder))
			for i, pageNo := range pageOrder {
				pageToIndex[pageNo] = i
			}
			currentIndex := pageToIndex[currentPage]
			offset := 1
			if button.Action.Type == StreamDeckActionTypePageDown {
				offset = -1
			}
			nextIndex := currentIndex + offset
			if nextIndex < 0 {
				nextIndex = 0
			}
			if nextIndex >= len(pageOrder) {
				nextIndex = len(pageOrder) - 1
			}
			if len(pageOrder) > 0 {
				targetPage = pageOrder[nextIndex]
			}
		}
		if s.logger != nil {
			s.logger.Info("companion page navigation",
				"roleId", roleID,
				"username", username,
				"buttonIndex", command.ButtonIndex,
				"phase", phase,
				"actionType", button.Action.Type,
				"dynamic", runtimePage.Dynamic,
				"fromPage", currentPage,
				"toPage", targetPage,
				"totalPages", runtimePage.TotalPages,
			)
		}
		s.setCompanionCurrentPage(roleID, targetPage)
		if s.imageStreamCoord != nil {
			s.imageStreamCoord.ResetTargetCache(roleID, username)
		}
		s.setCompanionPageNavAnchor(roleID, command.ButtonIndex)
		emitCompanionCurrentPageImages()
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE"})
		result.OK = true
		result.Status = "executed"
		return result
	case StreamDeckActionTypePageJump, StreamDeckActionTypePageHome:
		if phase != "down" {
			result.OK = true
			result.Status = "executed"
			return result
		}
		jumpTarget := button.Action.TargetPage
		if button.Action.Type == StreamDeckActionTypePageHome {
			jumpTarget = companionHomePage(settings, runtimePage.Dynamic)
		}
		if runtimePage.Dynamic {
			maxPage := runtimePage.TotalPages - 1
			if maxPage < 0 {
				maxPage = 0
			}
			if jumpTarget < 0 {
				jumpTarget = 0
			}
			if jumpTarget > maxPage {
				jumpTarget = maxPage
			}
		} else {
			pageOrder := companionPageOrder(settings)
			found := false
			for _, pageNo := range pageOrder {
				if pageNo == jumpTarget {
					found = true
					break
				}
			}
			if !found && len(pageOrder) > 0 {
				jumpTarget = pageOrder[0]
			}
		}
		if s.logger != nil {
			s.logger.Info("companion page navigation",
				"roleId", roleID,
				"username", username,
				"buttonIndex", command.ButtonIndex,
				"phase", phase,
				"actionType", button.Action.Type,
				"fromPage", currentPage,
				"toPage", jumpTarget,
			)
		}
		s.setCompanionCurrentPage(roleID, jumpTarget)
		if s.imageStreamCoord != nil {
			s.imageStreamCoord.ResetTargetCache(roleID, username)
		}
		emitCompanionCurrentPageImages()
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE"})
		result.OK = true
		result.Status = "executed"
		return result
	case StreamDeckActionTypeMuteToggle:
		mode := "always_on"
		if strings.TrimSpace(presence.VoiceMode) == "always_on" {
			mode = "ptt"
		}
		state := "IDLE"
		if mode == "always_on" {
			state = "TALK"
		}
		res := queueBrowserCommand(CompanionCommand{Command: "set_voice_mode", Mode: mode})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: state})
		return res
	case StreamDeckActionTypePTTRoom:
		roomID := strings.TrimSpace(button.Action.RoomID)
		if roomID == "" {
			return rejectUnauthorized("roomId is required")
		}
		allowed, err := isRoomTalkAllowed(roomID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to talk to room")
		}
		targetID := roomID
		if phase == "down" {
			s.rememberCompanionHeldTarget(holdKey, roomID)
			res := queueBrowserCommands(
				CompanionCommand{
					Command:       "set_room_matrix",
					ListenRoomIDs: append([]string(nil), presence.ListenRooms...),
					TalkRoomIDs:   []string{roomID},
				},
				CompanionCommand{
					Command:  "ptt",
					Scope:    "room",
					TargetID: roomID,
					State:    "ptt_start",
				},
			)
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "TALK", Channel: strings.TrimSpace(button.Action.RoomID)})
			return res
		} else if heldTargetID, ok := s.companionHeldTarget(holdKey); ok {
			targetID = heldTargetID
			_ = s.consumeCompanionHeldTarget(holdKey)
		}
		res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "room", TargetID: targetID, State: map[bool]string{true: "ptt_start", false: "ptt_stop"}[phase == "down"]})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "TALK", false: "IDLE"}[phase == "down"], Channel: strings.TrimSpace(button.Action.RoomID)})
		return res
	case StreamDeckActionTypeSelectTalkRoom:
		roomID := strings.TrimSpace(button.Action.RoomID)
		if roomID == "" {
			return rejectUnauthorized("roomId is required")
		}
		allowed, err := isRoomTalkAllowed(roomID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to talk to room")
		}
		isListening := false
		for _, entry := range presence.ListenRooms {
			if entry == roomID {
				isListening = true
				break
			}
		}
		isPTTSelected := false
		for _, entry := range presence.TalkRooms {
			if entry == roomID {
				isPTTSelected = true
				break
			}
		}
		if phase != "down" {
			state := "IDLE"
			for _, entry := range presence.TalkRooms {
				if entry == roomID {
					state = "LISTEN"
					break
				}
			}
			emitCompanionButtonImage(page.Page, button, ButtonState{State: state, Channel: roomID, IsListening: isListening, IsPTTSelected: isPTTSelected})
			result.OK = true
			result.Status = "executed"
			return result
		}
		res := queueBrowserCommand(CompanionCommand{Command: "set_room_matrix", ListenRoomIDs: append([]string(nil), presence.ListenRooms...), TalkRoomIDs: []string{roomID}})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "LISTEN", Channel: roomID, IsListening: isListening, IsPTTSelected: true})
		return res
	case StreamDeckActionTypeSelectListen:
		roomID := strings.TrimSpace(button.Action.RoomID)
		if roomID == "" {
			return rejectUnauthorized("roomId is required")
		}
		canTalk, err := isRoomTalkAllowed(roomID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		canListen, err := isRoomListenAllowed(roomID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !canTalk && !canListen {
			return rejectUnauthorized("not allowed to talk or listen to room")
		}
		isListening := false
		for _, entry := range presence.ListenRooms {
			if entry == roomID {
				isListening = true
				break
			}
		}
		isPTTSelected := false
		for _, entry := range presence.TalkRooms {
			if entry == roomID {
				isPTTSelected = true
				break
			}
		}
		triggerKey := fmt.Sprintf("select-listen-triggered:%s", holdKey)
		if phase != "down" {
			triggered := false
			if _, ok := s.companionHeldTarget(triggerKey); ok {
				triggered = true
				_ = s.consumeCompanionHeldTarget(triggerKey)
			}
			_ = s.consumeCompanionHeldTarget(holdKey)
			state := "IDLE"
			for _, entry := range presence.TalkRooms {
				if entry == roomID {
					state = "LISTEN"
					break
				}
			}
			if triggered {
				stillListening := false
				for _, entry := range presence.ListenRooms {
					if entry == roomID {
						stillListening = true
						break
					}
				}
				emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "LISTEN", false: state}[stillListening], Channel: roomID, IsListening: stillListening, IsPTTSelected: isPTTSelected})
				result.OK = true
				result.Status = "executed"
				return result
			}
			if !canTalk {
				return rejectUnauthorized("not allowed to talk to room")
			}
			emitCompanionButtonImage(page.Page, button, ButtonState{State: state, Channel: roomID, IsListening: isListening, IsPTTSelected: true})
			res := queueBrowserCommand(CompanionCommand{Command: "set_room_matrix", ListenRoomIDs: append([]string(nil), presence.ListenRooms...), TalkRoomIDs: []string{roomID}})
			return res
		}
		s.rememberCompanionHeldTarget(holdKey, roomID)
		go func(roleID, username, roomID, holdKey, triggerKey string) {
			time.Sleep(s.selectListenCompanionHoldDelay())
			heldTargetID, ok := s.companionHeldTarget(holdKey)
			if !ok || heldTargetID != roomID {
				return
			}
			s.rememberCompanionHeldTarget(triggerKey, "1")
			if allowed, err := s.store.RoomAllowsReceiverRole(context.Background(), roomID, roleID); err != nil || !allowed {
				if err != nil {
					s.publishCompanionResult(roleID, CompanionCommandResult{Command: "press_button", OK: false, Status: "failed", Error: err.Error(), Source: "server", Timestamp: time.Now().UnixMilli()})
				}
				return
			}
			presence, _ := s.hub.PresenceForUsername(username)
			currentListening := false
			for _, entry := range presence.ListenRooms {
				if entry == roomID {
					currentListening = true
					break
				}
			}
			nextListening := !currentListening

			filtered := make([]string, 0, len(presence.ListenRooms)+1)
			for _, entry := range presence.ListenRooms {
				if entry != roomID {
					filtered = append(filtered, entry)
				}
			}
			if nextListening {
				filtered = append(filtered, roomID)
			}
			res, err := s.queueCompanionBrowserCommand(username, CompanionCommand{Command: "set_room_matrix", ListenRoomIDs: filtered, TalkRoomIDs: append([]string(nil), presence.TalkRooms...)})
			if err != nil {
				s.publishCompanionResult(roleID, CompanionCommandResult{Command: "press_button", OK: false, Status: "failed", Error: err.Error(), Source: "server", Timestamp: time.Now().UnixMilli()})
				return
			}
			s.publishCompanionResult(roleID, res)
		}(roleID, username, roomID, holdKey, triggerKey)
		result.OK = true
		result.Status = "executed"
		emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "LISTEN", false: "IDLE"}[isListening], Channel: roomID, IsListening: isListening, IsPTTSelected: isPTTSelected})
		return result
	case StreamDeckActionTypePTTSelected:
		targetID := ""
		if phase == "down" {
			for _, roomID := range presence.TalkRooms {
				allowed, err := isRoomTalkAllowed(roomID)
				if err != nil {
					result.Error = err.Error()
					return result
				}
				if allowed {
					targetID = roomID
					break
				}
			}
			if targetID == "" {
				return rejectUnauthorized("no allowed talk room selected")
			}
			s.rememberCompanionHeldTarget(holdKey, targetID)
		} else {
			var ok bool
			targetID, ok = s.companionHeldTarget(holdKey)
			if ok {
				_ = s.consumeCompanionHeldTarget(holdKey)
			}
		}
		if targetID == "" {
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE"})
			result.OK = true
			result.Status = "executed"
			return result
		}
		res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "room", TargetID: targetID, State: map[bool]string{true: "ptt_start", false: "ptt_stop"}[phase == "down"]})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "TALK", false: "IDLE"}[phase == "down"], Channel: targetID})
		return res
	case StreamDeckActionTypeListenRoom:
		roomID := strings.TrimSpace(button.Action.RoomID)
		if roomID == "" {
			return rejectUnauthorized("roomId is required")
		}
		allowed, err := isRoomListenAllowed(roomID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to listen to room")
		}
		if phase != "down" {
			_ = s.consumeCompanionHeldTarget(holdKey)
			stillListening := false
			for _, entry := range presence.ListenRooms {
				if entry == roomID {
					stillListening = true
					break
				}
			}
			emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "LISTEN", false: "IDLE"}[stillListening], Channel: roomID})
			result.OK = true
			result.Status = "executed"
			return result
		}

		s.rememberCompanionHeldTarget(holdKey, roomID)
		currentListening := false
		for _, entry := range presence.ListenRooms {
			if entry == roomID {
				currentListening = true
				break
			}
		}
		nextListening := !currentListening

		filtered := make([]string, 0, len(presence.ListenRooms)+1)
		for _, entry := range presence.ListenRooms {
			if entry != roomID {
				filtered = append(filtered, entry)
			}
		}
		if nextListening {
			filtered = append(filtered, roomID)
		}
		res := queueBrowserCommand(CompanionCommand{Command: "set_room_matrix", ListenRoomIDs: filtered, TalkRoomIDs: append([]string(nil), presence.TalkRooms...)})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "LISTEN", false: "IDLE"}[currentListening], Channel: roomID, IsListening: currentListening})
		return res
	case StreamDeckActionTypeCallRoom:
		roomID := strings.TrimSpace(button.Action.RoomID)
		if roomID == "" {
			return rejectUnauthorized("roomId is required")
		}
		allowed, err := isRoomTalkAllowed(roomID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to talk to room")
		}
		if phase != "down" {
			result.OK = true
			result.Status = "executed"
			return result
		}
		res := queueBrowserCommand(CompanionCommand{Command: "signal", Scope: "room", TargetID: roomID, Signal: "call"})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "TALK", Channel: roomID})
		return res
	case StreamDeckActionTypeDirectUser:
		targetUserID := strings.TrimSpace(button.Action.UserID)
		allowed, err := isDirectUserAllowed(targetUserID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to direct PTT target user")
		}
		if phase == "down" {
			s.rememberCompanionHeldTarget(holdKey, targetUserID)
		} else if heldTargetID, ok := s.companionHeldTarget(holdKey); ok {
			targetUserID = heldTargetID
			_ = s.consumeCompanionHeldTarget(holdKey)
		}
		res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "direct", TargetID: targetUserID, State: map[bool]string{true: "ptt_start", false: "ptt_stop"}[phase == "down"]})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "TALK", false: "IDLE"}[phase == "down"], Channel: strings.TrimSpace(button.Action.UserID)})
		return res
	case StreamDeckActionTypeDirectRole:
		targetRoleID := strings.TrimSpace(button.Action.RoleID)
		allowed, err := isDirectRoleAllowed(targetRoleID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to direct PTT target role")
		}
		if phase == "down" {
			session, ok := s.sessions.LatestForRole(targetRoleID)
			if !ok {
				result.Error = fmt.Sprintf("no active user found for role %s", targetRoleID)
				return result
			}
			s.rememberCompanionHeldTarget(holdKey, session.UserID)
			res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "direct", TargetID: session.UserID, State: "ptt_start"})
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "TALK", Channel: strings.TrimSpace(button.Action.RoleID)})
			return res
		}
		targetID := s.consumeCompanionHeldTarget(holdKey)
		if targetID == "" {
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE", Channel: strings.TrimSpace(button.Action.RoleID)})
			result.OK = true
			result.Status = "executed"
			return result
		}
		res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "direct", TargetID: targetID, State: "ptt_stop"})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE", Channel: strings.TrimSpace(button.Action.RoleID)})
		return res
	case StreamDeckActionTypeReplyToCaller:
		replyLabel, replySubtitle := s.resolveReplyToCallerLabels(*button, username)
		if phase == "down" {
			s.acknowledgeCompanionIncomingCall(username)
			replyUserID, _, ok := s.hub.ReplyTargetForUsername(username)
			if !ok || strings.TrimSpace(replyUserID) == "" {
				result.Error = "no reply target available"
				return result
			}
			allowed, err := isDirectUserAllowed(replyUserID)
			if err != nil {
				result.Error = err.Error()
				return result
			}
			if !allowed {
				return rejectUnauthorized("not allowed to direct PTT reply target")
			}
			s.rememberCompanionHeldTarget(holdKey, replyUserID)
			res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "direct", TargetID: replyUserID, State: "ptt_start"})
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "TALK", Channel: "reply", Label: replyLabel, Subtitle: replySubtitle})
			return res
		}
		targetID := s.consumeCompanionHeldTarget(holdKey)
		if targetID == "" {
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE", Channel: "reply", Label: replyLabel, Subtitle: replySubtitle})
			result.OK = true
			result.Status = "executed"
			return result
		}
		res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "direct", TargetID: targetID, State: "ptt_stop"})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE", Channel: "reply", Label: replyLabel, Subtitle: replySubtitle})
		return res
	case StreamDeckActionTypeIncomingCall:
		if phase == "down" {
			s.acknowledgeCompanionIncomingCall(username)
		}
		label, subtitle := s.resolveIncomingCallIndicatorLabels(*button, username)
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE", Channel: "incoming_call", Label: label, Subtitle: subtitle})
		result.OK = true
		result.Status = "executed"
		return result
	case StreamDeckActionTypeBroadcastPTT:
		groupID := strings.TrimSpace(button.Action.BroadcastGroupID)
		allowed, err := isBroadcastAllowed(groupID)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if !allowed {
			return rejectUnauthorized("not allowed to broadcast to target group")
		}
		if phase == "down" {
			s.rememberCompanionHeldTarget(holdKey, groupID)
		} else if heldTargetID, ok := s.companionHeldTarget(holdKey); ok {
			groupID = heldTargetID
			_ = s.consumeCompanionHeldTarget(holdKey)
		}
		res := queueBrowserCommand(CompanionCommand{Command: "ptt", Scope: "broadcast", TargetID: groupID, State: map[bool]string{true: "ptt_start", false: "ptt_stop"}[phase == "down"]})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: map[bool]string{true: "BROADCAST", false: "IDLE"}[phase == "down"], Channel: strings.TrimSpace(button.Action.BroadcastGroupID)})
		return res
	case StreamDeckActionTypeVolumeDelta:
		if phase != "down" {
			emitCompanionButtonImage(page.Page, button, ButtonState{State: "IDLE"})
			result.OK = true
			result.Status = "executed"
			return result
		}
		res := queueBrowserCommand(CompanionCommand{Command: "input_gain_delta", VolumeDelta: button.Action.VolumeDelta})
		emitCompanionButtonImage(page.Page, button, ButtonState{State: "LISTEN"})
		return res
	default:
		result.Error = "unsupported button action"
		return result
	}
}

func (s *Server) emitCompanionCurrentPageImages(ctx context.Context, roleID string, username string) {
	if s.imageStreamCoord == nil || strings.TrimSpace(roleID) == "" {
		return
	}

	settings, err := s.store.GetRoleStreamDeckSettings(ctx, roleID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			settings = DefaultStreamDeckSettings()
		} else {
			return
		}
	}
	settings = s.companionResolvedSettings(ctx, roleID, settings)

	currentPage := s.currentCompanionPage(ctx, roleID)
	renderUsername := strings.TrimSpace(username)
	if renderUsername == "" {
		if session, ok := s.sessions.LatestForRole(strings.TrimSpace(roleID)); ok {
			renderUsername = strings.TrimSpace(session.Username)
		}
	}
	presence, _ := s.hub.PresenceForUsername(renderUsername)
	runtimePage := s.resolveCompanionRuntimePage(ctx, roleID, settings, currentPage)
	page := runtimePage.Page

	for i := range page.Buttons {
		button := &page.Buttons[i]
		state := s.companionButtonSnapshotState(ctx, roleID, page.Page, renderUsername, presence, *button)
		s.emitCompanionButtonImage(ctx, roleID, renderUsername, page.Page, button, state)
	}
}

func (s *Server) emitCompanionButtonImage(ctx context.Context, roleID string, username string, bank int, button *StreamDeckButtonConfig, state ButtonState) {
	if s.imageStreamCoord == nil || button == nil {
		return
	}
	if strings.TrimSpace(state.State) == "" {
		state.State = "IDLE"
	}
	if strings.TrimSpace(state.ActionType) == "" && button.Action != nil {
		state.ActionType = string(button.Action.Type)
	}
	if strings.TrimSpace(state.Color) == "" {
		state.Color = strings.TrimSpace(button.Color)
	}
	if !state.IsListening {
		state.IsListening = state.State == "LISTEN"
	}
	if strings.TrimSpace(state.Label) == "" {
		primary, subtitle := s.resolveButtonLabel(ctx, *button)
		state.Label = primary
		state.Subtitle = subtitle
	}
	if strings.TrimSpace(state.Channel) == "" && button.Action != nil {
		state.Channel = companionButtonChannel(*button)
	}
	s.imageStreamCoord.BroadcastImageUpdateForTarget(roleID, username, state, bank, button.Index)
}

func (s *Server) resolveReplyToCallerLabels(button StreamDeckButtonConfig, username string) (primary, subtitle string) {
	primary = "Reply"
	if raw := strings.TrimSpace(button.Label); raw != "" {
		parts := strings.SplitN(raw, "\n", 2)
		if line := strings.TrimSpace(parts[0]); line != "" {
			primary = line
		}
	}
	if s.hub == nil || strings.TrimSpace(username) == "" {
		return primary, "No active caller"
	}
	_, replyUsername, ok := s.hub.ReplyTargetForUsername(username)
	if !ok || strings.TrimSpace(replyUsername) == "" {
		return primary, "No active caller"
	}
	return strings.TrimSpace(replyUsername), primary
}

func (s *Server) resolveIncomingCallIndicatorLabels(button StreamDeckButtonConfig, username string) (primary, subtitle string) {
	primary = "Incoming"
	if raw := strings.TrimSpace(button.Label); raw != "" {
		parts := strings.SplitN(raw, "\n", 2)
		if line := strings.TrimSpace(parts[0]); line != "" {
			primary = line
		}
	}
	if strings.TrimSpace(username) == "" {
		return primary, ""
	}
	if signalFrom, _, _, _, _, signalActive := s.companionIncomingSignal(strings.TrimSpace(username)); signalActive {
		s.setCompanionPendingIncomingCaller(strings.TrimSpace(username), signalFrom)
		if strings.TrimSpace(signalFrom) != "" {
			return primary, strings.TrimSpace(signalFrom)
		}
	}
	if caller, ok := s.companionPendingIncomingCaller(strings.TrimSpace(username)); ok {
		return primary, caller
	}
	return primary, ""
}

// resolveButtonLabel resolves the display label and optional subtitle for a button,
// mirroring the logic in web/src/lib/streamDeckLabels.ts.
func (s *Server) resolveButtonLabel(ctx context.Context, button StreamDeckButtonConfig) (primary, subtitle string) {
	// Static label set directly in config takes priority (first line = primary, second = subtitle)
	if raw := strings.TrimSpace(button.Label); raw != "" {
		parts := strings.SplitN(raw, "\n", 2)
		primary = strings.TrimSpace(parts[0])
		if len(parts) > 1 {
			subtitle = strings.TrimSpace(parts[1])
		}
		return
	}

	if button.Action == nil || button.Action.Type == StreamDeckActionTypeNone {
		return
	}

	if s.store == nil {
		return fallbackButtonLabel(button.Action.Type), ""
	}

	action := button.Action
	switch action.Type {
	case StreamDeckActionTypePTTRoom, StreamDeckActionTypeSelectTalkRoom,
		StreamDeckActionTypeSelectListen,
		StreamDeckActionTypeListenRoom, StreamDeckActionTypeCallRoom:
		if rooms, err := s.store.ListRooms(ctx); err == nil {
			for _, r := range rooms {
				if r.ID == strings.TrimSpace(action.RoomID) {
					return r.Name, ""
				}
			}
		}
		return strings.TrimSpace(action.RoomID), ""

	case StreamDeckActionTypeDirectUser:
		if users, err := s.store.ListUsers(ctx); err == nil {
			for _, u := range users {
				if u.ID == strings.TrimSpace(action.UserID) {
					roleName := ""
					if roles, err2 := s.store.ListRoles(ctx); err2 == nil {
						for _, role := range roles {
							if role.ID == u.RoleID {
								roleName = role.Name
								break
							}
						}
					}
					if roleName != "" {
						return u.Username, roleName
					}
					return u.Username, ""
				}
			}
		}
		return strings.TrimSpace(action.UserID), ""

	case StreamDeckActionTypeDirectRole:
		roleName := strings.TrimSpace(action.RoleID)
		if roles, err := s.store.ListRoles(ctx); err == nil {
			for _, r := range roles {
				if r.ID == strings.TrimSpace(action.RoleID) {
					roleName = r.Name
					break
				}
			}
		}
		// Show the active user for this role as primary if one is online
		if session, ok := s.sessions.LatestForRole(strings.TrimSpace(action.RoleID)); ok {
			return session.Username, roleName
		}
		return roleName, ""

	case StreamDeckActionTypeBroadcastPTT:
		if groups, err := s.store.ListBroadcastGroups(ctx); err == nil {
			for _, g := range groups {
				if g.ID == strings.TrimSpace(action.BroadcastGroupID) {
					return g.Name, ""
				}
			}
		}
		return strings.TrimSpace(action.BroadcastGroupID), ""

	case StreamDeckActionTypeReplyToCaller:
		return s.resolveReplyToCallerLabels(button, "")

	case StreamDeckActionTypeIncomingCall:
		return "Incoming", ""

	case StreamDeckActionTypePTTSelected:
		return "PTT", ""
	case StreamDeckActionTypeMuteToggle:
		return "Mute", ""
	case StreamDeckActionTypeVolumeDelta:
		return "Volume", ""
	case StreamDeckActionTypePageUp:
		return "Page +", ""
	case StreamDeckActionTypePageDown:
		return "Page -", ""
	case StreamDeckActionTypePageHome:
		return "Home", ""
	case StreamDeckActionTypePageJump:
		if action.TargetPage >= 0 {
			return fmt.Sprintf("Page %d", action.TargetPage+1), ""
		}
		return "Jump", ""
	}
	return fallbackButtonLabel(action.Type), ""
}

func fallbackButtonLabel(actionType StreamDeckActionType) string {
	return string(actionType)
}

func companionButtonChannel(button StreamDeckButtonConfig) string {
	if button.Action == nil {
		return ""
	}
	action := button.Action
	if strings.TrimSpace(action.RoomID) != "" {
		return strings.TrimSpace(action.RoomID)
	}
	if strings.TrimSpace(action.BroadcastGroupID) != "" {
		return strings.TrimSpace(action.BroadcastGroupID)
	}
	if strings.TrimSpace(action.UserID) != "" {
		return strings.TrimSpace(action.UserID)
	}
	if strings.TrimSpace(action.RoleID) != "" {
		return strings.TrimSpace(action.RoleID)
	}
	if action.Type == StreamDeckActionTypeIncomingCall {
		return "incoming_call"
	}
	return string(action.Type)
}

func (s *Server) queueCompanionBrowserCommand(username string, command CompanionCommand) (CompanionCommandResult, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return CompanionCommandResult{}, errors.New("target unavailable")
	}
	token, ok := s.hub.LatestTokenForUsername(username)
	if !ok {
		return CompanionCommandResult{}, errors.New("target unavailable")
	}
	sent := s.hub.SendToToken(token, WSOutbound{Type: "companion_command", Data: command})
	if !sent {
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

func (s *Server) handleCompanionDiscovery(w http.ResponseWriter, r *http.Request) {
	if !s.requireCompanionSecret(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("username")) != "" {
		http.Error(w, "username query parameter is no longer supported; use roleId", http.StatusBadRequest)
		return
	}
	roleID := strings.TrimSpace(r.URL.Query().Get("roleId"))
	targetUser, err := s.resolveCompanionTargetUser(r.Context(), roleID)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			http.Error(w, "roleId parameter required unless exactly one profile is published", http.StatusBadRequest)
			return
		}
		if errors.Is(err, ErrConflict) {
			http.Error(w, "multiple published profiles found; provide roleId", http.StatusConflict)
			return
		}
		if errors.Is(err, errCompanionUserNotAllowed) {
			http.Error(w, "role target user is not allowed for companion control", http.StatusForbidden)
			return
		}
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "unknown roleId", http.StatusNotFound)
			return
		}
		s.internalErr(w, err)
		return
	}
	profileResp, err := s.buildCompanionProfileResponse(r.Context(), targetUser)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	profileVersion := 0
	profileStatus := "unpublished"
	profileUpdatedAt := int64(0)
	if storedProfile, err := s.store.GetCompanionProfileByRole(r.Context(), targetUser.RoleID); err == nil {
		profileVersion = storedProfile.ProfileVersion
		profileStatus = storedProfile.ProfileStatus
		profileUpdatedAt = storedProfile.ProfileUpdatedAt
	}
	s.writeJSON(w, http.StatusOK, CompanionDiscoveryResponse{
		Username:          profileResp.Username,
		RoleID:            profileResp.RoleID,
		Rooms:             profileResp.Rooms,
		Users:             profileResp.Users,
		ActiveRoleUsers:   profileResp.ActiveRoleUsers,
		BroadcastGroups:   profileResp.BroadcastGroups,
		CurrentPageNumber: s.currentCompanionPage(r.Context(), targetUser.RoleID),
		ProfileVersion:    profileVersion,
		ProfileStatus:     profileStatus,
		ProfileUpdatedAt:  profileUpdatedAt,
	})
}

func (s *Server) handleHTTPRedirectToHTTPS(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if parsedHost, _, err := net.SplitHostPort(r.Host); err == nil && parsedHost != "" {
		host = parsedHost
	}
	http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
}

// sendNativeAudioEndpoint emits the native_audio_endpoint WS message to a
// connecting native client so it can REGISTER with the UDP relay and start
// sending Opus frames immediately. The host is derived from the explicit
// UDPAudioAdvertiseIP config when set, otherwise from the request's Host
// header so LAN clients reach the same address they used for HTTP.
func (s *Server) sendNativeAudioEndpoint(token string, r *http.Request) {
	if s.udpAudio == nil {
		return
	}
	local := s.udpAudio.LocalAddr()
	if local == nil {
		return
	}
	udpAddr, ok := local.(*net.UDPAddr)
	if !ok {
		return
	}
	host := strings.TrimSpace(s.cfg.UDPAudioAdvertiseIP)
	if host == "" {
		if h, _, err := net.SplitHostPort(r.Host); err == nil && h != "" {
			host = h
		} else {
			host = r.Host
		}
	}
	if host == "" {
		host = "127.0.0.1"
	}
	s.hub.SendToToken(token, WSOutbound{Type: "audio_mode", Data: AudioModeInfo{Mode: "native"}})
	s.hub.SendToToken(token, WSOutbound{
		Type: "native_audio_endpoint",
		Data: NativeAudioEndpoint{
			Host:          host,
			Port:          udpAddr.Port,
			Token:         token,
			TokenHash:     HashSessionToken(token),
			FrameDuration: 5,
			SampleRate:    48000,
			Channels:      1,
		},
	})
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
	adminLogs, err := newAdminLogStore(cfg)
	if err != nil {
		return nil, err
	}
	if cfg.AdminPINFromEnv {
		if err := store.SetAdminPIN(context.Background(), cfg.AdminPIN); err != nil {
			return nil, err
		}
	}
	s := &Server{
		cfg:                              cfg,
		logger:                           logger,
		adminLogs:                        adminLogs,
		store:                            store,
		sessions:                         NewSessionManager(cfg.SessionTTL),
		hub:                              NewHub(store, logger),
		companionWS:                      make(map[string]map[chan CompanionCommandResult]struct{}),
		companionState:                   make(map[string]map[chan struct{}]struct{}),
		companionPageByRole:              make(map[string]int),
		companionPageButtonDown:          make(map[string]bool),
		companionPageNavAnchorByRole:     make(map[string]int),
		companionHeldTargets:             make(map[string]string),
		companionPendingCallByUser:       make(map[string]bool),
		companionPendingCallerByUser:     make(map[string]string),
		companionPendingCallScopeByUser:  make(map[string]string),
		companionPendingCallSourceByUser: make(map[string]string),
		companionAckedSignalByUser:       make(map[string]string),
		ackEnabled:                       true,
		ackSet:                           true,
		upgrader: websocket.Upgrader{
			CheckOrigin:      func(r *http.Request) bool { return true },
			HandshakeTimeout: 10 * time.Second,
		},
	}
	s.media = NewMediaManager(s.hub, logger)
	s.hub.SetMediaManager(s.media)
	// Native UDP audio relay (performance mode). When the listen address is
	// empty in config, we skip relay startup; native clients then transparently
	// fall back to the WebRTC pipeline.
	if strings.TrimSpace(cfg.UDPAudioAddr) != "" {
		s.udpAudio = NewUDPAudioRelay(s.hub, logger)
		if err := s.udpAudio.Start(cfg.UDPAudioAddr); err != nil {
			logger.Warn("udp audio relay failed to start, falling back to webrtc-only", "error", err)
			s.udpAudio = nil
		} else {
			s.media.SetUDPAudioRelay(s.udpAudio)
			s.hub.SetUDPAudioRelay(s.udpAudio)
		}
	}
	if cfg.TelegramBotToken != "" {
		s.telegram = NewTelegramBot(cfg.TelegramBotToken, cfg.TelegramWebhookSecret, cfg.TelegramMode, store, s.hub, logger)
	}
	// Initialize image stream coordinator for Companion module
	imageStreamCoord, err := NewImageStreamCoordinator(logger)
	if err != nil {
		logger.Warn("failed to initialize image stream coordinator", "error", err)
	} else {
		s.imageStreamCoord = imageStreamCoord
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
	mux.HandleFunc("/api/user/stream-deck/preview", s.withAuth(s.handleUserStreamDeckPreview))
	mux.HandleFunc("/api/admin/stream-deck/settings", s.withAuth(s.handleAdminRoleStreamDeckSettings))
	mux.HandleFunc("/api/admin/companion/config", s.withAuth(s.handleAdminCompanionConfig))
	mux.HandleFunc("/api/companion/profile", s.handleCompanionProfile)
	mux.HandleFunc("/api/admin/companion/publish", s.withAuth(s.handleAdminCompanionPublish))
	mux.HandleFunc("/api/admin/companion/role-pages", s.withAuth(s.handleAdminCompanionRolePages))
	mux.HandleFunc("/api/user/companion/publish", s.withAuth(s.handleUserCompanionPublish))
	mux.HandleFunc("/api/admin/roles", s.withAuth(s.handleAdminRoles))
	mux.HandleFunc("/api/admin/roles/", s.withAuth(s.handleAdminRoleByID))
	mux.HandleFunc("/api/admin/users", s.withAuth(s.handleAdminUsers))
	mux.HandleFunc("/api/admin/users/", s.withAuth(s.handleAdminUserByID))
	mux.HandleFunc("/api/admin/rooms", s.withAuth(s.handleAdminRooms))
	mux.HandleFunc("/api/admin/rooms/", s.withAuth(s.handleAdminRoomByID))
	// backwards-compatible aliases using new terminology
	mux.HandleFunc("/api/admin/party-lines", s.withAuth(s.handleAdminRooms))
	mux.HandleFunc("/api/admin/party-lines/", s.withAuth(s.handleAdminRoomByID))
	mux.HandleFunc("/api/admin/broadcast-groups", s.withAuth(s.handleAdminBroadcastGroups))
	mux.HandleFunc("/api/admin/broadcast-groups/", s.withAuth(s.handleAdminBroadcastGroupByID))
	mux.HandleFunc("/api/admin/pin", s.withAuth(s.handleAdminPin))
	mux.HandleFunc("/api/admin/logs", s.withAuth(s.handleAdminLogs))
	mux.HandleFunc("/api/admin/logs/export", s.withAuth(s.handleAdminLogsExport))
	mux.HandleFunc("/api/admin/chat-history/clear", s.withAuth(s.handleAdminClearChatHistory))
	mux.HandleFunc("/api/admin/ack-settings", s.withAuth(s.handleAdminAckSettings))
	mux.HandleFunc("/api/admin/birthday-users", s.withAuth(s.handleAdminBirthdayUsers))
	mux.HandleFunc("/api/admin/configuration-export", s.withAuth(s.handleAdminConfigurationExport))
	mux.HandleFunc("/api/admin/configuration-import", s.withAuth(s.handleAdminConfigurationImport))
	mux.HandleFunc("/api/admin/routing-matrix", s.withAuth(s.handleAdminRoutingMatrix))
	mux.HandleFunc("/api/companion/discovery", s.handleCompanionDiscovery)
	mux.HandleFunc("/api/companion/ws", s.handleCompanionWS)
	mux.HandleFunc("/api/image-stream", s.HandleImageStreamWebSocket)
	mux.HandleFunc("/api/debug/button-image", s.HandleDebugButtonImage)
	mux.HandleFunc("/api/debug/button-image-preview", s.HandleDebugButtonImagePreview)
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
		Handler:           s.withRequestLogging(s.withCORS(mux)),
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
	s.writeJSON(w, http.StatusOK, LoginResponse{
		Token:                session.Token,
		User:                 user,
		ShowBirthdayGreeting: s.shouldShowBirthdayGreeting(r.Context(), req.Username),
	})
}

func (s *Server) shouldShowBirthdayGreeting(ctx context.Context, username string) bool {
	users, err := s.store.GetBirthdayUsersToday(ctx)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("birthday user list lookup failed", "error", err)
		}
		return false
	}
	for _, entry := range users {
		if strings.EqualFold(entry, username) {
			return true
		}
	}
	return false
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
	s.writeJSON(w, http.StatusOK, LoginResponse{
		Token:                session.Token,
		User:                 user,
		ShowBirthdayGreeting: s.shouldShowBirthdayGreeting(r.Context(), req.Username),
	})
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
		settings, err := s.store.GetRoleStreamDeckSettings(r.Context(), session.RoleID)
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
		saved, err := s.store.UpsertUserStreamDeckSettings(r.Context(), session.UserID, req)
		if err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		targetUser, err := s.store.FindUserByID(r.Context(), session.UserID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				http.Error(w, "unknown user", http.StatusNotFound)
				return
			}
			s.internalErr(w, err)
			return
		}
		profile, err := s.buildCompanionProfileResponse(r.Context(), targetUser)
		if err != nil {
			s.internalErr(w, err)
			return
		}
		if _, err := s.store.PublishCompanionProfile(r.Context(), targetUser.RoleID, session.UserID, profile); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.resetCompanionCurrentPage(session.RoleID)
		s.writeJSON(w, http.StatusOK, saved)
	case http.MethodDelete:
		err := s.store.DeleteUserStreamDeckSettings(r.Context(), session.UserID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		targetUser, err := s.store.FindUserByID(r.Context(), session.UserID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				http.Error(w, "unknown user", http.StatusNotFound)
				return
			}
			s.internalErr(w, err)
			return
		}
		profile, err := s.buildCompanionProfileResponse(r.Context(), targetUser)
		if err != nil {
			s.internalErr(w, err)
			return
		}
		if _, err := s.store.PublishCompanionProfile(r.Context(), targetUser.RoleID, session.UserID, profile); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.resetCompanionCurrentPage(session.RoleID)
		s.writeJSON(w, http.StatusOK, DefaultStreamDeckSettings())
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminRoleStreamDeckSettings(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	roleID := strings.TrimSpace(r.URL.Query().Get("roleId"))
	if roleID == "" {
		http.Error(w, "roleId required", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		settings, err := s.store.GetRoleStreamDeckSettings(r.Context(), roleID)
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
		var req struct {
			Settings StreamDeckSettings `json:"settings"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		settings, err := s.store.UpsertRoleStreamDeckSettings(r.Context(), roleID, req.Settings)
		if err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.resetCompanionCurrentPage(roleID)
		s.writeJSON(w, http.StatusOK, settings)
	case http.MethodDelete:
		err := s.store.DeleteRoleStreamDeckSettings(r.Context(), roleID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.resetCompanionCurrentPage(roleID)
		s.writeJSON(w, http.StatusOK, DefaultStreamDeckSettings())
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

type publishCompanionProfileRequest struct {
	RoleID string `json:"roleId"`
}

func (s *Server) handleAdminCompanionConfig(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	usernameByRoleID := make(map[string]string, len(users))
	for _, user := range users {
		roleID := strings.TrimSpace(user.RoleID)
		if roleID == "" {
			continue
		}
		if _, exists := usernameByRoleID[roleID]; !exists {
			usernameByRoleID[roleID] = user.Username
		}
	}
	roleIDs := make([]string, 0, len(usernameByRoleID))
	for roleID := range usernameByRoleID {
		roleIDs = append(roleIDs, roleID)
	}
	sort.Strings(roleIDs)
	publishedProfiles := make([]CompanionPublishedProfileSummary, 0, len(roleIDs))
	for _, roleID := range roleIDs {
		profile, err := s.store.GetCompanionProfileByRole(r.Context(), roleID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			s.internalErr(w, err)
			return
		}
		publishedProfiles = append(publishedProfiles, CompanionPublishedProfileSummary{
			RoleID:           roleID,
			Username:         profile.Username,
			ProfileVersion:   profile.ProfileVersion,
			ProfileStatus:    profile.ProfileStatus,
			ProfileUpdatedAt: profile.ProfileUpdatedAt,
		})
	}
	s.writeJSON(w, http.StatusOK, CompanionAdminSummaryResponse{
		SharedSecret:      s.cfg.CompanionSharedSecret,
		PublishedProfiles: publishedProfiles,
	})
}

func (s *Server) handleAdminCompanionPublish(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req publishCompanionProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	roleID := strings.TrimSpace(req.RoleID)
	if roleID == "" {
		roleID = strings.TrimSpace(session.RoleID)
	}
	if roleID == "" {
		http.Error(w, "roleId required", http.StatusBadRequest)
		return
	}
	targetUser, err := s.resolveCompanionTargetUser(r.Context(), roleID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "unknown roleId", http.StatusNotFound)
			return
		}
		s.internalErr(w, err)
		return
	}
	profile, err := s.buildCompanionProfileResponse(r.Context(), targetUser)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	published, err := s.store.PublishCompanionProfile(r.Context(), roleID, session.UserID, profile)
	if err != nil {
		if s.writeStoreErr(w, err) {
			return
		}
		s.internalErr(w, err)
		return
	}
	s.resetCompanionCurrentPage(roleID)
	s.writeJSON(w, http.StatusOK, published)
}

type companionRolePageRequest struct {
	RoleID     string `json:"roleId"`
	PageNumber int    `json:"pageNumber"`
}

type companionRolePageResponse struct {
	RoleID     string `json:"roleId"`
	PageNumber int    `json:"pageNumber"`
}

type companionRolePagesResponse struct {
	RolePages map[string]int `json:"rolePages"`
}

func (s *Server) handleAdminCompanionRolePages(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}

	if r.Method == http.MethodPost {
		var req companionRolePageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		roleID := strings.TrimSpace(req.RoleID)
		if roleID == "" {
			http.Error(w, "roleId required", http.StatusBadRequest)
			return
		}
		if err := s.store.SaveCompanionRolePage(r.Context(), roleID, req.PageNumber); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, companionRolePageResponse{
			RoleID:     roleID,
			PageNumber: req.PageNumber,
		})
	} else if r.Method == http.MethodGet {
		rolePages, err := s.store.GetAllCompanionRolePages(r.Context())
		if err != nil {
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, companionRolePagesResponse{
			RolePages: rolePages,
		})
	} else {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleUserCompanionPublish(w http.ResponseWriter, r *http.Request, session Session) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user, err := s.store.FindUserByID(r.Context(), session.UserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "unknown user", http.StatusNotFound)
			return
		}
		s.internalErr(w, err)
		return
	}
	profile, err := s.buildCompanionProfileResponse(r.Context(), user)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	published, err := s.store.PublishCompanionProfile(r.Context(), user.RoleID, session.UserID, profile)
	if err != nil {
		if s.writeStoreErr(w, err) {
			return
		}
		s.internalErr(w, err)
		return
	}
	s.resetCompanionCurrentPage(user.RoleID)
	s.writeJSON(w, http.StatusOK, published)
}

func (s *Server) requireCompanionSecret(w http.ResponseWriter, r *http.Request) bool {
	expected := strings.TrimSpace(s.cfg.CompanionSharedSecret)
	if expected == "" {
		return true
	}
	presented := strings.TrimSpace(r.Header.Get("X-Companion-Secret"))
	if presented == "" {
		presented = strings.TrimSpace(r.URL.Query().Get("secret"))
	}
	if subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	return true
}

func (s *Server) handleCompanionProfile(w http.ResponseWriter, r *http.Request) {
	if !s.requireCompanionSecret(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("username")) != "" {
		http.Error(w, "username query parameter is no longer supported; use roleId", http.StatusBadRequest)
		return
	}
	roleID := strings.TrimSpace(r.URL.Query().Get("roleId"))
	targetUser, err := s.resolveCompanionTargetUser(r.Context(), roleID)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			http.Error(w, "roleId required unless exactly one profile is published", http.StatusBadRequest)
			return
		}
		if errors.Is(err, ErrConflict) {
			http.Error(w, "multiple published profiles found; provide roleId", http.StatusConflict)
			return
		}
		if errors.Is(err, errCompanionUserNotAllowed) {
			http.Error(w, "role target user is not allowed for companion control", http.StatusForbidden)
			return
		}
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "unknown roleId", http.StatusNotFound)
			return
		}
		s.internalErr(w, err)
		return
	}
	profile, err := s.store.GetCompanionProfileByRole(r.Context(), targetUser.RoleID)
	if err == nil {
		profile.CurrentPageNumber = s.currentCompanionPage(r.Context(), targetUser.RoleID)
		s.writeJSON(w, http.StatusOK, profile)
		return
	}
	if !errors.Is(err, ErrNotFound) {
		s.internalErr(w, err)
		return
	}
	fallback, err := s.buildCompanionProfileResponse(r.Context(), targetUser)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	fallback.ProfileStatus = "unpublished"
	fallback.CurrentPageNumber = s.currentCompanionPage(r.Context(), targetUser.RoleID)
	s.writeJSON(w, http.StatusOK, fallback)
}

func (s *Server) companionUsernameAllowed(username string) bool {
	allowed := s.cfg.CompanionAllowedUsernames
	if len(allowed) == 0 {
		return true
	}
	for _, entry := range allowed {
		if strings.EqualFold(strings.TrimSpace(entry), strings.TrimSpace(username)) {
			return true
		}
	}
	return false
}

func (s *Server) resolveCompanionTargetUser(ctx context.Context, roleID string) (User, error) {
	if roleID == "" {
		autoRoleID, err := s.store.ResolveSinglePublishedCompanionRole(ctx)
		if err != nil {
			if errors.Is(err, ErrConflict) {
				return User{}, ErrConflict
			}
			if errors.Is(err, ErrNotFound) {
				return User{}, ErrInvalidInput
			}
			return User{}, err
		}
		roleID = autoRoleID
	}
	allUsers, err := s.store.ListUsers(ctx)
	if err != nil {
		return User{}, err
	}
	for i := range allUsers {
		if strings.TrimSpace(allUsers[i].RoleID) == strings.TrimSpace(roleID) {
			if !s.companionUsernameAllowed(allUsers[i].Username) {
				return User{}, errCompanionUserNotAllowed
			}
			return allUsers[i], nil
		}
	}

	knownRole, err := s.store.RoleExists(ctx, strings.TrimSpace(roleID))
	if err != nil {
		return User{}, err
	}
	if !knownRole {
		return User{}, ErrNotFound
	}

	return User{RoleID: strings.TrimSpace(roleID), Username: strings.TrimSpace(roleID)}, nil
}

func (s *Server) buildCompanionProfileResponse(ctx context.Context, targetUser User) (CompanionProfileResponse, error) {
	rooms, err := s.store.ListRooms(ctx)
	if err != nil {
		return CompanionProfileResponse{}, err
	}
	users, err := s.store.ListUsers(ctx)
	if err != nil {
		return CompanionProfileResponse{}, err
	}
	roleIDs := make(map[string]struct{}, len(users))
	for _, user := range users {
		rid := strings.TrimSpace(user.RoleID)
		if rid == "" {
			continue
		}
		roleIDs[rid] = struct{}{}
	}
	activeRoleUsers := make([]CompanionRoleUser, 0, len(roleIDs))
	for rid := range roleIDs {
		session, ok := s.sessions.LatestForRole(rid)
		if !ok {
			continue
		}
		activeRoleUsers = append(activeRoleUsers, CompanionRoleUser{
			RoleID:   rid,
			Username: session.Username,
			UserID:   session.UserID,
		})
	}
	sort.Slice(activeRoleUsers, func(i, j int) bool {
		return activeRoleUsers[i].RoleID < activeRoleUsers[j].RoleID
	})
	groups, err := s.store.ListBroadcastGroups(ctx)
	if err != nil {
		return CompanionProfileResponse{}, err
	}
	groups = filterBroadcastGroupsForRole(targetUser.RoleID, groups)
	roomDiscovery := make([]CompanionRoomDiscovery, 0, len(rooms))
	for _, room := range rooms {
		canTalk, err := s.store.RoomAllowsSenderRole(ctx, room.ID, targetUser.RoleID)
		if err != nil {
			continue
		}
		canListen, err := s.store.RoomAllowsReceiverRole(ctx, room.ID, targetUser.RoleID)
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
	settings, err := s.store.GetRoleStreamDeckSettings(ctx, targetUser.RoleID)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			return CompanionProfileResponse{}, err
		}
		settings = DefaultStreamDeckSettings()
	}
	settings = s.companionResolvedSettings(ctx, targetUser.RoleID, settings)
	pageNumber, err := s.store.GetCompanionRolePage(ctx, targetUser.RoleID)
	if err != nil {
		return CompanionProfileResponse{}, err
	}
	return CompanionProfileResponse{
		RoleID:            targetUser.RoleID,
		Username:          targetUser.Username,
		PageNumber:        pageNumber,
		CurrentPageNumber: s.currentCompanionPage(ctx, targetUser.RoleID),
		Rooms:             roomDiscovery,
		Users:             users,
		ActiveRoleUsers:   activeRoleUsers,
		BroadcastGroups:   groups,
		StreamDeck:        settings,
	}, nil
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
	PriorityLevel       *int     `json:"priorityLevel,omitempty"`
	SenderRoleIDs       []string `json:"senderRoleIds"`
	ReceiverRoleIDs     []string `json:"receiverRoleIds"`
	ForcedListenRoleIDs []string `json:"forcedListenRoleIds"`
}

type upsertBroadcastGroupRequest struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	PriorityLevel  *int     `json:"priorityLevel,omitempty"`
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

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	activeClients := map[string]struct{}{}
	if s.hub != nil {
		for _, c := range s.hub.GetActiveClients(r.Context()) {
			activeClients[c.Username] = struct{}{}
		}
	}
	views := make([]AdminUserView, 0, len(users))
	for _, u := range users {
		_, online := activeClients[u.Username]
		views = append(views, AdminUserView{
			ID:       u.ID,
			Username: u.Username,
			RoleID:   u.RoleID,
			Online:   online,
		})
	}
	s.writeJSON(w, http.StatusOK, views)
}

func (s *Server) handleAdminUserByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	userID := strings.TrimPrefix(r.URL.Path, "/api/admin/users/")
	if userID == "" || strings.Contains(userID, "/") {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		user, err := s.store.FindUserByID(r.Context(), userID)
		if err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		if s.hub != nil {
			for _, c := range s.hub.GetActiveClients(r.Context()) {
				if c.Username == user.Username {
					http.Error(w, "user is currently active", http.StatusConflict)
					return
				}
			}
		}
		s.sessionMu.Lock()
		s.sessions.DeleteByUsername(user.Username)
		s.sessionMu.Unlock()
		if err := s.store.DeleteUser(r.Context(), userID); err != nil {
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
		if req.PriorityLevel != nil {
			if err := s.store.SetRoomPriorityLevel(r.Context(), req.ID, *req.PriorityLevel); err != nil {
				if s.writeStoreErr(w, err) {
					return
				}
				s.internalErr(w, err)
				return
			}
		}
		// Broadcast updated config to all clients
		if s.hub != nil {
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
		if req.PriorityLevel != nil {
			if err := s.store.SetRoomPriorityLevel(r.Context(), roomID, *req.PriorityLevel); err != nil {
				if s.writeStoreErr(w, err) {
					return
				}
				s.internalErr(w, err)
				return
			}
		}
		// Broadcast updated config to all clients
		if s.hub != nil {
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
		if req.PriorityLevel != nil {
			if err := s.store.SetBroadcastGroupPriorityLevel(r.Context(), req.ID, *req.PriorityLevel); err != nil {
				if s.writeStoreErr(w, err) {
					return
				}
				s.internalErr(w, err)
				return
			}
		}
		// Broadcast updated config to all clients
		if s.hub != nil {
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
		if req.PriorityLevel != nil {
			if err := s.store.SetBroadcastGroupPriorityLevel(r.Context(), groupID, *req.PriorityLevel); err != nil {
				if s.writeStoreErr(w, err) {
					return
				}
				s.internalErr(w, err)
				return
			}
		}
		// Broadcast updated config to all clients
		if s.hub != nil {
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
	s.logAdminAction(session, r.Method, r.URL.Path, "admin pin updated", http.StatusOK)
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
	s.logAdminAction(session, r.Method, r.URL.Path, "chat history cleared", http.StatusOK)
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

type birthdayUsersTodayRequest struct {
	Usernames []string `json:"usernames"`
}

type birthdayUsersTodayResponse struct {
	Usernames []string `json:"usernames"`
}

func (s *Server) handleAdminBirthdayUsers(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		users, err := s.store.GetBirthdayUsersToday(r.Context())
		if err != nil {
			s.internalErr(w, err)
			return
		}
		s.writeJSON(w, http.StatusOK, birthdayUsersTodayResponse{Usernames: users})
	case http.MethodPut:
		var req birthdayUsersTodayRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.SetBirthdayUsersToday(r.Context(), req.Usernames); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
		users, err := s.store.GetBirthdayUsersToday(r.Context())
		if err != nil {
			s.internalErr(w, err)
			return
		}
		s.logAdminAction(session, r.Method, r.URL.Path, "birthday user list updated", http.StatusOK)
		s.writeJSON(w, http.StatusOK, birthdayUsersTodayResponse{Usernames: users})
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
	s.logAdminAction(session, r.Method, r.URL.Path, "configuration exported", http.StatusOK)
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
		if s.logger != nil {
			s.logger.Warn("configuration import rejected",
				"admin", session.Username,
				"requestedSections", req.Sections,
				"documentSections", req.Document.Meta.Sections,
				"error", err.Error(),
			)
		}
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
	s.logAdminAction(session, r.Method, r.URL.Path, "configuration imported", http.StatusOK)
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

		// Automatically create or upsert the Kesher user with the internal telegram role.
		_, err := s.store.UpsertUser(r.Context(), req.KesherUsername, telegramVirtualRoleID)
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
		s.appendAdminLog(AdminLogEntry{
			TimestampUnixMs: time.Now().UnixMilli(),
			Level:           "WARN",
			Category:        "error",
			Message:         "store error",
			Error:           err.Error(),
		})
		http.Error(w, "invalid input", http.StatusBadRequest)
		return true
	case errors.Is(err, ErrConflict):
		s.appendAdminLog(AdminLogEntry{
			TimestampUnixMs: time.Now().UnixMilli(),
			Level:           "WARN",
			Category:        "error",
			Message:         "store conflict",
			Error:           err.Error(),
		})
		http.Error(w, "conflict", http.StatusConflict)
		return true
	case errors.Is(err, ErrNotFound):
		s.appendAdminLog(AdminLogEntry{
			TimestampUnixMs: time.Now().UnixMilli(),
			Level:           "WARN",
			Category:        "error",
			Message:         "store not found",
			Error:           err.Error(),
		})
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
		s.sessions.CancelScheduledDisconnectLogout(session.Token)
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
	s.sessions.CancelScheduledDisconnectLogout(session.Token)
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
	// Transport selection: native Tauri clients pass ?transport=native in the
	// WS URL when they want the low-latency UDP relay. Browsers (or native
	// clients with the relay disabled) keep the WebRTC pipeline.
	requestedTransport := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("transport")))
	transport := "webrtc"
	if requestedTransport == "native" && s.udpAudio != nil {
		transport = "native"
	}
	c := &client{
		session:         session,
		user:            user,
		closeNow:        conn.Close,
		listenRooms:     toRoomSet(listenRooms),
		talkRooms:       toRoomSet(talkRooms),
		voiceMode:       initialVoiceMode,
		micEnabled:      initialMicEnabled,
		broadcastGroups: make(map[string]struct{}),
		send:            make(chan WSOutbound, 512),
		sendPriority:    make(chan WSOutbound, 512),
		transport:       transport,
	}
	s.hub.Add(c)
	// Send current presence snapshot to newly connected client so they see all other users
	s.hub.SendPresenceSnapshot(session.Token)
	s.hub.SendChatHistorySnapshot(session.Token)
	if transport == "native" {
		s.sendNativeAudioEndpoint(session.Token, r)
	} else if err := s.media.EnsurePeer(session.Token, user); err != nil {
		s.logger.Error("failed to initialize media peer", "error", err)
	}
	defer func() {
		s.hub.Remove(session.Token)
		s.sessions.ScheduleDisconnectLogout(session.Token, s.cfg.DisconnectLogoutDelay)
	}()
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
			// Notify Companion clients of listen-state changes so button images update immediately
			s.publishCompanionPresenceUpdate(r.Context(), session.RoleID)
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
			if mediaReady && s.media != nil {
				s.media.NoteVoiceStateTrigger()
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
		case "companion_command_result":
			raw, _ := json.Marshal(in.Data)
			var result CompanionCommandResult
			_ = json.Unmarshal(raw, &result)
			if strings.TrimSpace(result.CommandID) == "" {
				continue
			}
			if result.Timestamp == 0 {
				result.Timestamp = time.Now().UnixMilli()
			}
			if strings.TrimSpace(result.Source) == "" {
				result.Source = "browser"
			}
			s.publishCompanionResult(user.Username, result)
			s.publishCompanionResult(user.RoleID, result)
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
	s.appendAdminLog(AdminLogEntry{
		TimestampUnixMs: time.Now().UnixMilli(),
		Level:           "ERROR",
		Category:        "error",
		Message:         "internal request error",
		Error:           err.Error(),
	})
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
