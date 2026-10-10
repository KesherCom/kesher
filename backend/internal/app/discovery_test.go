package app

import (
	"strings"
	"testing"
)

// The fingerprint decides when the mDNS announcement is renewed: it must be
// stable while nothing changes and never contain loopback or link-local
// addresses (those are not reachable from other machines).
func TestLANAddrFingerprintIsStableAndReachableOnly(t *testing.T) {
	first, second := lanAddrFingerprint(), lanAddrFingerprint()
	if first != second {
		t.Fatalf("fingerprint changed without a network change: %q vs %q", first, second)
	}
	for _, addr := range strings.Split(first, ",") {
		if strings.HasPrefix(addr, "127.") || strings.HasPrefix(addr, "169.254.") {
			t.Fatalf("unreachable address in fingerprint: %q", first)
		}
	}
}
