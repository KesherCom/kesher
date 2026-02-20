package app

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func NewStore(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
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
		`CREATE TABLE IF NOT EXISTS broadcast_groups (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE
		);`,
		`CREATE TABLE IF NOT EXISTS broadcast_group_rooms (
			broadcast_group_id TEXT NOT NULL,
			room_id TEXT NOT NULL,
			PRIMARY KEY (broadcast_group_id, room_id)
		);`,
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			role_id TEXT NOT NULL
		);`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) seed(ctx context.Context) error {
	roles := []Role{
		{ID: "audio", Name: "Audio"},
		{ID: "video", Name: "Video"},
		{ID: "lighting", Name: "Lighting"},
		{ID: "broadcast", Name: "Broadcast"},
		{ID: "camera", Name: "Camera"},
		{ID: "pastor", Name: "Pastor"},
		{ID: "producer", Name: "Producer"},
	}
	for _, role := range roles {
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO roles (id, name) VALUES (?, ?)`, role.ID, role.Name); err != nil {
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
	for _, roomID := range []string{"foh", "stage", "video-control", "livestream", "lighting-booth"} {
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES ('all-tech', ?)`, roomID); err != nil {
			return err
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
	rows, err := s.db.QueryContext(ctx, `SELECT id, name FROM roles ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			return nil, err
		}
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
		var g BroadcastGroup
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
		groups = append(groups, g)
	}
	return groups, nil
}

func (s *Store) BroadcastGroupRoomSet(ctx context.Context, groupID string) (map[string]struct{}, error) {
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
	return out, nil
}
