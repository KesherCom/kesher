package app

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Addr                        string
	StaticDir                   string
	DBPath                      string
	AllowCORS                   bool
	AdminPIN                    string
	AdminPINFromEnv             bool
	SessionTTL                  time.Duration
	DisconnectLogoutDelay       time.Duration
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
	CompanionSharedSecret       string
	CompanionAllowedUsernames   []string
	CompanionImageEffectMapFile string
	CompanionDynamicPaging      bool
	// Native low-latency UDP audio relay (performance mode). Empty UDPAudioAddr
	// disables the relay; native clients then fall back to the WebRTC pipeline.
	UDPAudioAddr        string
	UDPAudioAdvertiseIP string
}
type fileConfig struct {
	Addr                               string   `yaml:"app_addr"`
	StaticDir                          string   `yaml:"static_dir"`
	DBPath                             string   `yaml:"db_path"`
	AllowCORS                          *bool    `yaml:"allow_cors"`
	AdminPIN                           string   `yaml:"admin_pin"`
	SessionTTLMinutes                  *int     `yaml:"session_ttl_minutes"`
	DisconnectLogoutDelaySeconds       *int     `yaml:"disconnect_logout_delay_seconds"`
	TrustedLANHTTP                     *bool    `yaml:"trusted_lan_http"`
	TLSMode                            string   `yaml:"tls_mode"`
	TLSCertFile                        string   `yaml:"tls_cert_file"`
	TLSKeyFile                         string   `yaml:"tls_key_file"`
	ProductionMode                     *bool    `yaml:"production_mode"`
	ProductionHTTPSAddr                string   `yaml:"production_https_addr"`
	ProductionHTTPRedirectAddr         string   `yaml:"production_http_redirect_addr"`
	CertMagicDomains                   []string `yaml:"certmagic_domains"`
	CertMagicEmail                     string   `yaml:"certmagic_email"`
	CertMagicCA                        string   `yaml:"certmagic_ca"`
	CertMagicStoragePath               string   `yaml:"certmagic_storage_path"`
	CertMagicChallenge                 string   `yaml:"certmagic_challenge"`
	CertMagicDNSProvider               string   `yaml:"certmagic_dns_provider"`
	CertMagicPropagationDelaySeconds   *int     `yaml:"certmagic_propagation_delay_seconds"`
	CertMagicPropagationTimeoutSeconds *int     `yaml:"certmagic_propagation_timeout_seconds"`
	CertMagicResolvers                 []string `yaml:"certmagic_dns_resolvers"`
	TelegramBotToken                   string   `yaml:"telegram_bot_token"`
	TelegramWebhookSecret              string   `yaml:"telegram_webhook_secret"`
	TelegramMode                       string   `yaml:"telegram_mode"`
	CompanionSharedSecret              string   `yaml:"companion_shared_secret"`
	CompanionAllowedUsernames          []string `yaml:"companion_allowed_usernames"`
	CompanionImageEffectMapFile        string   `yaml:"companion_image_effect_map_file"`
	CompanionDynamicPaging             *bool    `yaml:"companion_dynamic_paging"`
	UDPAudioAddr                       string   `yaml:"udp_audio_addr"`
	UDPAudioAdvertiseIP                string   `yaml:"udp_audio_advertise_ip"`
}

func getEnvWithPresence(k, fallback string) (string, bool) {
	v, ok := os.LookupEnv(k)
	if !ok {
		return fallback, false
	}
	return v, true
}
func defaultConfig() Config {
	return Config{
		Addr:                        ":8080",
		StaticDir:                   "",
		DBPath:                      "intercom.db",
		AllowCORS:                   true,
		AdminPIN:                    "123456",
		AdminPINFromEnv:             false,
		SessionTTL:                  720 * time.Minute,
		DisconnectLogoutDelay:       60 * time.Second,
		TrustedLANHTTP:              true,
		TLSMode:                     "internal",
		TLSCertFile:                 "",
		TLSKeyFile:                  "",
		ProductionMode:              false,
		ProductionHTTPSAddr:         ":443",
		ProductionHTTPRedirectAddr:  ":80",
		CertMagicDomains:            nil,
		CertMagicEmail:              "",
		CertMagicCA:                 "https://acme-v02.api.letsencrypt.org/directory",
		CertMagicStoragePath:        "./certmagic-data",
		CertMagicChallenge:          "dns-01",
		CertMagicDNSProvider:        "",
		CertMagicPropagationDelay:   0,
		CertMagicPropagationTimeout: 120 * time.Second,
		CertMagicResolvers:          nil,
		TelegramBotToken:            "",
		TelegramWebhookSecret:       "",
		TelegramMode:                "polling",
		CompanionSharedSecret:       "",
		CompanionAllowedUsernames:   nil,
		CompanionImageEffectMapFile: "image-effect-map.json",
		CompanionDynamicPaging:      false,
		UDPAudioAddr:                ":8081",
		UDPAudioAdvertiseIP:         "",
	}
}

