package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	_ "modernc.org/sqlite"
)

var (
	ErrInvalidInput = errors.New("invalid input")
	ErrConflict     = errors.New("conflict")
	ErrNotFound     = errors.New("not found")
)

const defaultAdminPIN = "123456"

type Store struct {
	db *sql.DB

	policyCacheMu               sync.RWMutex
	roomPolicyCache             map[string]cachedRoomPolicy
	broadcastAllowedRoleCache   map[string]map[string]struct{}
	broadcastRoomSetCache       map[string]map[string]struct{}
	broadcastRoomIDsCache       map[string][]string
	forcedListenRoomIDsByRole   map[string][]string
	roomPolicyCacheHits         atomic.Uint64
	roomPolicyCacheMisses       atomic.Uint64
	broadcastAllowedCacheHits   atomic.Uint64
	broadcastAllowedCacheMisses atomic.Uint64
	broadcastRoomCacheHits      atomic.Uint64
	broadcastRoomCacheMisses    atomic.Uint64
	forcedListenCacheHits       atomic.Uint64
	forcedListenCacheMisses     atomic.Uint64
}

type cachedRoomPolicy struct {
	senderRoles   map[string]struct{}
	receiverRoles map[string]struct{}
}

type PolicyCacheStats struct {
	RoomPolicyHits         uint64 `json:"roomPolicyHits"`
	RoomPolicyMisses       uint64 `json:"roomPolicyMisses"`
	BroadcastAllowedHits   uint64 `json:"broadcastAllowedHits"`
	BroadcastAllowedMisses uint64 `json:"broadcastAllowedMisses"`
	BroadcastRoomHits      uint64 `json:"broadcastRoomHits"`
	BroadcastRoomMisses    uint64 `json:"broadcastRoomMisses"`
	ForcedListenHits       uint64 `json:"forcedListenHits"`
	ForcedListenMisses     uint64 `json:"forcedListenMisses"`
}

func copyStringSlice(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	return append([]string(nil), in...)
}

func (s *Store) resetPolicyCaches() {
	s.policyCacheMu.Lock()
	s.roomPolicyCache = make(map[string]cachedRoomPolicy)
	s.broadcastAllowedRoleCache = make(map[string]map[string]struct{})
	s.broadcastRoomSetCache = make(map[string]map[string]struct{})
	s.broadcastRoomIDsCache = make(map[string][]string)
	s.forcedListenRoomIDsByRole = make(map[string][]string)
	s.policyCacheMu.Unlock()
}

func (s *Store) PolicyCacheStats() PolicyCacheStats {
	return PolicyCacheStats{
		RoomPolicyHits:         s.roomPolicyCacheHits.Load(),
		RoomPolicyMisses:       s.roomPolicyCacheMisses.Load(),
		BroadcastAllowedHits:   s.broadcastAllowedCacheHits.Load(),
		BroadcastAllowedMisses: s.broadcastAllowedCacheMisses.Load(),
		BroadcastRoomHits:      s.broadcastRoomCacheHits.Load(),
		BroadcastRoomMisses:    s.broadcastRoomCacheMisses.Load(),
		ForcedListenHits:       s.forcedListenCacheHits.Load(),
		ForcedListenMisses:     s.forcedListenCacheMisses.Load(),
	}
}

func (s *Store) validateRolesExistWithTx(ctx context.Context, tx *sql.Tx, roleIDs []string) error {
	for _, roleID := range roleIDs {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(1) FROM roles WHERE id = ?`, roleID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return ErrInvalidInput
		}
	}
	return nil
}

func (s *Store) GetAdminPIN(ctx context.Context) (string, error) {
	var pin string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = 'admin_pin'`).Scan(&pin)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return pin, nil
}

