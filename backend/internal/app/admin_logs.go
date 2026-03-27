package app

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	adminLogFilePrefix       = "admin-"
	adminLogFileExt          = ".log"
	adminLogDateLayout       = "2006-01-02"
	adminLogDefaultLimit     = 200
	adminLogMaxLimit         = 1000
	adminLogMaxExportLines   = 5000
	adminLogDefaultRetention = 7 * 24 * time.Hour
)

type AdminLogEntry struct {
	TimestampUnixMs int64  `json:"timestampUnixMs"`
	Level           string `json:"level"`
	Category        string `json:"category"`
	Message         string `json:"message"`
	Method          string `json:"method,omitempty"`
	Path            string `json:"path,omitempty"`
	Status          int    `json:"status,omitempty"`
	DurationMs      int64  `json:"durationMs,omitempty"`
	Username        string `json:"username,omitempty"`
	RoleID          string `json:"roleId,omitempty"`
	RemoteAddr      string `json:"remoteAddr,omitempty"`
	Error           string `json:"error,omitempty"`
}

type AdminLogsResponse struct {
	Entries         []AdminLogEntry `json:"entries"`
	Total           int             `json:"total"`
	TimestampUnixMs int64           `json:"timestampUnixMs"`
}

type adminLogQuery struct {
	Level    string
	Category string
	Text     string
	From     int64
	To       int64
	Limit    int
	Offset   int
}

type adminLogStore struct {
	dir         string
	retention   time.Duration
	mu          sync.Mutex
	lastCleanup time.Time
}

func newAdminLogStore(cfg Config) (*adminLogStore, error) {
	dir := filepath.Join(defaultAdminLogBaseDir(cfg), "admin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create admin log dir: %w", err)
	}
	return &adminLogStore{dir: dir, retention: adminLogDefaultRetention}, nil
}

func defaultAdminLogBaseDir(cfg Config) string {
	dbPath := strings.TrimSpace(cfg.DBPath)
	if dbPath == "" || dbPath == ":memory:" {
		return filepath.Join(os.TempDir(), "kesher-logs")
	}
	dbDir := filepath.Dir(dbPath)
	if dbDir == "." || dbDir == "" {
		return "logs"
	}
	return filepath.Join(dbDir, "logs")
}

func (l *adminLogStore) append(entry AdminLogEntry) error {
	if entry.TimestampUnixMs <= 0 {
		entry.TimestampUnixMs = time.Now().UnixMilli()
	}
	entry.Level = strings.ToUpper(strings.TrimSpace(entry.Level))
	if entry.Level == "" {
		entry.Level = "INFO"
	}
	entry.Category = strings.ToLower(strings.TrimSpace(entry.Category))
	if entry.Category == "" {
		entry.Category = "system"
	}
	entry.Message = strings.TrimSpace(entry.Message)
	if entry.Message == "" {
		entry.Message = "event"
	}

	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}

	now := time.UnixMilli(entry.TimestampUnixMs)
	filePath := filepath.Join(l.dir, adminLogFilePrefix+now.Format(adminLogDateLayout)+adminLogFileExt)

	l.mu.Lock()
	defer l.mu.Unlock()

	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	if time.Since(l.lastCleanup) > time.Hour {
		l.cleanupLocked(now)
	}
	return nil
}

func (l *adminLogStore) cleanupLocked(now time.Time) {
	cutoff := now.Add(-l.retention)
	paths, err := filepath.Glob(filepath.Join(l.dir, adminLogFilePrefix+"*"+adminLogFileExt))
	if err != nil {
		l.lastCleanup = now
		return
	}
	for _, p := range paths {
		name := filepath.Base(p)
		datePart := strings.TrimSuffix(strings.TrimPrefix(name, adminLogFilePrefix), adminLogFileExt)
		day, err := time.ParseInLocation(adminLogDateLayout, datePart, time.Local)
		if err != nil {
			continue
		}
		if day.Before(cutoff) {
			_ = os.Remove(p)
		}
	}
	l.lastCleanup = now
}

