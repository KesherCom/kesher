package trust

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"net/url"
	"testing"
)

func TestNewPinVerifierRejectsUnknownFormat(t *testing.T) {
	t.Parallel()
	if _, err := newPinVerifier([]string{"sha256:abc"}); err == nil {
		t.Fatal("expected error for unsupported pin format")
	}
}

func TestPinVerifierRejectsEmptyPeerCerts(t *testing.T) {
	t.Parallel()
	spki := []byte("subject-public-key-info")
	raw := []byte("leaf-certificate-raw")
	spkiDigest := sha256.Sum256(spki)
	certDigest := sha256.Sum256(raw)

	v, err := newPinVerifier([]string{
		"spki-sha256:" + base64.StdEncoding.EncodeToString(spkiDigest[:]),
		"cert-sha256:" + hex.EncodeToString(certDigest[:]),
	})
	if err != nil {
		t.Fatalf("newPinVerifier: %v", err)
	}

	err = v.VerifyConnection(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate(nil),
	})
	if err == nil {
		t.Fatal("expected error when peer cert list is empty")
	}
}

func TestPinVerifierMatchesLeafCertificate(t *testing.T) {
	t.Parallel()
	spki := []byte("subject-public-key-info")
	raw := []byte("leaf-certificate-raw")
	spkiDigest := sha256.Sum256(spki)
	certDigest := sha256.Sum256(raw)

	v, err := newPinVerifier([]string{
		"spki-sha256:" + base64.StdEncoding.EncodeToString(spkiDigest[:]),
		"cert-sha256:" + hex.EncodeToString(certDigest[:]),
	})
	if err != nil {
		t.Fatalf("newPinVerifier: %v", err)
	}
	if err := v.VerifyConnection(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{{
			RawSubjectPublicKeyInfo: spki,
			Raw:                     raw,
		}},
	}); err != nil {
		t.Fatalf("expected pin match, got error: %v", err)
	}
}

func TestPinVerifierMismatch(t *testing.T) {
	t.Parallel()
	v, err := newPinVerifier([]string{
		"cert-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	if err != nil {
		t.Fatalf("newPinVerifier: %v", err)
	}
	if err := v.VerifyConnection(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{{
			Raw: []byte("something-else"),
		}},
	}); err == nil {
		t.Fatal("expected mismatch error")
	}
}

func TestEffectivePort(t *testing.T) {
	t.Parallel()
	httpURL, _ := url.Parse("http://example.local")
	if got := EffectivePort(httpURL); got != "80" {
		t.Fatalf("expected 80, got %s", got)
	}
	httpsURL, _ := url.Parse("https://example.local")
	if got := EffectivePort(httpsURL); got != "443" {
		t.Fatalf("expected 443, got %s", got)
	}
	customURL, _ := url.Parse("https://example.local:9443")
	if got := EffectivePort(customURL); got != "9443" {
		t.Fatalf("expected 9443, got %s", got)
	}
}

func TestBuildURLWithPath(t *testing.T) {
	t.Parallel()
	upstream, _ := url.Parse("https://example.local:8443")
	got := BuildURLWithPath(upstream, "api/healthz")
	want := "https://example.local:8443/api/healthz"
	if got != want {
		t.Fatalf("expected %s, got %s", want, got)
	}
}