func (s *Store) SetAdminPIN(ctx context.Context, pin string) error {
	pin = strings.TrimSpace(pin)
	if pin == "" {
		return ErrInvalidInput
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO app_settings (key, value) VALUES ('admin_pin', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`, pin)
	return err
}

func (s *Store) replaceRoomRoleMappingsWithTx(ctx context.Context, tx *sql.Tx, table, roomID string, roleIDs []string) error {
	if _, err := tx.ExecContext(ctx, fmt.Sprintf(`DELETE FROM %s WHERE room_id = ?`, table), roomID); err != nil {
		return err
	}
	for _, roleID := range roleIDs {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`INSERT INTO %s (room_id, role_id) VALUES (?, ?)`, table), roomID, roleID); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) replaceBroadcastGroupRoleMappingsWithTx(ctx context.Context, tx *sql.Tx, groupID string, roleIDs []string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_roles WHERE broadcast_group_id = ?`, groupID); err != nil {
		return err
	}
	for _, roleID := range roleIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO broadcast_group_roles (broadcast_group_id, role_id) VALUES (?, ?)`, groupID, roleID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) roomRoleIDs(ctx context.Context, table, roomID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`SELECT role_id FROM %s WHERE room_id = ? ORDER BY role_id`, table), roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roleIDs []string
	for rows.Next() {
		var roleID string
		if err := rows.Scan(&roleID); err != nil {
			return nil, err
		}
		roleIDs = append(roleIDs, roleID)
	}
	return roleIDs, nil
}

func (s *Store) RoomAllowsSenderRole(ctx context.Context, roomID, roleID string) (bool, error) {
	cached, err := s.roomPolicyCached(ctx, roomID)
	if err != nil {
		return false, err
	}
	_, ok := cached.senderRoles[roleID]
	return ok, nil
}

func (s *Store) RoomAllowsReceiverRole(ctx context.Context, roomID, roleID string) (bool, error) {
	cached, err := s.roomPolicyCached(ctx, roomID)
	if err != nil {
		return false, err
	}
	_, ok := cached.receiverRoles[roleID]
	return ok, nil
}

func (s *Store) roomPolicyCached(ctx context.Context, roomID string) (cachedRoomPolicy, error) {
	s.policyCacheMu.RLock()
	if cached, ok := s.roomPolicyCache[roomID]; ok {
		s.roomPolicyCacheHits.Add(1)
		s.policyCacheMu.RUnlock()
		return cached, nil
	}
	s.policyCacheMu.RUnlock()
	s.roomPolicyCacheMisses.Add(1)
	senderRoleIDs, err := s.roomRoleIDs(ctx, "room_sender_roles", roomID)
	if err != nil {
		return cachedRoomPolicy{}, err
	}
	receiverRoleIDs, err := s.roomRoleIDs(ctx, "room_receiver_roles", roomID)
	if err != nil {
		return cachedRoomPolicy{}, err
	}
	cached := cachedRoomPolicy{
		senderRoles:   toStringSet(senderRoleIDs),
		receiverRoles: toStringSet(receiverRoleIDs),
	}

	s.policyCacheMu.Lock()
	s.roomPolicyCache[roomID] = cached
	s.policyCacheMu.Unlock()
	return cached, nil
}

// ForcedListenRoomIDs returns the list of room IDs that the given role must listen to.
func (s *Store) ForcedListenRoomIDs(ctx context.Context, roleID string) ([]string, error) {
	s.policyCacheMu.RLock()
	if cached, ok := s.forcedListenRoomIDsByRole[roleID]; ok {
		s.forcedListenCacheHits.Add(1)
		s.policyCacheMu.RUnlock()
		return copyStringSlice(cached), nil
	}
	s.policyCacheMu.RUnlock()
	s.forcedListenCacheMisses.Add(1)
	rows, err := s.db.QueryContext(ctx, `SELECT room_id FROM room_forced_listen_roles WHERE role_id = ?`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.policyCacheMu.Lock()
	s.forcedListenRoomIDsByRole[roleID] = copyStringSlice(ids)
	s.policyCacheMu.Unlock()
	return ids, nil
}

func toStringSet(values []string) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		out[value] = struct{}{}
	}
	return out
}

func (s *Store) ensureColumn(ctx context.Context, table, column, columnType string) error {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name string
		var ctype string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if strings.EqualFold(name, column) {
			return nil
		}
	}
	_, err = s.db.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, table, column, columnType))
	return err
}

func (s *Store) validateRoleDefaults(ctx context.Context, defaultRoomID, defaultVoiceMode string) error {
	if strings.TrimSpace(defaultRoomID) != "" {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM rooms WHERE id = ?`, defaultRoomID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return ErrInvalidInput
		}
	}
	if strings.TrimSpace(defaultVoiceMode) != "" && !isAllowedVoiceMode(defaultVoiceMode) {
		return ErrInvalidInput
	}
	return nil
}

