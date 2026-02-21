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
