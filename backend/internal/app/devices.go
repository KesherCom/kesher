package app

// Hardware stations (kesher-node on a Raspberry Pi) that join without any
// configuration on the device:
//
//  1. The node generates a device ID and a secret on first start and calls
//     POST /api/devices/hello. Unknown devices are stored as "pending".
//  2. An admin approves it in the admin area (Devices) and assigns a name,
//     a role and a voice mode.
//  3. The node calls POST /api/devices/login with its ID and secret and gets
//     a normal session for that role, plus its settings.
//
// The secret is trusted on first use: whoever presents a device ID first
// owns it, and the admin approval is the actual gate. Only a hash is stored.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	DeviceStatusPending  = "pending"
	DeviceStatusApproved = "approved"
	DeviceStatusRejected = "rejected"

	// Unauthenticated hello calls may create at most this many pending
	// devices; approved/rejected ones do not count.
	maxPendingDevices = 100
	// Revocation reason sent to a node whose settings changed; it reconnects
	// right away (other revocations make it back off).
	deviceUpdatedReason = "device_updated"
)

var (
	deviceIDPattern  = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)
	deviceNameClean  = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	errDeviceSecret  = errors.New("device secret mismatch")
	errTooManyDevice = errors.New("too many pending devices")
)

type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Hostname   string `json:"hostname"`
	Model      string `json:"model"`
	Version    string `json:"version"`
	Status     string `json:"status"`
	RoleID     string `json:"roleId"`
	Mode       string `json:"mode"`
	LastIP     string `json:"lastIp"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
	// Online: a session with this device's name is connected right now.
	Online bool `json:"online"`
}

func (s *Store) ensureDevicesSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS devices (
		id TEXT PRIMARY KEY,
		secret_hash TEXT NOT NULL,
		name TEXT NOT NULL,
		hostname TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		version TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL,
		role_id TEXT NOT NULL DEFAULT '',
		mode TEXT NOT NULL DEFAULT 'ptt',
		last_ip TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL
	)`)
	return err
}

func hashDeviceSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// deviceNameFromHostname turns a hostname into a login name (no spaces).
func deviceNameFromHostname(hostname string) string {
	name := strings.Trim(deviceNameClean.ReplaceAllString(strings.TrimSpace(hostname), "-"), "-.")
	if name == "" {
		name = "station"
	}
	if len(name) > 40 {
		name = name[:40]
	}
	return name
}

const deviceColumns = `id, name, hostname, model, version, status, role_id, mode, last_ip, created_at, last_seen_at`

func scanDevice(row interface{ Scan(...any) error }) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.Name, &d.Hostname, &d.Model, &d.Version, &d.Status, &d.RoleID, &d.Mode, &d.LastIP, &d.CreatedAt, &d.LastSeenAt)
	return d, err
}