func LoadConfig() (Config, error) {
	if configPath := strings.TrimSpace(getAnyEnv("APP_CONFIG_FILE", "CONFIG_FILE")); configPath != "" {
		return loadConfigFromFile(configPath)
	}
	if cfg, ok, err := loadConfigFromDefaultFile(); ok || err != nil {
		return cfg, err
	}
	return loadConfigFromEnv(), nil
}

func loadConfigFromDefaultFile() (Config, bool, error) {
	for _, name := range []string{"config.yaml", "config.yml"} {
		cfg, loaded, err := tryLoadConfigFile(name)
		if loaded || err != nil {
			return cfg, loaded, err
		}
	}
	return Config{}, false, nil
}

func tryLoadConfigFile(path string) (Config, bool, error) {
	_, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, false, nil
		}
		return Config{}, false, fmt.Errorf("failed to check config file %q: %w", path, err)
	}
	cfg, err := loadConfigFromFile(path)
	if err != nil {
		return Config{}, true, err
	}
	return cfg, true, nil
}

func loadConfigFromFile(path string) (Config, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("failed to read config file %q: %w", path, err)
	}
	var fileCfg fileConfig
	if err := yaml.Unmarshal(content, &fileCfg); err != nil {
		return Config{}, fmt.Errorf("failed to parse config file %q: %w", path, err)
	}
	cfg := defaultConfig()
	if fileCfg.Addr != "" {
		cfg.Addr = fileCfg.Addr
	}
	if fileCfg.StaticDir != "" {
		cfg.StaticDir = fileCfg.StaticDir
	}
	if fileCfg.DBPath != "" {
		cfg.DBPath = fileCfg.DBPath
	}
	if fileCfg.AllowCORS != nil {
		cfg.AllowCORS = *fileCfg.AllowCORS
	}
	if fileCfg.AdminPIN != "" {
		cfg.AdminPIN = fileCfg.AdminPIN
	}
	cfg.AdminPINFromEnv = false
	if fileCfg.SessionTTLMinutes != nil {
		cfg.SessionTTL = time.Duration(*fileCfg.SessionTTLMinutes) * time.Minute
	}
	if fileCfg.DisconnectLogoutDelaySeconds != nil {
		cfg.DisconnectLogoutDelay = time.Duration(*fileCfg.DisconnectLogoutDelaySeconds) * time.Second
	}
	if fileCfg.TrustedLANHTTP != nil {
		cfg.TrustedLANHTTP = *fileCfg.TrustedLANHTTP
	}
	if fileCfg.TLSMode != "" {
		cfg.TLSMode = fileCfg.TLSMode
	}
	if fileCfg.TLSCertFile != "" {
		cfg.TLSCertFile = fileCfg.TLSCertFile
	}
	if fileCfg.TLSKeyFile != "" {
		cfg.TLSKeyFile = fileCfg.TLSKeyFile
	}
	if fileCfg.ProductionMode != nil {
		cfg.ProductionMode = *fileCfg.ProductionMode
	}
	if fileCfg.ProductionHTTPSAddr != "" {
		cfg.ProductionHTTPSAddr = fileCfg.ProductionHTTPSAddr
	}
	if fileCfg.ProductionHTTPRedirectAddr != "" {
		cfg.ProductionHTTPRedirectAddr = fileCfg.ProductionHTTPRedirectAddr
	}
	if len(fileCfg.CertMagicDomains) > 0 {
		cfg.CertMagicDomains = append([]string{}, fileCfg.CertMagicDomains...)
	}
	if fileCfg.CertMagicEmail != "" {
		cfg.CertMagicEmail = fileCfg.CertMagicEmail
	}
	if fileCfg.CertMagicCA != "" {
		cfg.CertMagicCA = fileCfg.CertMagicCA
	}
	if fileCfg.CertMagicStoragePath != "" {
		cfg.CertMagicStoragePath = fileCfg.CertMagicStoragePath
	}
	if fileCfg.CertMagicChallenge != "" {
		cfg.CertMagicChallenge = fileCfg.CertMagicChallenge
	}
	if fileCfg.CertMagicDNSProvider != "" {
		cfg.CertMagicDNSProvider = fileCfg.CertMagicDNSProvider
	}
	if fileCfg.CertMagicPropagationDelaySeconds != nil {
		cfg.CertMagicPropagationDelay = time.Duration(*fileCfg.CertMagicPropagationDelaySeconds) * time.Second
	}
	if fileCfg.CertMagicPropagationTimeoutSeconds != nil {
		cfg.CertMagicPropagationTimeout = time.Duration(*fileCfg.CertMagicPropagationTimeoutSeconds) * time.Second
	}
	if len(fileCfg.CertMagicResolvers) > 0 {
		cfg.CertMagicResolvers = append([]string{}, fileCfg.CertMagicResolvers...)
	}
	if fileCfg.TelegramBotToken != "" {
		cfg.TelegramBotToken = fileCfg.TelegramBotToken
	}
	if fileCfg.TelegramWebhookSecret != "" {
		cfg.TelegramWebhookSecret = fileCfg.TelegramWebhookSecret
	}
	if fileCfg.TelegramMode != "" {
		cfg.TelegramMode = fileCfg.TelegramMode
	}
	if fileCfg.CompanionSharedSecret != "" {
		cfg.CompanionSharedSecret = fileCfg.CompanionSharedSecret
	}
	if len(fileCfg.CompanionAllowedUsernames) > 0 {
		cfg.CompanionAllowedUsernames = append([]string{}, splitCSV(strings.Join(fileCfg.CompanionAllowedUsernames, ","))...)
	}
	if strings.TrimSpace(fileCfg.CompanionImageEffectMapFile) != "" {
		cfg.CompanionImageEffectMapFile = strings.TrimSpace(fileCfg.CompanionImageEffectMapFile)
	}
	if fileCfg.CompanionDynamicPaging != nil {
		cfg.CompanionDynamicPaging = *fileCfg.CompanionDynamicPaging
	}
	if strings.TrimSpace(fileCfg.UDPAudioAddr) != "" {
		cfg.UDPAudioAddr = strings.TrimSpace(fileCfg.UDPAudioAddr)
	}
	if strings.TrimSpace(fileCfg.UDPAudioAdvertiseIP) != "" {
		cfg.UDPAudioAdvertiseIP = strings.TrimSpace(fileCfg.UDPAudioAdvertiseIP)
	}
	return cfg, nil
}

