package app

import (
	"crypto/x509"
	"net"
	"slices"
	"testing"
)

func TestInternalTLSHostsDefaultsToLocalhost(t *testing.T) {
	hosts := internalTLSHosts(":8443")
	if len(hosts) != 1 || hosts[0] != "localhost" {
		t.Fatalf("expected only localhost for wildcard listen addr, got %v", hosts)
	}
}

func TestInternalTLSHostsIncludesExplicitListenHost(t *testing.T) {
	hosts := internalTLSHosts("192.168.1.50:8443")
	if !slices.Contains(hosts, "localhost") {
		t.Fatalf("expected localhost in SAN hosts, got %v", hosts)
	}
	if !slices.Contains(hosts, "192.168.1.50") {
		t.Fatalf("expected listen host in SAN hosts, got %v", hosts)
	}
}

func TestGenerateInternalSelfSignedCertIncludesSANs(t *testing.T) {
	pair, err := generateInternalSelfSignedCert("127.0.0.1:8443")
	if err != nil {
		t.Fatalf("generateInternalSelfSignedCert returned error: %v", err)
	}
	if len(pair.Certificate) == 0 {
		t.Fatal("expected generated key pair to include certificate bytes")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatalf("failed to parse generated certificate: %v", err)
	}
	if !slices.Contains(leaf.DNSNames, "localhost") {
		t.Fatalf("expected localhost DNS SAN, got %v", leaf.DNSNames)
	}
	if !containsIP(leaf.IPAddresses, net.ParseIP("127.0.0.1")) {
		t.Fatalf("expected 127.0.0.1 IP SAN, got %v", leaf.IPAddresses)
	}
}

func containsIP(ips []net.IP, target net.IP) bool {
	for _, ip := range ips {
		if ip.Equal(target) {
			return true
		}
	}
	return false
}
