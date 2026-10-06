//go:build !windows

package app

import (
	"log/slog"
	"syscall"
)

// tuneProcessForRealtimeAudio is Windows-specific (see realtime_windows.go).
func tuneProcessForRealtimeAudio(*slog.Logger) {}

// processCPUSeconds is the user+system CPU time this process has used.
func processCPUSeconds() float64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	sec := func(tv syscall.Timeval) float64 { return float64(tv.Sec) + float64(tv.Usec)/1e6 }
	return sec(ru.Utime) + sec(ru.Stime)
}
