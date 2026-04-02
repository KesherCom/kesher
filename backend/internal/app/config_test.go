package app

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestSplitCSV(t *testing.T) {
	got := splitCSV(" foh, stage ,,video-control ")
	want := []string{"foh", "stage", "video-control"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected split result: got %v want %v", got, want)
	}
}

func TestLoadConfigFromEnvDefaultsToInternalTLSMode(t *testing.T) {
	t.Setenv("APP_CONFIG_FILE", "")
	t.Setenv("CONFIG_FILE", "")
	t.Setenv("TLS_MODE", "")
	cfg := loadConfigFromEnv()
	if cfg.TLSMode != "internal" {
		t.Fatalf("expected default TLS mode to be internal, got %q", cfg.TLSMode)
	}
	if cfg.DisconnectLogoutDelay != 60*time.Second {
		t.Fatalf("expected default disconnect logout delay to be 60s, got %s", cfg.DisconnectLogoutDelay)
	}
}

func TestGetEnvIntFallbackOnInvalidValue(t *testing.T) {
	t.Setenv("TEST_ENV_INT", "not-a-number")
	if got := getEnvInt("TEST_ENV_INT", 42); got != 42 {
		t.Fatalf("expected fallback for invalid int, got %d", got)
	}
}

func TestGetAnyEnvPrefersFirstNonEmptyTrimmedValue(t *testing.T) {
	t.Setenv("TEST_ENV_PRIMARY", "   ")
	t.Setenv("TEST_ENV_SECONDARY", " token ")
	if got := getAnyEnv("TEST_ENV_PRIMARY", "TEST_ENV_SECONDARY"); got != "token" {
		t.Fatalf("unexpected env value: %q", got)
	}
}

func TestGetEnvUsesFallbackWhenUnset(t *testing.T) {
	const key = "TEST_ENV_UNSET"
	_ = os.Unsetenv(key)
	if got := getEnv(key, "fallback"); got != "fallback" {
		t.Fatalf("expected fallback, got %q", got)
	}
}

func TestLoadConfigPrefersConfigFileOverEnv(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	content := []byte("app_addr: \":9999\"\n" +
		"allow_cors: false\n" +
		"session_ttl_minutes: 10\n" +
		"disconnect_logout_delay_seconds: 45\n" +
		"certmagic_domains:\n" +
		"  - intercom.example.org\n")
	if err := os.WriteFile(configPath, content, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}

	t.Setenv("APP_CONFIG_FILE", configPath)
	t.Setenv("APP_ADDR", ":8080")
	t.Setenv("ALLOW_CORS", "true")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("expected config load to succeed, got: %v", err)
	}
	if cfg.Addr != ":9999" {
		t.Fatalf("expected addr from yaml, got %q", cfg.Addr)
	}
	if cfg.AllowCORS {
		t.Fatalf("expected allow_cors=false from yaml")
	}
	if cfg.SessionTTL != 10*time.Minute {
		t.Fatalf("expected session ttl to be 10m, got %s", cfg.SessionTTL)
	}
	if cfg.DisconnectLogoutDelay != 45*time.Second {
		t.Fatalf("expected disconnect logout delay to be 45s, got %s", cfg.DisconnectLogoutDelay)
	}
	if !reflect.DeepEqual(cfg.CertMagicDomains, []string{"intercom.example.org"}) {
		t.Fatalf("unexpected certmagic domains: %v", cfg.CertMagicDomains)
	}
}

func TestLoadConfigFallsBackToEnvWhenNoConfigFile(t *testing.T) {
	t.Setenv("APP_CONFIG_FILE", "")
	t.Setenv("CONFIG_FILE", "")
	t.Setenv("APP_ADDR", ":7010")
	t.Setenv("DISCONNECT_LOGOUT_DELAY_SECONDS", "75")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("expected config load to succeed, got: %v", err)
	}
	if cfg.Addr != ":7010" {
		t.Fatalf("expected addr from env, got %q", cfg.Addr)
	}
	if cfg.DisconnectLogoutDelay != 75*time.Second {
		t.Fatalf("expected disconnect logout delay from env, got %s", cfg.DisconnectLogoutDelay)
	}
}

func TestLoadConfigReadsCompanionAllowedUsernamesFromEnv(t *testing.T) {
	t.Setenv("APP_CONFIG_FILE", "")
	t.Setenv("CONFIG_FILE", "")
	t.Setenv("COMPANION_ALLOWED_USERNAMES", "alice,bob , carol")

	cfg := loadConfigFromEnv()
	want := []string{"alice", "bob", "carol"}
	if !reflect.DeepEqual(cfg.CompanionAllowedUsernames, want) {
		t.Fatalf("unexpected companion allowed usernames: got %v want %v", cfg.CompanionAllowedUsernames, want)
	}
}

func TestLoadConfigReadsCompanionAllowedUsernamesFromYAML(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	content := []byte(`
companion_allowed_usernames:
  - alice
  - bob
`)
	if err := os.WriteFile(configPath, content, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}

	cfg, err := loadConfigFromFile(configPath)
	if err != nil {
		t.Fatalf("expected config load to succeed, got: %v", err)
	}
	want := []string{"alice", "bob"}
	if !reflect.DeepEqual(cfg.CompanionAllowedUsernames, want) {
		t.Fatalf("unexpected companion allowed usernames: got %v want %v", cfg.CompanionAllowedUsernames, want)
	}
}

func TestLoadConfigReadsCompanionImageEffectMapFileFromEnv(t *testing.T) {
	t.Setenv("APP_CONFIG_FILE", "")
	t.Setenv("CONFIG_FILE", "")
	t.Setenv("COMPANION_IMAGE_EFFECT_MAP_FILE", "./custom-effect-map.json")

	cfg := loadConfigFromEnv()
	if cfg.CompanionImageEffectMapFile != "./custom-effect-map.json" {
		t.Fatalf("unexpected companion image effect map file: %q", cfg.CompanionImageEffectMapFile)
	}
}

func TestLoadConfigReadsCompanionImageEffectMapFileFromYAML(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	content := []byte(`
companion_image_effect_map_file: "./maps/image-effect-map.json"
`)
	if err := os.WriteFile(configPath, content, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}

	cfg, err := loadConfigFromFile(configPath)
	if err != nil {
		t.Fatalf("expected config load to succeed, got: %v", err)
	}
	if cfg.CompanionImageEffectMapFile != "./maps/image-effect-map.json" {
		t.Fatalf("unexpected companion image effect map file: %q", cfg.CompanionImageEffectMapFile)
	}
}

func TestLoadConfigReadsCompanionDynamicPagingFromEnv(t *testing.T) {
	t.Setenv("APP_CONFIG_FILE", "")
	t.Setenv("CONFIG_FILE", "")
	t.Setenv("COMPANION_DYNAMIC_PAGING", "true")

	cfg := loadConfigFromEnv()
	if !cfg.CompanionDynamicPaging {
		t.Fatal("expected companion dynamic paging to be enabled from env")
	}
}

func TestLoadConfigReadsCompanionDynamicPagingFromYAML(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	content := []byte(`
companion_dynamic_paging: true
`)
	if err := os.WriteFile(configPath, content, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}

	cfg, err := loadConfigFromFile(configPath)
	if err != nil {
		t.Fatalf("expected config load to succeed, got: %v", err)
	}
	if !cfg.CompanionDynamicPaging {
		t.Fatal("expected companion dynamic paging to be enabled from yaml")
	}
}
