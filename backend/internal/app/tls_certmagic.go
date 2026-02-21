package app

import (
	"fmt"
	"os"
	"strings"

	"github.com/caddyserver/certmagic"
	libdnscloudflare "github.com/libdns/cloudflare"
	libdnshetzner "github.com/libdns/hetzner"
	libdnsroute53 "github.com/libdns/route53"
)

func newCertMagicConfig(cfg Config) (*certmagic.Config, error) {
	if strings.ToLower(cfg.CertMagicChallenge) != "dns-01" {
		return nil, fmt.Errorf("unsupported CERTMAGIC_CHALLENGE %q: only dns-01 is supported", cfg.CertMagicChallenge)
	}
	if len(cfg.CertMagicDomains) == 0 {
		return nil, fmt.Errorf("CERTMAGIC_DOMAINS is required when TLS_MODE=certmagic")
	}
	if cfg.CertMagicDNSProvider == "" {
		return nil, fmt.Errorf("CERTMAGIC_DNS_PROVIDER is required when TLS_MODE=certmagic")
	}

	dnsProvider, err := certMagicDNSProviderFromEnv(cfg.CertMagicDNSProvider)
	if err != nil {
		return nil, err
	}
	magic := certmagic.NewDefault()
	magic.Storage = &certmagic.FileStorage{Path: cfg.CertMagicStoragePath}
	solver := &certmagic.DNS01Solver{
		DNSManager: certmagic.DNSManager{
			DNSProvider:        dnsProvider,
			PropagationDelay:   cfg.CertMagicPropagationDelay,
			PropagationTimeout: cfg.CertMagicPropagationTimeout,
			Resolvers:          cfg.CertMagicResolvers,
		},
	}
	issuer := certmagic.NewACMEIssuer(magic, certmagic.ACMEIssuer{
		CA:                      cfg.CertMagicCA,
		Email:                   cfg.CertMagicEmail,
		Agreed:                  true,
		DisableHTTPChallenge:    true,
		DisableTLSALPNChallenge: true,
		DNS01Solver:             solver,
	})
	magic.Issuers = []certmagic.Issuer{issuer}
	return magic, nil
}

func certMagicDNSProviderFromEnv(providerName string) (certmagic.DNSProvider, error) {
	switch strings.ToLower(strings.TrimSpace(providerName)) {
	case "cloudflare":
		apiToken := getAnyEnv("CERTMAGIC_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN")
		if apiToken == "" {
			return nil, fmt.Errorf("cloudflare DNS provider requires CERTMAGIC_CLOUDFLARE_API_TOKEN")
		}
		return &libdnscloudflare.Provider{
			APIToken:  apiToken,
			ZoneToken: getAnyEnv("CERTMAGIC_CLOUDFLARE_ZONE_TOKEN", "CLOUDFLARE_ZONE_TOKEN"),
		}, nil
	case "hetzner":
		token := getAnyEnv("CERTMAGIC_HETZNER_API_TOKEN", "HETZNER_API_TOKEN")
		if token == "" {
			return nil, fmt.Errorf("hetzner DNS provider requires CERTMAGIC_HETZNER_API_TOKEN")
		}
		return &libdnshetzner.Provider{
			AuthAPIToken: token,
		}, nil
	case "route53":
		return &libdnsroute53.Provider{
			Region:          getEnv("CERTMAGIC_ROUTE53_REGION", ""),
			Profile:         getEnv("CERTMAGIC_ROUTE53_PROFILE", ""),
			AccessKeyId:     getEnv("CERTMAGIC_ROUTE53_ACCESS_KEY_ID", ""),
			SecretAccessKey: getEnv("CERTMAGIC_ROUTE53_SECRET_ACCESS_KEY", ""),
			SessionToken:    getEnv("CERTMAGIC_ROUTE53_SESSION_TOKEN", ""),
			HostedZoneID:    getEnv("CERTMAGIC_ROUTE53_HOSTED_ZONE_ID", ""),
		}, nil
	default:
		return nil, fmt.Errorf(
			"unsupported CERTMAGIC_DNS_PROVIDER %q (supported: cloudflare, hetzner, route53)",
			providerName,
		)
	}
}

func getAnyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}
