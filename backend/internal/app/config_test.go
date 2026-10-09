package app

import (
	"fmt"
	"io"
	"log/slog"
	"net"
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

func TestLoadConfigReadsWebRTCExposureFromEnv(t *testing.T) {
	t.Setenv("WEBRTC_UDP_PORT", "8443")
	t.Setenv("WEBRTC_PUBLIC_IPS", " 192.168.1.50 , 127.0.0.1")

	cfg := loadConfigFromEnv()
	if cfg.WebRTCUDPPort != 8443 {
		t.Fatalf("expected webrtc udp port 8443, got %d", cfg.WebRTCUDPPort)
	}
	if want := []string{"192.168.1.50", "127.0.0.1"}; !reflect.DeepEqual(cfg.WebRTCPublicIPs, want) {
		t.Fatalf("expected public ips %v, got %v", want, cfg.WebRTCPublicIPs)
	}
}

func TestLoadConfigReadsWebRTCExposureFromYAML(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	content := []byte(`
webrtc_udp_port: 8443
webrtc_public_ips: ["10.0.0.5"]
`)
	if err := os.WriteFile(configPath, content, 0o644); err != nil {
		t.Fatalf("failed to write temp config: %v", err)
	}

	cfg, err := loadConfigFromFile(configPath)
	if err != nil {
		t.Fatalf("expected config load to succeed, got: %v", err)
	}
	if cfg.WebRTCUDPPort != 8443 || !reflect.DeepEqual(cfg.WebRTCPublicIPs, []string{"10.0.0.5"}) {
		t.Fatalf("unexpected webrtc exposure config: port=%d ips=%v", cfg.WebRTCUDPPort, cfg.WebRTCPublicIPs)
	}
}

func TestBuildWebRTCAPIBindsSingleUDPPort(t *testing.T) {
	probe, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free udp port: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	_ = probe.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := buildWebRTCAPI(logger, WebRTCOptions{UDPPort: port, PublicIPs: []string{"127.0.0.1"}}); err != nil {
		t.Fatalf("expected api to build, got: %v", err)
	}
	if conn, err := net.ListenPacket("udp", fmt.Sprintf(":%d", port)); err == nil {
		_ = conn.Close()
		t.Fatalf("expected webrtc mux to hold udp port %d", port)
	}
}