func isAllowedVoiceMode(mode string) bool {
	switch mode {
	case "always_on", "ptt":
		return true
	default:
		return false
	}
}

func nullableString(value string) sql.NullString {
	if strings.TrimSpace(value) == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

func NewStore(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	if dbPath == ":memory:" || strings.Contains(dbPath, "mode=memory") {
		// Keep one connection for in-memory SQLite so schema/data remain visible.
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	}
	s := &Store{db: db}
	s.resetPolicyCaches()
	if err := s.migrate(context.Background()); err != nil {
		return nil, err
	}
	if err := s.seed(context.Background()); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS roles (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE
		);`,
		`CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE
		);`,
		`CREATE TABLE IF NOT EXISTS room_sender_roles (
			room_id TEXT NOT NULL,
			role_id TEXT NOT NULL,
			PRIMARY KEY (room_id, role_id)
		);`,
		`CREATE TABLE IF NOT EXISTS room_receiver_roles (
			room_id TEXT NOT NULL,
			role_id TEXT NOT NULL,
			PRIMARY KEY (room_id, role_id)
		);`,
		`CREATE TABLE IF NOT EXISTS room_forced_listen_roles (
			room_id TEXT NOT NULL,
			role_id TEXT NOT NULL,
			PRIMARY KEY (room_id, role_id)
		);`,
		`CREATE TABLE IF NOT EXISTS broadcast_groups (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE
		);`,
		`CREATE TABLE IF NOT EXISTS broadcast_group_rooms (
			broadcast_group_id TEXT NOT NULL,
			room_id TEXT NOT NULL,
			PRIMARY KEY (broadcast_group_id, room_id)
		);`,
		`CREATE TABLE IF NOT EXISTS broadcast_group_roles (
			broadcast_group_id TEXT NOT NULL,
			role_id TEXT NOT NULL,
			PRIMARY KEY (broadcast_group_id, role_id)
		);`,
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			role_id TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS app_settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if err := s.ensureColumn(ctx, "roles", "default_room_id", "TEXT"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "roles", "default_voice_mode", "TEXT"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "roles", "default_simple_view", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS telegram_mappings (
		id TEXT PRIMARY KEY,
		chat_id TEXT NOT NULL UNIQUE,
		label TEXT NOT NULL,
		room_id TEXT NOT NULL
	)`); err != nil {
		return err
	}
	return nil
}

