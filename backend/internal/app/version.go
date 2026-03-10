package app

import (
	"time"
)

// Version and BuildTimestamp are set during build via ldflags.
// For local development builds, they default to "dev" and current time.
var (
	// Version is the application version, set via -ldflags "-X github.com/KesherCom/kesher/backend/internal/app.Version=..."
	Version string
	// BuildTimestamp is the build timestamp in RFC3339 format, set via -ldflags
	BuildTimestamp string
)

func init() {
	if Version == "" {
		Version = "local build"
	}
	if BuildTimestamp == "" {
		BuildTimestamp = time.Now().Format(time.RFC3339)
	}
}

// VersionInfo represents the version and build information.
type VersionInfo struct {
	Version        string `json:"version"`
	BuildTimestamp string `json:"buildTimestamp"`
}

// GetVersionInfo returns the current version and build timestamp.
func GetVersionInfo() VersionInfo {
	parsedTime, err := time.Parse(time.RFC3339, BuildTimestamp)
	if err != nil {
		// If timestamp can't be parsed, just return as-is
		return VersionInfo{
			Version:        Version,
			BuildTimestamp: BuildTimestamp,
		}
	}
	// Return formatted build timestamp
	return VersionInfo{
		Version:        Version,
		BuildTimestamp: parsedTime.Format("2006-01-02 15:04:05 MST"),
	}
}