func loadConfigFromEnv() Config {
	adminPIN, adminPINFromEnv := getEnvWithPresence("ADMIN_PIN", "123456")
	return Config{
		Addr:                       getEnv("APP_ADDR", ":8080"),
		StaticDir:                  getEnv("STATIC_DIR", ""),
		DBPath:                     getEnv("DB_PATH", "intercom.db"),
		AllowCORS:                  getEnv("ALLOW_CORS", "true") == "true",
		AdminPIN:                   adminPIN,
		AdminPINFromEnv:            adminPINFromEnv,
		SessionTTL:                 time.Duration(getEnvInt("SESSION_TTL_MINUTES", 720)) * time.Minute,
		DisconnectLogoutDelay:      time.Duration(getEnvInt("DISCONNECT_LOGOUT_DELAY_SECONDS", 60)) * time.Second,
		TrustedLANHTTP:             getEnv("TRUSTED_LAN_HTTP", "true") == "true",
		TLSMode:                    getEnv("TLS_MODE", "internal"),
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
		CertMagicResolvers:        splitCSV(getEnv("CERTMAGIC_DNS_RESOLVERS", "")),
		TelegramBotToken:          getEnv("TELEGRAM_BOT_TOKEN", ""),
		TelegramWebhookSecret:     getEnv("TELEGRAM_WEBHOOK_SECRET", ""),
		TelegramMode:              getEnv("TELEGRAM_MODE", "polling"),
		CompanionSharedSecret:     getEnv("COMPANION_SHARED_SECRET", ""),
		CompanionAllowedUsernames: splitCSV(getEnv("COMPANION_ALLOWED_USERNAMES", "")),
		CompanionImageEffectMapFile: getEnv(
			"COMPANION_IMAGE_EFFECT_MAP_FILE",
			"image-effect-map.json",
		),
		CompanionDynamicPaging: getEnv("COMPANION_DYNAMIC_PAGING", "false") == "true",
		UDPAudioAddr:           getEnv("UDP_AUDIO_ADDR", ":8081"),
		UDPAudioAdvertiseIP:    getEnv("UDP_AUDIO_ADVERTISE_IP", ""),
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