func (s *Store) seed(ctx context.Context) error {
	roles := []Role{
		{ID: "audio", Name: "Audio", DefaultRoomID: "foh", DefaultVoiceMode: "always_on"},
		{ID: "video", Name: "Video", DefaultRoomID: "video-control", DefaultVoiceMode: "ptt"},
		{ID: "lighting", Name: "Lighting", DefaultRoomID: "lighting-booth", DefaultVoiceMode: "ptt"},
		{ID: "broadcast", Name: "Broadcast", DefaultRoomID: "livestream", DefaultVoiceMode: "always_on"},
		{ID: "camera", Name: "Camera", DefaultRoomID: "stage", DefaultVoiceMode: "ptt", DefaultSimpleView: true},
		{ID: "pastor", Name: "Pastor", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
		{ID: "producer", Name: "Producer", DefaultRoomID: "foh", DefaultVoiceMode: "always_on"},
	}
	for _, role := range roles {
		defaultSimpleView := 0
		if role.DefaultSimpleView {
			defaultSimpleView = 1
		}
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO roles (id, name, default_room_id, default_voice_mode, default_simple_view) VALUES (?, ?, ?, ?, ?)`,
			role.ID, role.Name, nullableString(role.DefaultRoomID), nullableString(role.DefaultVoiceMode), defaultSimpleView); err != nil {
			return err
		}
	}
	rooms := []Room{
		{ID: "foh", Name: "FOH"},
		{ID: "stage", Name: "Stage"},
		{ID: "video-control", Name: "Video Control"},
		{ID: "livestream", Name: "Livestream"},
		{ID: "lighting-booth", Name: "Lighting Booth"},
	}
	for _, room := range rooms {
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)`, room.ID, room.Name); err != nil {
			return err
		}
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO broadcast_groups (id, name) VALUES ('all-tech', 'All Tech')`); err != nil {
		return err
	}
	// Seed room role mappings: grant all roles sender+receiver access to all rooms.
	// With the "empty = nobody" policy, rooms without mappings would be inaccessible.
	allRoleIDs := make([]string, len(roles))
	for i, r := range roles {
		allRoleIDs[i] = r.ID
	}
	allRoomIDs := make([]string, len(rooms))
	for i, r := range rooms {
		allRoomIDs[i] = r.ID
	}
	for _, roomID := range allRoomIDs {
		var hasSenders int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM room_sender_roles WHERE room_id = ?`, roomID).Scan(&hasSenders); err != nil {
			return err
		}
		if hasSenders == 0 {
			for _, roleID := range allRoleIDs {
				if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO room_sender_roles (room_id, role_id) VALUES (?, ?)`, roomID, roleID); err != nil {
					return err
				}
			}
		}
		var hasReceivers int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM room_receiver_roles WHERE room_id = ?`, roomID).Scan(&hasReceivers); err != nil {
			return err
		}
		if hasReceivers == 0 {
			for _, roleID := range allRoleIDs {
				if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO room_receiver_roles (room_id, role_id) VALUES (?, ?)`, roomID, roleID); err != nil {
					return err
				}
			}
		}
	}
	var allTechRooms int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM broadcast_group_rooms WHERE broadcast_group_id = 'all-tech'`).Scan(&allTechRooms); err != nil {
		return err
	}
	if allTechRooms == 0 {
		for _, roomID := range []string{"foh", "stage", "video-control", "livestream", "lighting-booth"} {
			if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('all-tech', ?)`, roomID); err != nil {
				return err
			}
		}
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admin_pin', ?)`, defaultAdminPIN); err != nil {
		return err
	}
	// Seed broadcast group role mappings: grant all roles access to all-tech.
	var allTechRoles int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM broadcast_group_roles WHERE broadcast_group_id = 'all-tech'`).Scan(&allTechRoles); err != nil {
		return err
	}
	if allTechRoles == 0 {
		for _, roleID := range allRoleIDs {
			if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO broadcast_group_roles (broadcast_group_id, role_id) VALUES ('all-tech', ?)`, roleID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) RoleExists(ctx context.Context, roleID string) (bool, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM roles WHERE id = ?`, roleID).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

func (s *Store) UpsertUser(ctx context.Context, username, roleID string) (User, error) {
	if _, err := s.db.ExecContext(ctx, `INSERT INTO users (id, username, role_id) VALUES (lower(hex(randomblob(16))), ?, ?)
	ON CONFLICT(username) DO UPDATE SET role_id = excluded.role_id`, username, roleID); err != nil {
		return User{}, err
	}
	return s.FindUserByUsername(ctx, username)
}

func (s *Store) FindUserByUsername(ctx context.Context, username string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, `SELECT id, username, role_id FROM users WHERE username = ?`, username).Scan(&u.ID, &u.Username, &u.RoleID)
	return u, err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, username, role_id FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.RoleID); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, nil
}

func (s *Store) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, default_room_id, default_voice_mode, default_simple_view FROM roles ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		var defaultRoomID sql.NullString
		var defaultVoiceMode sql.NullString
		var defaultSimpleView int
		if err := rows.Scan(&r.ID, &r.Name, &defaultRoomID, &defaultVoiceMode, &defaultSimpleView); err != nil {
			return nil, err
		}
		if defaultRoomID.Valid {
			r.DefaultRoomID = defaultRoomID.String
		}
		if defaultVoiceMode.Valid {
			r.DefaultVoiceMode = defaultVoiceMode.String
		}
		r.DefaultSimpleView = defaultSimpleView != 0
		roles = append(roles, r)
	}
	return roles, nil
}

func (s *Store) ListRooms(ctx context.Context) ([]Room, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name FROM rooms ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var rooms []Room
	for rows.Next() {
		var r Room
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			return nil, err
		}
		senderRoleIDs, err := s.roomRoleIDs(ctx, "room_sender_roles", r.ID)
		if err != nil {
			return nil, err
		}
		receiverRoleIDs, err := s.roomRoleIDs(ctx, "room_receiver_roles", r.ID)
		if err != nil {
			return nil, err
		}
		forcedListenRoleIDs, err := s.roomRoleIDs(ctx, "room_forced_listen_roles", r.ID)
		if err != nil {
			return nil, err
		}
		r.SenderRoleIDs = senderRoleIDs
		r.ReceiverRoleIDs = receiverRoleIDs
		r.ForcedListenRoleIDs = forcedListenRoleIDs
		rooms = append(rooms, r)
	}
	return rooms, nil
}

func (s *Store) ListBroadcastGroups(ctx context.Context) ([]BroadcastGroup, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name FROM broadcast_groups ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var groups []BroadcastGroup
	for rows.Next() {
		g := BroadcastGroup{
			RoomIDs:        []string{},
			AllowedRoleIDs: []string{},
		}
		if err := rows.Scan(&g.ID, &g.Name); err != nil {
			return nil, err
		}
		roomRows, err := s.db.QueryContext(ctx, `SELECT room_id FROM broadcast_group_rooms WHERE broadcast_group_id = ?`, g.ID)
		if err != nil {
			return nil, err
		}
		for roomRows.Next() {
			var rid string
			if err := roomRows.Scan(&rid); err != nil {
				roomRows.Close()
				return nil, err
			}
			g.RoomIDs = append(g.RoomIDs, rid)
		}
		roomRows.Close()
		roleRows, err := s.db.QueryContext(ctx, `SELECT role_id FROM broadcast_group_roles WHERE broadcast_group_id = ? ORDER BY role_id`, g.ID)
		if err != nil {
			return nil, err
		}
		for roleRows.Next() {
			var roleID string
			if err := roleRows.Scan(&roleID); err != nil {
				roleRows.Close()
				return nil, err
			}
			g.AllowedRoleIDs = append(g.AllowedRoleIDs, roleID)
		}
		roleRows.Close()
		groups = append(groups, g)
	}
	return groups, nil
}

func (s *Store) BroadcastGroupRoomIDs(ctx context.Context, groupID string) ([]string, error) {
	s.policyCacheMu.RLock()
	if cached, ok := s.broadcastRoomIDsCache[groupID]; ok {
		s.broadcastRoomCacheHits.Add(1)
		s.policyCacheMu.RUnlock()
		return copyStringSlice(cached), nil
	}
	s.policyCacheMu.RUnlock()
	if _, err := s.broadcastGroupRoomSetCached(ctx, groupID); err != nil {
		return nil, err
	}
	s.policyCacheMu.RLock()
	cached, ok := s.broadcastRoomIDsCache[groupID]
	s.policyCacheMu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("broadcast group not found or empty")
	}
	return copyStringSlice(cached), nil
}

func (s *Store) broadcastGroupRoomSetCached(ctx context.Context, groupID string) (map[string]struct{}, error) {
	s.policyCacheMu.RLock()
	if cached, ok := s.broadcastRoomSetCache[groupID]; ok {
		s.broadcastRoomCacheHits.Add(1)
		s.policyCacheMu.RUnlock()
		return cached, nil
	}
	s.policyCacheMu.RUnlock()
	s.broadcastRoomCacheMisses.Add(1)
	rows, err := s.db.QueryContext(ctx, `SELECT room_id FROM broadcast_group_rooms WHERE broadcast_group_id = ?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]struct{})
	for rows.Next() {
		var rid string
		if err := rows.Scan(&rid); err != nil {
			return nil, err
		}
		out[rid] = struct{}{}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("broadcast group not found or empty")
	}
	roomIDs := make([]string, 0, len(out))
	for roomID := range out {
		roomIDs = append(roomIDs, roomID)
	}
	s.policyCacheMu.Lock()
	s.broadcastRoomSetCache[groupID] = out
	s.broadcastRoomIDsCache[groupID] = roomIDs
	s.policyCacheMu.Unlock()
	return out, nil
}

func (s *Store) BroadcastGroupAllowsRole(ctx context.Context, groupID, roleID string) (bool, error) {
	cached, err := s.broadcastGroupAllowedRoleSetCached(ctx, groupID)
	if err != nil {
		return false, err
	}
	_, ok := cached[roleID]
	return ok, nil
}

func (s *Store) broadcastGroupAllowedRoleSetCached(ctx context.Context, groupID string) (map[string]struct{}, error) {
	s.policyCacheMu.RLock()
	if cached, ok := s.broadcastAllowedRoleCache[groupID]; ok {
		s.broadcastAllowedCacheHits.Add(1)
		s.policyCacheMu.RUnlock()
		return cached, nil
	}
	s.policyCacheMu.RUnlock()
	s.broadcastAllowedCacheMisses.Add(1)
	var groupCount int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM broadcast_groups WHERE id = ?`, groupID).Scan(&groupCount); err != nil {
		return nil, err
	}
	if groupCount == 0 {
		return nil, ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx, `SELECT role_id FROM broadcast_group_roles WHERE broadcast_group_id = ?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := make(map[string]struct{})
	for rows.Next() {
		var roleID string
		if err := rows.Scan(&roleID); err != nil {
			return nil, err
		}
		allowed[roleID] = struct{}{}
	}
	s.policyCacheMu.Lock()
	s.broadcastAllowedRoleCache[groupID] = allowed
	s.policyCacheMu.Unlock()
	return allowed, nil
}

func (s *Store) CreateRole(ctx context.Context, id, name, defaultRoomID, defaultVoiceMode string, defaultSimpleView bool) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	if id == "" || name == "" {
		return ErrInvalidInput
	}
	if err := s.validateRoleDefaults(ctx, defaultRoomID, defaultVoiceMode); err != nil {
		return err
	}
	defaultSimpleViewInt := 0
	if defaultSimpleView {
		defaultSimpleViewInt = 1
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO roles (id, name, default_room_id, default_voice_mode, default_simple_view) VALUES (?, ?, ?, ?, ?)`,
		id, name, nullableString(defaultRoomID), nullableString(defaultVoiceMode), defaultSimpleViewInt); err != nil {
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	s.resetPolicyCaches()
	return nil
}
func (s *Store) UpdateRole(ctx context.Context, id, name, defaultRoomID, defaultVoiceMode string, defaultSimpleView bool) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	if id == "" || name == "" {
		return ErrInvalidInput
	}
	if err := s.validateRoleDefaults(ctx, defaultRoomID, defaultVoiceMode); err != nil {
		return err
	}
	defaultSimpleViewInt := 0
	if defaultSimpleView {
		defaultSimpleViewInt = 1
	}
	res, err := s.db.ExecContext(ctx, `UPDATE roles SET name = ?, default_room_id = ?, default_voice_mode = ?, default_simple_view = ? WHERE id = ?`,
		name, nullableString(defaultRoomID), nullableString(defaultVoiceMode), defaultSimpleViewInt, id)
	if err != nil {
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNotFound
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) DeleteRole(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrInvalidInput
	}
	var usersWithRole int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM users WHERE role_id = ?`, id).Scan(&usersWithRole); err != nil {
		return err
	}
	if usersWithRole > 0 {
		return ErrConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM room_sender_roles WHERE role_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM room_receiver_roles WHERE role_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM room_forced_listen_roles WHERE role_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_roles WHERE role_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM roles WHERE id = ?`, id)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if rows == 0 {
		_ = tx.Rollback()
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) CreateRoom(ctx context.Context, id, name string, senderRoleIDs, receiverRoleIDs, forcedListenRoleIDs []string) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	senderRoleIDs = normalizeIDs(senderRoleIDs)
	receiverRoleIDs = normalizeIDs(receiverRoleIDs)
	forcedListenRoleIDs = normalizeIDs(forcedListenRoleIDs)
	// Forced listen implies listen — merge forced into receivers.
	receiverRoleIDs = mergeUnique(receiverRoleIDs, forcedListenRoleIDs)
	if id == "" || name == "" {
		return ErrInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, senderRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, receiverRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, forcedListenRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO rooms (id, name) VALUES (?, ?)`, id, name); err != nil {
		_ = tx.Rollback()
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_sender_roles", id, senderRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_receiver_roles", id, receiverRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_forced_listen_roles", id, forcedListenRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) UpdateRoom(ctx context.Context, id, name string, senderRoleIDs, receiverRoleIDs, forcedListenRoleIDs []string) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	senderRoleIDs = normalizeIDs(senderRoleIDs)
	receiverRoleIDs = normalizeIDs(receiverRoleIDs)
	forcedListenRoleIDs = normalizeIDs(forcedListenRoleIDs)
	// Forced listen implies listen — merge forced into receivers.
	receiverRoleIDs = mergeUnique(receiverRoleIDs, forcedListenRoleIDs)
	if id == "" || name == "" {
		return ErrInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, senderRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, receiverRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, forcedListenRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	res, err := tx.ExecContext(ctx, `UPDATE rooms SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		_ = tx.Rollback()
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if rows == 0 {
		_ = tx.Rollback()
		return ErrNotFound
	}
	if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_sender_roles", id, senderRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_receiver_roles", id, receiverRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_forced_listen_roles", id, forcedListenRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

// RoomPermissionEntry describes the sender/receiver/forced-listen role mapping for one room.
type RoomPermissionEntry struct {
	RoomID              string   `json:"roomId"`
	SenderRoleIDs       []string `json:"senderRoleIds"`
	ReceiverRoleIDs     []string `json:"receiverRoleIds"`
	ForcedListenRoleIDs []string `json:"forcedListenRoleIds"`
}

// BulkUpdateRoomPermissions updates sender/receiver role mappings for multiple rooms
// in a single transaction. It only touches role mappings — room names are left unchanged.
func (s *Store) BulkUpdateRoomPermissions(ctx context.Context, entries []RoomPermissionEntry) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		roomID := strings.TrimSpace(entry.RoomID)
		if roomID == "" {
			_ = tx.Rollback()
			return ErrInvalidInput
		}
		// verify room exists
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(1) FROM rooms WHERE id = ?`, roomID).Scan(&n); err != nil {
			_ = tx.Rollback()
			return err
		}
		if n == 0 {
			_ = tx.Rollback()
			return ErrNotFound
		}
		senderIDs := normalizeIDs(entry.SenderRoleIDs)
		receiverIDs := normalizeIDs(entry.ReceiverRoleIDs)
		forcedListenIDs := normalizeIDs(entry.ForcedListenRoleIDs)
		// Forced listen implies listen — merge forced into receivers.
		receiverIDs = mergeUnique(receiverIDs, forcedListenIDs)
		if err := s.validateRolesExistWithTx(ctx, tx, senderIDs); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.validateRolesExistWithTx(ctx, tx, receiverIDs); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_sender_roles", roomID, senderIDs); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_receiver_roles", roomID, receiverIDs); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.validateRolesExistWithTx(ctx, tx, forcedListenIDs); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_forced_listen_roles", roomID, forcedListenIDs); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) DeleteRoom(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_rooms WHERE room_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM room_sender_roles WHERE room_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM room_receiver_roles WHERE room_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM room_forced_listen_roles WHERE room_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	roomDeleteRes, err := tx.ExecContext(ctx, `DELETE FROM rooms WHERE id = ?`, id)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	roomDeletedRows, err := roomDeleteRes.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if roomDeletedRows == 0 {
		_ = tx.Rollback()
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_groups WHERE id IN (
		SELECT bg.id
		FROM broadcast_groups bg
		LEFT JOIN broadcast_group_rooms bgr ON bgr.broadcast_group_id = bg.id
		GROUP BY bg.id
		HAVING COUNT(bgr.room_id) = 0
	)`); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_roles WHERE broadcast_group_id NOT IN (SELECT id FROM broadcast_groups)`); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) CreateBroadcastGroup(ctx context.Context, id, name string, roomIDs, allowedRoleIDs []string) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	roomIDs = normalizeIDs(roomIDs)
	allowedRoleIDs = normalizeIDs(allowedRoleIDs)
	if id == "" || name == "" || len(roomIDs) == 0 {
		return ErrInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := s.validateRoomsExistWithTx(ctx, tx, roomIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, allowedRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO broadcast_groups (id, name) VALUES (?, ?)`, id, name); err != nil {
		_ = tx.Rollback()
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	for _, roomID := range roomIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES (?, ?)`, id, roomID); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := s.replaceBroadcastGroupRoleMappingsWithTx(ctx, tx, id, allowedRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) UpdateBroadcastGroup(ctx context.Context, id, name string, roomIDs, allowedRoleIDs []string) error {
	id = strings.TrimSpace(id)
	name = strings.TrimSpace(name)
	roomIDs = normalizeIDs(roomIDs)
	allowedRoleIDs = normalizeIDs(allowedRoleIDs)
	if id == "" || name == "" || len(roomIDs) == 0 {
		return ErrInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := s.validateRoomsExistWithTx(ctx, tx, roomIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := s.validateRolesExistWithTx(ctx, tx, allowedRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	updateRes, err := tx.ExecContext(ctx, `UPDATE broadcast_groups SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		_ = tx.Rollback()
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	updatedRows, err := updateRes.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if updatedRows == 0 {
		_ = tx.Rollback()
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_rooms WHERE broadcast_group_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, roomID := range roomIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES (?, ?)`, id, roomID); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := s.replaceBroadcastGroupRoleMappingsWithTx(ctx, tx, id, allowedRoleIDs); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) DeleteBroadcastGroup(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_rooms WHERE broadcast_group_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM broadcast_group_roles WHERE broadcast_group_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM broadcast_groups WHERE id = ?`, id)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if rows == 0 {
		_ = tx.Rollback()
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func (s *Store) validateRoomsExistWithTx(ctx context.Context, tx *sql.Tx, roomIDs []string) error {
	for _, roomID := range roomIDs {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(1) FROM rooms WHERE id = ?`, roomID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return ErrInvalidInput
		}
	}
	return nil
}

func normalizeIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// mergeUnique appends elements from extra into base, skipping duplicates.
func mergeUnique(base, extra []string) []string {
	seen := make(map[string]struct{}, len(base))
	for _, id := range base {
		seen[id] = struct{}{}
	}
	for _, id := range extra {
		if _, ok := seen[id]; !ok {
			base = append(base, id)
			seen[id] = struct{}{}
		}
	}
	return base
}

func isUniqueConstraintErr(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "unique")
}

func (s *Store) CreateTelegramMapping(ctx context.Context, id, chatID, label, roomID string) error {
	id = strings.TrimSpace(id)
	chatID = strings.TrimSpace(chatID)
	label = strings.TrimSpace(label)
	roomID = strings.TrimSpace(roomID)
	if id == "" || chatID == "" || label == "" || roomID == "" {
		return ErrInvalidInput
	}
	var roomExists int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM rooms WHERE id = ?`, roomID).Scan(&roomExists); err != nil {
		return err
	}
	if roomExists == 0 {
		return ErrInvalidInput
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO telegram_mappings (id, chat_id, label, room_id) VALUES (?, ?, ?, ?)`,
		id, chatID, label, roomID); err != nil {
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	return nil
}

func (s *Store) UpdateTelegramMapping(ctx context.Context, id, chatID, label, roomID string) error {
	id = strings.TrimSpace(id)
	chatID = strings.TrimSpace(chatID)
	label = strings.TrimSpace(label)
	roomID = strings.TrimSpace(roomID)
	if id == "" || chatID == "" || label == "" || roomID == "" {
		return ErrInvalidInput
	}
	var roomExists int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM rooms WHERE id = ?`, roomID).Scan(&roomExists); err != nil {
		return err
	}
	if roomExists == 0 {
		return ErrInvalidInput
	}
	res, err := s.db.ExecContext(ctx, `UPDATE telegram_mappings SET chat_id = ?, label = ?, room_id = ? WHERE id = ?`,
		chatID, label, roomID, id)
	if err != nil {
		if isUniqueConstraintErr(err) {
			return ErrConflict
		}
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteTelegramMapping(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrInvalidInput
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM telegram_mappings WHERE id = ?`, id)
	if err != nil {
		return err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListTelegramMappings(ctx context.Context) ([]TelegramMapping, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, chat_id, label, room_id FROM telegram_mappings ORDER BY label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var mappings []TelegramMapping
	for rows.Next() {
		var m TelegramMapping
		if err := rows.Scan(&m.ID, &m.ChatID, &m.Label, &m.RoomID); err != nil {
			return nil, err
		}
		mappings = append(mappings, m)
	}
	return mappings, nil
}

func (s *Store) FindTelegramMappingByChatID(ctx context.Context, chatID string) (TelegramMapping, error) {
	var m TelegramMapping
	err := s.db.QueryRowContext(ctx, `SELECT id, chat_id, label, room_id FROM telegram_mappings WHERE chat_id = ?`, chatID).
		Scan(&m.ID, &m.ChatID, &m.Label, &m.RoomID)
	return m, err
}

func (s *Store) FindTelegramMappingsByRoomID(ctx context.Context, roomID string) ([]TelegramMapping, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, chat_id, label, room_id FROM telegram_mappings WHERE room_id = ?`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var mappings []TelegramMapping
	for rows.Next() {
		var m TelegramMapping
		if err := rows.Scan(&m.ID, &m.ChatID, &m.Label, &m.RoomID); err != nil {
			return nil, err
		}
		mappings = append(mappings, m)
	}
	return mappings, nil
}