// DeviceHello registers a new device as pending, or checks the secret of a
// known one and records that it was seen.
func (s *Store) DeviceHello(ctx context.Context, id, secret, hostname, model, version, ip string) (Device, error) {
	if !deviceIDPattern.MatchString(id) || len(secret) < 32 {
		return Device{}, ErrInvalidInput
	}
	trim := func(v string, n int) string {
		v = strings.TrimSpace(v)
		if len(v) > n {
			v = v[:n]
		}
		return v
	}
	hostname, model, version = trim(hostname, 64), trim(model, 128), trim(version, 32)
	now := time.Now().UnixMilli()
	var storedHash string
	err := s.db.QueryRowContext(ctx, `SELECT secret_hash FROM devices WHERE id = ?`, id).Scan(&storedHash)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		var pending int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM devices WHERE status = ?`, DeviceStatusPending).Scan(&pending); err != nil {
			return Device{}, err
		}
		if pending >= maxPendingDevices {
			return Device{}, errTooManyDevice
		}
		if _, err := s.db.ExecContext(ctx, `INSERT INTO devices (id, secret_hash, name, hostname, model, version, status, last_ip, created_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, hashDeviceSecret(secret), deviceNameFromHostname(hostname), hostname, model, version, DeviceStatusPending, ip, now, now); err != nil {
			return Device{}, err
		}
	case err != nil:
		return Device{}, err
	default:
		if subtle.ConstantTimeCompare([]byte(storedHash), []byte(hashDeviceSecret(secret))) != 1 {
			return Device{}, errDeviceSecret
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE devices SET hostname = ?, model = ?, version = ?, last_ip = ?, last_seen_at = ? WHERE id = ?`,
			hostname, model, version, ip, now, id); err != nil {
			return Device{}, err
		}
	}
	return s.GetDevice(ctx, id)
}

func (s *Store) GetDevice(ctx context.Context, id string) (Device, error) {
	d, err := scanDevice(s.db.QueryRowContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	return d, err
}

func (s *Store) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+deviceColumns+` FROM devices
		ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	devices := []Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

// UpdateDevice sets name, role, mode and status. Approving needs a role.
func (s *Store) UpdateDevice(ctx context.Context, id, name, roleID, mode, status string) error {
	name = strings.TrimSpace(name)
	roleID = strings.TrimSpace(roleID)
	if name == "" || strings.ContainsAny(name, " \t\r\n") || len(name) > 64 {
		return ErrInvalidInput
	}
	if mode != "ptt" && mode != "always_on" {
		return ErrInvalidInput
	}
	switch status {
	case DeviceStatusPending, DeviceStatusRejected:
	case DeviceStatusApproved:
		ok, err := s.RoleExists(ctx, roleID)
		if err != nil {
			return err
		}
		if !ok {
			return ErrInvalidInput
		}
	default:
		return ErrInvalidInput
	}
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET name = ?, role_id = ?, mode = ?, status = ? WHERE id = ?`,
		name, roleID, mode, status, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteDevice(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM devices WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ── HTTP ────────────────────────────────────────────────────────────────────

type deviceHelloRequest struct {
	DeviceID string `json:"deviceId"`
	Secret   string `json:"secret"`
	Hostname string `json:"hostname"`
	Model    string `json:"model"`
	Version  string `json:"version"`
}

// deviceConfig is what a node learns about itself.
type deviceConfig struct {
	Status string `json:"status"`
	Name   string `json:"name"`
	RoleID string `json:"roleId,omitempty"`
	Mode   string `json:"mode"`
}

type deviceLoginResponse struct {
	LoginResponse
	Device deviceConfig `json:"device"`
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) deviceFromRequest(w http.ResponseWriter, r *http.Request) (Device, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return Device{}, false
	}
	var req deviceHelloRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return Device{}, false
	}
	d, err := s.store.DeviceHello(r.Context(), strings.TrimSpace(req.DeviceID), req.Secret, req.Hostname, req.Model, req.Version, remoteIP(r))
	switch {
	case errors.Is(err, errDeviceSecret):
		http.Error(w, "device secret does not match; remove the device in the admin area to pair it again", http.StatusForbidden)
		return Device{}, false
	case errors.Is(err, errTooManyDevice):
		http.Error(w, "too many devices waiting for approval", http.StatusTooManyRequests)
		return Device{}, false
	case err != nil:
		if s.writeStoreErr(w, err) {
			return Device{}, false
		}
		s.internalErr(w, err)
		return Device{}, false
	}
	return d, true
}

func configOf(d Device) deviceConfig {
	return deviceConfig{Status: d.Status, Name: d.Name, RoleID: d.RoleID, Mode: d.Mode}
}

// POST /api/devices/hello: register or check in; tells the node its status.
func (s *Server) handleDeviceHello(w http.ResponseWriter, r *http.Request) {
	d, ok := s.deviceFromRequest(w, r)
	if !ok {
		return
	}
	if d.Status == DeviceStatusPending {
		s.logger.Info("device waiting for approval", "device", d.ID, "hostname", d.Hostname, "ip", d.LastIP)
	}
	s.writeJSON(w, http.StatusOK, configOf(d))
}

// POST /api/devices/login: an approved device gets a session for its role.
func (s *Server) handleDeviceLogin(w http.ResponseWriter, r *http.Request) {
	d, ok := s.deviceFromRequest(w, r)
	if !ok {
		return
	}
	if d.Status != DeviceStatusApproved {
		s.writeJSON(w, http.StatusForbidden, configOf(d))
		return
	}
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if existing, conflict := s.sessions.LatestForRole(d.RoleID); conflict && existing.Username != d.Name && s.roleIsExclusive(r.Context(), d.RoleID) {
		s.writeJSON(w, http.StatusConflict, LoginConflictResponse{
			RequiresTakeover: true,
			ConflictRoleID:   d.RoleID,
			ConflictRoleName: s.roleNameByID(r.Context(), d.RoleID),
			ConflictUsername: existing.Username,
		})
		return
	}
	// The device's own earlier session (restart, network loss).
	s.revokeSessionsOfUser(d.Name, "")
	user, err := s.store.UpsertUser(r.Context(), d.Name, d.RoleID)
	if err != nil {
		if s.writeStoreErr(w, err) {
			return
		}
		s.internalErr(w, err)
		return
	}
	// A station is its own place.
	session := s.sessions.CreateWithPlace(user, "station-"+d.ID)
	s.writeJSON(w, http.StatusOK, deviceLoginResponse{
		LoginResponse: LoginResponse{Token: session.Token, User: user},
		Device:        configOf(d),
	})
}

// revokeSessionsOfUser ends every session of a login name; connected clients
// get session_revoked with the reason.
func (s *Server) revokeSessionsOfUser(username, reason string) {
	for _, session := range s.sessions.DeleteByUsername(username) {
		s.hub.RemoveWithReason(session.Token, reason)
	}
}

type updateDeviceRequest struct {
	Name   string `json:"name"`
	RoleID string `json:"roleId"`
	Mode   string `json:"mode"`
	Status string `json:"status"`
}

// GET /api/admin/devices
func (s *Server) handleAdminDevices(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		s.internalErr(w, err)
		return
	}
	online := s.hub.OnlineUsernames()
	for i := range devices {
		devices[i].Online = devices[i].Status == DeviceStatusApproved && online[devices[i].Name]
	}
	s.writeJSON(w, http.StatusOK, devices)
}

// PUT / DELETE /api/admin/devices/{id}
func (s *Server) handleAdminDeviceByID(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/devices/")
	if !deviceIDPattern.MatchString(id) {
		http.Error(w, "invalid device id", http.StatusBadRequest)
		return
	}
	before, err := s.store.GetDevice(r.Context(), id)
	if err != nil {
		if s.writeStoreErr(w, err) {
			return
		}
		s.internalErr(w, err)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var req updateDeviceRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if err := s.store.UpdateDevice(r.Context(), id, req.Name, req.RoleID, req.Mode, req.Status); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
	case http.MethodDelete:
		if err := s.store.DeleteDevice(r.Context(), id); err != nil {
			if s.writeStoreErr(w, err) {
				return
			}
			s.internalErr(w, err)
			return
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// The node picks up the new settings by logging in again.
	if before.Status == DeviceStatusApproved {
		s.sessionMu.Lock()
		s.revokeSessionsOfUser(before.Name, deviceUpdatedReason)
		s.sessionMu.Unlock()
	}
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