func (l *adminLogStore) read(query adminLogQuery, maxLimit int) ([]AdminLogEntry, int, error) {
	if maxLimit <= 0 {
		maxLimit = adminLogMaxLimit
	}
	if query.Limit <= 0 {
		query.Limit = adminLogDefaultLimit
	}
	if query.Limit > maxLimit {
		query.Limit = maxLimit
	}
	if query.Offset < 0 {
		query.Offset = 0
	}

	paths, err := filepath.Glob(filepath.Join(l.dir, adminLogFilePrefix+"*"+adminLogFileExt))
	if err != nil {
		return nil, 0, err
	}
	sort.Strings(paths)

	entries := make([]AdminLogEntry, 0, 256)
	for _, p := range paths {
		file, err := os.Open(p)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			var entry AdminLogEntry
			if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
				continue
			}
			if matchesAdminLogQuery(entry, query) {
				entries = append(entries, entry)
			}
		}
		_ = file.Close()
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].TimestampUnixMs > entries[j].TimestampUnixMs
	})
	total := len(entries)
	if query.Offset >= total {
		return []AdminLogEntry{}, total, nil
	}
	end := query.Offset + query.Limit
	if end > total {
		end = total
	}
	return entries[query.Offset:end], total, nil
}

func matchesAdminLogQuery(entry AdminLogEntry, query adminLogQuery) bool {
	if query.From > 0 && entry.TimestampUnixMs < query.From {
		return false
	}
	if query.To > 0 && entry.TimestampUnixMs > query.To {
		return false
	}
	if query.Level != "" && !strings.EqualFold(entry.Level, query.Level) {
		return false
	}
	if query.Category != "" && !strings.EqualFold(entry.Category, query.Category) {
		return false
	}
	if query.Text != "" {
		needle := strings.ToLower(query.Text)
		haystack := strings.ToLower(strings.Join([]string{
			entry.Message,
			entry.Path,
			entry.Method,
			entry.Username,
			entry.RoleID,
			entry.Error,
		}, " "))
		if !strings.Contains(haystack, needle) {
			return false
		}
	}
	return true
}

func (s *Server) appendAdminLog(entry AdminLogEntry) {
	if s.adminLogs == nil {
		return
	}
	if err := s.adminLogs.append(entry); err != nil && s.logger != nil {
		s.logger.Warn("failed to append admin log", "error", err)
	}
}

func (s *Server) logAdminAction(session Session, method, path, message string, status int) {
	s.appendAdminLog(AdminLogEntry{
		TimestampUnixMs: time.Now().UnixMilli(),
		Level:           "INFO",
		Category:        "audit",
		Message:         message,
		Method:          method,
		Path:            path,
		Status:          status,
		Username:        session.Username,
		RoleID:          session.RoleID,
	})
}

type responseStatusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *responseStatusRecorder) WriteHeader(statusCode int) {
	r.status = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *responseStatusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (r *responseStatusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijacker not supported")
	}
	return h.Hijack()
}

func (r *responseStatusRecorder) Flush() {
	f, ok := r.ResponseWriter.(http.Flusher)
	if ok {
		f.Flush()
	}
}

func (r *responseStatusRecorder) Push(target string, opts *http.PushOptions) error {
	p, ok := r.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return p.Push(target, opts)
}

func (s *Server) withRequestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &responseStatusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		status := rec.status
		if status == 0 {
			status = http.StatusOK
		}
		path := r.URL.Path
		if !(strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/ws")) {
			return
		}
		if r.Method == http.MethodOptions {
			return
		}

		entry := AdminLogEntry{
			TimestampUnixMs: time.Now().UnixMilli(),
			Level:           requestLogLevel(status),
			Category:        "request",
			Message:         "http request",
			Method:          r.Method,
			Path:            path,
			Status:          status,
			DurationMs:      time.Since(start).Milliseconds(),
			RemoteAddr:      r.RemoteAddr,
		}
		auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if auth != "" && s.sessions != nil {
			if session, ok := s.sessions.Get(auth); ok {
				entry.Username = session.Username
				entry.RoleID = session.RoleID
			}
		}
		s.appendAdminLog(entry)

		if strings.HasPrefix(path, "/api/admin/") && r.Method != http.MethodGet {
			auditEntry := entry
			auditEntry.Category = "audit"
			auditEntry.Message = "admin request"
			s.appendAdminLog(auditEntry)
		}
	})
}

func requestLogLevel(status int) string {
	switch {
	case status >= 500:
		return "ERROR"
	case status >= 400:
		return "WARN"
	default:
		return "INFO"
	}
}

