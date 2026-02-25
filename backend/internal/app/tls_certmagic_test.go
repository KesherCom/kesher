package app

import "testing"

func TestNewCertMagicConfigRejectsNonDNSChallenge(t *testing.T) {
	cfg := Config{
		TLSMode:              "certmagic",
		CertMagicDomains:     []string{"intercom.example.org"},
		CertMagicChallenge:   "http-01",
		CertMagicDNSProvider: "cloudflare",
	}
	if _, err := newCertMagicConfig(cfg); err == nil {
		t.Fatalf("expected error for non-dns-01 challenge")
	}
}

func TestNewCertMagicConfigCloudflare(t *testing.T) {
	t.Setenv("CERTMAGIC_CLOUDFLARE_API_TOKEN", "token")

	cfg := Config{
		TLSMode:              "certmagic",
		CertMagicDomains:     []string{"intercom.example.org"},
		CertMagicChallenge:   "dns-01",
		CertMagicDNSProvider: "cloudflare",
		CertMagicStoragePath: t.TempDir(),
	}
	magic, err := newCertMagicConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if magic == nil {
		t.Fatalf("expected certmagic config")
	}
}

func TestNewCertMagicConfigRequiresDomains(t *testing.T) {
	cfg := Config{
		TLSMode:              "certmagic",
		CertMagicChallenge:   "dns-01",
		CertMagicDNSProvider: "cloudflare",
	}
	if _, err := newCertMagicConfig(cfg); err == nil {
		t.Fatal("expected error when certmagic domains are missing")
	}
}

func TestCertMagicDNSProviderFromEnvUnsupportedProvider(t *testing.T) {
	if _, err := certMagicDNSProviderFromEnv("unknown"); err == nil {
		t.Fatal("expected error for unsupported DNS provider")
	}
}

func TestCertMagicDNSProviderFromEnvCloudflareRequiresToken(t *testing.T) {
	t.Setenv("CERTMAGIC_CLOUDFLARE_API_TOKEN", "")
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	if _, err := certMagicDNSProviderFromEnv("cloudflare"); err == nil {
		t.Fatal("expected cloudflare token validation error")
	}
}

func TestCertMagicDNSProviderFromEnvHetznerRequiresToken(t *testing.T) {
	t.Setenv("CERTMAGIC_HETZNER_API_TOKEN", "")
	t.Setenv("HETZNER_API_TOKEN", "")
	if _, err := certMagicDNSProviderFromEnv("hetzner"); err == nil {
		t.Fatal("expected hetzner token validation error")
	}
}
