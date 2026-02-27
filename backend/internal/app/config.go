package app

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr                        string
	StaticDir                   string
	DBPath                      string
	AllowCORS                   bool
	SessionTTL                  time.Duration
	TrustedLANHTTP              bool
	TLSMode                     string
	TLSCertFile                 string
	TLSKeyFile                  string
	ProductionMode              bool
	ProductionHTTPSAddr         string
	ProductionHTTPRedirectAddr  string
	CertMagicDomains            []string
	CertMagicEmail              string
	CertMagicCA                 string
	CertMagicStoragePath        string
	CertMagicChallenge          string
	CertMagicDNSProvider        string
	CertMagicPropagationDelay   time.Duration
	CertMagicPropagationTimeout time.Duration
	CertMagicResolvers          []string
	TelegramBotToken            string
	TelegramWebhookSecret       string
	TelegramMode                string // "polling" (default) or "webhook"
}

func LoadConfig() Config {
	return Config{
		Addr:                       getEnv("APP_ADDR", ":8080"),
		StaticDir:                  getEnv("STATIC_DIR", ""),
		DBPath:                     getEnv("DB_PATH", "intercom.db"),
		AllowCORS:                  getEnv("ALLOW_CORS", "true") == "true",
		SessionTTL:                 time.Duration(getEnvInt("SESSION_TTL_MINUTES", 720)) * time.Minute,
		TrustedLANHTTP:             getEnv("TRUSTED_LAN_HTTP", "true") == "true",
		TLSMode:                    getEnv("TLS_MODE", "file"),
		TLSCertFile:                getEnv("TLS_CERT_FILE", ""),
		TLSKeyFile:                 getEnv("TLS_KEY_FILE", ""),
		ProductionMode:             getEnv("PRODUCTION_MODE", "false") == "true",
		ProductionHTTPSAddr:        getEnv("PRODUCTION_HTTPS_ADDR", ":443"),
		ProductionHTTPRedirectAddr: getEnv("PRODUCTION_HTTP_REDIRECT_ADDR", ":80"),
		CertMagicDomains:           splitCSV(getEnv("CERTMAGIC_DOMAINS", "")),
		CertMagicEmail:             getEnv("CERTMAGIC_EMAIL", ""),
		CertMagicCA:                getEnv("CERTMAGIC_CA", "https://acme-v02.api.letsencrypt.org/directory"),
		CertMagicStoragePath:       getEnv("CERTMAGIC_STORAGE_PATH", "./certmagic-data"),
		CertMagicChallenge:         getEnv("CERTMAGIC_CHALLENGE", "dns-01"),
		CertMagicDNSProvider:       getEnv("CERTMAGIC_DNS_PROVIDER", ""),
		CertMagicPropagationDelay:  time.Duration(getEnvInt("CERTMAGIC_PROPAGATION_DELAY_SECONDS", 0)) * time.Second,
		CertMagicPropagationTimeout: time.Duration(
			getEnvInt("CERTMAGIC_PROPAGATION_TIMEOUT_SECONDS", 120),
		) * time.Second,
		CertMagicResolvers: splitCSV(getEnv("CERTMAGIC_DNS_RESOLVERS", "")),
		TelegramBotToken:      getEnv("TELEGRAM_BOT_TOKEN", ""),
		TelegramWebhookSecret: getEnv("TELEGRAM_WEBHOOK_SECRET", ""),
		TelegramMode:          getEnv("TELEGRAM_MODE", "polling"),
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

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
