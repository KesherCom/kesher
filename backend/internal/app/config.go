package app

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr           string
	StaticDir      string
	DBPath         string
	AllowCORS      bool
	SessionTTL     time.Duration
	TrustedLANHTTP bool
}

func LoadConfig() Config {
	return Config{
		Addr:           getEnv("APP_ADDR", ":8080"),
		StaticDir:      getEnv("STATIC_DIR", ""),
		DBPath:         getEnv("DB_PATH", "intercom.db"),
		AllowCORS:      getEnv("ALLOW_CORS", "true") == "true",
		SessionTTL:     time.Duration(getEnvInt("SESSION_TTL_MINUTES", 720)) * time.Minute,
		TrustedLANHTTP: getEnv("TRUSTED_LAN_HTTP", "true") == "true",
	}
}

func getEnv(k, fallback string) string {
	v := os.Getenv(k)
	if v == "" {
		return fallback
	}
	return v
}

func getEnvInt(k string, fallback int) int {
	v := os.Getenv(k)
	if v == "" {
		return fallback
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return i
}
