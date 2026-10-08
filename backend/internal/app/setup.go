package app

// First-run setup in the browser. With FIRST_RUN_SETUP=true (set by
// deploy/server) and no ADMIN_PIN given, a fresh server shows a setup page
// instead of the login: the first visitor chooses the admin PIN and whether
// to keep the example roles and party lines. Until then admin login is
// closed, so the default PIN 123456 never works on such a server.
//
// Existing installations and the test lab are unaffected: the flag is off
// by default, and an ADMIN_PIN from the environment counts as set up.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"
)

const setupCompletedKey = "setup_completed"

func (s *Store) IsSetupCompleted(ctx context.Context) (bool, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, setupCompletedKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return value == "1", nil
}

// CompleteSetup stores the admin PIN, optionally removes the example
// configuration, and marks setup as done, all in one transaction.
func (s *Store) CompleteSetup(ctx context.Context, pin string, emptyStart bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if emptyStart {
		// Example roles, party lines and broadcast groups from the seed, plus
		// everything that refers to them.
		for _, table := range []string{
			"room_sender_roles", "room_receiver_roles", "room_forced_listen_roles",
			"broadcast_group_rooms", "broadcast_group_roles", "broadcast_groups",
			"telegram_mappings", "role_stream_deck_settings", "companion_role_pages", "companion_profiles",
			"users", "rooms", "roles",
		} {
			if _, err := tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_settings (key, value) VALUES ('admin_pin', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`, pin); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_settings (key, value) VALUES (?, '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value`, setupCompletedKey); err != nil {
		return err
	}
	return tx.Commit()
}

// setupRequired: this server still waits for its first-run setup.
func (s *Server) setupRequired(ctx context.Context) bool {
	if !s.cfg.FirstRunSetup || s.cfg.AdminPINFromEnv {
		return false
	}
	done, err := s.store.IsSetupCompleted(ctx)
	return err == nil && !done
}

// validAdminPIN: 4-32 visible characters without spaces.
func validAdminPIN(pin string) bool {
	if len(pin) < 4 || len(pin) > 32 {
		return false
	}
	for _, r := range pin {
		if unicode.IsSpace(r) || !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}

type setupRequest struct {
	PIN string `json:"pin"`
	// "example" keeps the seeded roles and party lines, "empty" removes them.
	Start string `json:"start"`
}

// POST /api/setup: only while setup is required.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req setupRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	pin := strings.TrimSpace(req.PIN)
	if !validAdminPIN(pin) {
		http.Error(w, "the PIN needs 4 to 32 characters without spaces", http.StatusBadRequest)
		return
	}
	if req.Start != "example" && req.Start != "empty" {
		http.Error(w, "start must be example or empty", http.StatusBadRequest)
		return
	}
	// One setup only, even if two browsers submit at the same moment.
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if !s.setupRequired(r.Context()) {
		http.Error(w, "this server is already set up", http.StatusConflict)
		return
	}
	if err := s.store.CompleteSetup(r.Context(), pin, req.Start == "empty"); err != nil {
		s.internalErr(w, err)
		return
	}
	s.logger.Info("first-run setup completed", "start", req.Start, "ip", remoteIP(r))
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
