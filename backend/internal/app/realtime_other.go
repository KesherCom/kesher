//go:build !windows

package app

import "log/slog"

// tuneProcessForRealtimeAudio is Windows-specific (see realtime_windows.go).
func tuneProcessForRealtimeAudio(*slog.Logger) {}