func (s *Server) handleAdminLogs(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.adminLogs == nil {
		http.Error(w, "admin logs unavailable", http.StatusServiceUnavailable)
		return
	}
	query, err := parseAdminLogQuery(r, adminLogMaxLimit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	entries, total, err := s.adminLogs.read(query, adminLogMaxLimit)
	if err != nil {
		s.internalErr(w, err)
		return
	}
	s.writeJSON(w, http.StatusOK, AdminLogsResponse{
		Entries:         entries,
		Total:           total,
		TimestampUnixMs: time.Now().UnixMilli(),
	})
}

func (s *Server) handleAdminLogsExport(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.requireAdmin(w, r, session) {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.adminLogs == nil {
		http.Error(w, "admin logs unavailable", http.StatusServiceUnavailable)
		return
	}
	query, err := parseAdminLogQuery(r, adminLogMaxExportLines)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("limit")) == "" {
		query.Limit = adminLogMaxExportLines
	}
	entries, _, err := s.adminLogs.read(query, adminLogMaxExportLines)
	if err != nil {
		s.internalErr(w, err)
		return
	}

	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		lines = append(lines, formatAdminLogTextLine(entry))
	}
	payload := strings.Join(lines, "\n")
	if payload != "" {
		payload += "\n"
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=kesher-admin-logs.txt")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(payload))
}

func formatAdminLogTextLine(entry AdminLogEntry) string {
	ts := time.UnixMilli(entry.TimestampUnixMs).Format(time.RFC3339)
	parts := []string{
		"[" + ts + "]",
		strings.ToUpper(entry.Level),
		strings.ToLower(entry.Category),
	}
	if entry.Method != "" || entry.Path != "" {
		parts = append(parts, strings.TrimSpace(entry.Method+" "+entry.Path))
	}
	if entry.Status > 0 {
		parts = append(parts, "status="+strconv.Itoa(entry.Status))
	}
	if entry.DurationMs > 0 {
		parts = append(parts, "durationMs="+strconv.FormatInt(entry.DurationMs, 10))
	}
	if entry.Username != "" {
		parts = append(parts, "user="+entry.Username)
	}
	if entry.RoleID != "" {
		parts = append(parts, "role="+entry.RoleID)
	}
	if entry.RemoteAddr != "" {
		parts = append(parts, "remote="+entry.RemoteAddr)
	}
	if entry.Error != "" {
		parts = append(parts, "error="+entry.Error)
	}
	parts = append(parts, entry.Message)
	return strings.Join(parts, " | ")
}

func parseAdminLogQuery(r *http.Request, maxLimit int) (adminLogQuery, error) {
	query := adminLogQuery{
		Level:    strings.TrimSpace(r.URL.Query().Get("level")),
		Category: strings.TrimSpace(r.URL.Query().Get("category")),
		Text:     strings.TrimSpace(r.URL.Query().Get("q")),
		Limit:    adminLogDefaultLimit,
	}
	if maxLimit <= 0 {
		maxLimit = adminLogMaxLimit
	}
	if limitRaw := strings.TrimSpace(r.URL.Query().Get("limit")); limitRaw != "" {
		limit, err := strconv.Atoi(limitRaw)
		if err != nil {
			return query, errors.New("invalid limit")
		}
		if limit < 1 {
			return query, errors.New("limit must be >= 1")
		}
		if limit > maxLimit {
			limit = maxLimit
		}
		query.Limit = limit
	}
	if offsetRaw := strings.TrimSpace(r.URL.Query().Get("offset")); offsetRaw != "" {
		offset, err := strconv.Atoi(offsetRaw)
		if err != nil {
			return query, errors.New("invalid offset")
		}
		if offset < 0 {
			return query, errors.New("offset must be >= 0")
		}
		query.Offset = offset
	}
	if fromRaw := strings.TrimSpace(r.URL.Query().Get("from")); fromRaw != "" {
		from, err := strconv.ParseInt(fromRaw, 10, 64)
		if err != nil {
			return query, errors.New("invalid from")
		}
		query.From = from
	}
	if toRaw := strings.TrimSpace(r.URL.Query().Get("to")); toRaw != "" {
		to, err := strconv.ParseInt(toRaw, 10, 64)
		if err != nil {
			return query, errors.New("invalid to")
		}
		query.To = to
	}
	return query, nil
}
