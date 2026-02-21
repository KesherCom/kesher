package trust

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Options struct {
	CAFile string
	Pins   []string
}

func NewTransport(upstream *url.URL, opts Options) (*http.Transport, *tls.Config, error) {
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}
	if upstream.Scheme == "https" && opts.CAFile != "" {
		pool, err := loadCertPool(opts.CAFile)
		if err != nil {
			return nil, nil, err
		}
		tlsCfg.RootCAs = pool
	}
	if upstream.Scheme == "https" && len(opts.Pins) > 0 {
		verifier, err := newPinVerifier(opts.Pins)
		if err != nil {
			return nil, nil, err
		}
		tlsCfg.VerifyConnection = verifier.VerifyConnection
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSClientConfig:       tlsCfg,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	return transport, tlsCfg, nil
}

type pinVerifier struct {
	spkiPins [][]byte
	certPins [][]byte
}

func newPinVerifier(pins []string) (*pinVerifier, error) {
	out := &pinVerifier{}
	for _, raw := range pins {
		pin := strings.TrimSpace(raw)
		if pin == "" {
			continue
		}
		switch {
		case strings.HasPrefix(pin, "spki-sha256:"):
			value := strings.TrimPrefix(pin, "spki-sha256:")
			decoded, err := base64.StdEncoding.DecodeString(value)
			if err != nil {
				return nil, fmt.Errorf("invalid spki pin %q: %w", pin, err)
			}
			if len(decoded) != sha256.Size {
				return nil, fmt.Errorf("invalid spki pin %q: expected 32-byte sha256 digest", pin)
			}
			out.spkiPins = append(out.spkiPins, decoded)
		case strings.HasPrefix(pin, "cert-sha256:"):
			value := strings.TrimPrefix(pin, "cert-sha256:")
			decoded, err := decodeHexDigest(value)
			if err != nil {
				return nil, fmt.Errorf("invalid cert pin %q: %w", pin, err)
			}
			if len(decoded) != sha256.Size {
				return nil, fmt.Errorf("invalid cert pin %q: expected 32-byte sha256 digest", pin)
			}
			out.certPins = append(out.certPins, decoded)
		default:
			return nil, fmt.Errorf("unsupported pin format %q (use spki-sha256:<base64> or cert-sha256:<hex>)", pin)
		}
	}
	if len(out.spkiPins) == 0 && len(out.certPins) == 0 {
		return nil, fmt.Errorf("pin list is empty")
	}
	return out, nil
}

func (p *pinVerifier) VerifyConnection(state tls.ConnectionState) error {
	if len(state.PeerCertificates) == 0 {
		return fmt.Errorf("upstream did not provide peer certificates")
	}
	leaf := state.PeerCertificates[0]

	if len(p.spkiPins) > 0 {
		sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
		matched := false
		for _, pin := range p.spkiPins {
			if equalDigest(sum[:], pin) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("upstream spki pin mismatch")
		}
	}

	if len(p.certPins) > 0 {
		sum := sha256.Sum256(leaf.Raw)
		for _, pin := range p.certPins {
			if equalDigest(sum[:], pin) {
				return nil
			}
		}
		return fmt.Errorf("upstream cert pin mismatch")
	}
	return nil
}

func equalDigest(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var out byte
	for i := range a {
		out |= a[i] ^ b[i]
	}
	return out == 0
}

func loadCertPool(caFile string) (*x509.CertPool, error) {
	data, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read ca file: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(data) {
		return nil, fmt.Errorf("ca file %q does not contain valid PEM certificates", caFile)
	}
	return pool, nil
}

func decodeHexDigest(v string) ([]byte, error) {
	normalized := strings.ReplaceAll(v, ":", "")
	decoded, err := hex.DecodeString(normalized)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

func EffectivePort(upstream *url.URL) string {
	if p := upstream.Port(); p != "" {
		return p
	}
	switch upstream.Scheme {
	case "https":
		return "443"
	default:
		return "80"
	}
}

func BuildURLWithPath(upstream *url.URL, path string) string {
	target := *upstream
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	target.Path = path
	target.RawPath = ""
	target.RawQuery = ""
	return target.String()
}
