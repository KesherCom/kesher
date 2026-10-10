package app

// LAN discovery: the server announces itself via mDNS/DNS-SD as
// "_kesher._tcp", so Raspberry Pi stations and the desktop app find it
// without typing an address. TXT records: scheme=http|https, version=...
//
// Works when the server shares the clients' network: natively or in Docker
// with network_mode: host (deploy/server). Behind Docker's bridge network
// the multicast does not reach the LAN; clients then need the address.
// MDNS_ENABLED=false turns it off, MDNS_NAME sets the shown name.
//
// The announcement carries the addresses the machine had when it was made.
// A laptop that changes networks (other Wi-Fi, cable plugged in) would keep
// announcing the old address, so the addresses are checked every few
// seconds and the announcement is renewed when they change.

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/zeroconf/v2"
)

const (
	discoveryService        = "_kesher._tcp"
	discoveryAddrCheckEvery = 5 * time.Second
)

type discovery struct {
	name, service string
	port          int
	txt           []string
	logger        *slog.Logger

	mu     sync.Mutex
	server *zeroconf.Server
	closed bool
	stop   chan struct{}
	once   sync.Once
}

// startDiscovery announces the web/API listener. Errors are logged, never
// fatal: discovery is a convenience.
func startDiscovery(cfg Config, logger *slog.Logger) *discovery {
	if !cfg.MDNSEnabled {
		return nil
	}
	addr, scheme := cfg.Addr, "http"
	if cfg.ProductionMode {
		addr, scheme = cfg.ProductionHTTPSAddr, "https"
	} else if !cfg.TrustedLANHTTP {
		scheme = "https"
	}
	_, portText, err := net.SplitHostPort(addr)
	if err != nil {
		logger.Warn("mdns: cannot read port from listen address", "addr", addr, "error", err)
		return nil
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 {
		logger.Warn("mdns: invalid port", "addr", addr)
		return nil
	}
	name := strings.TrimSpace(cfg.MDNSName)
	if name == "" {
		host, _ := os.Hostname()
		name = fmt.Sprintf("Kesher (%s)", host)
	}
	txt := []string{"scheme=" + scheme, "version=" + Version, "path=/"}
	if lan := lanHTTPAddrFor(cfg); lan != "" {
		if _, p, err := net.SplitHostPort(lan); err == nil {
			// Native clients that cannot use the self-signed HTTPS
			// certificate (desktop app) connect here instead.
			txt = append(txt, "http_port="+p)
		}
	}
	d := &discovery{name: name, service: discoveryService, port: port, txt: txt, logger: logger, stop: make(chan struct{})}
	addrs := lanAddrFingerprint()
	if !d.register() {
		return nil
	}
	logger.Info("mdns: announcing server on the LAN", "name", name, "service", discoveryService, "port", port, "scheme", scheme, "addresses", addrs)
	go d.followAddressChanges(addrs)
	return d
}

func (d *discovery) register() bool {
	server, err := zeroconf.Register(d.name, d.service, "local.", d.port, d.txt, nil)
	if err != nil {
		d.logger.Warn("mdns: announcement failed", "error", err)
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		server.Shutdown()
		return false
	}
	d.server = server
	return true
}

// followAddressChanges renews the announcement when the machine's addresses
// change, so clients are never sent to an address it no longer has.
func (d *discovery) followAddressChanges(current string) {
	ticker := time.NewTicker(discoveryAddrCheckEvery)
	defer ticker.Stop()
	for {
		select {
		case <-d.stop:
			return
		case <-ticker.C:
			next := lanAddrFingerprint()
			if next == current {
				continue
			}
			current = next
			d.mu.Lock()
			if d.server != nil {
				d.server.Shutdown()
				d.server = nil
			}
			d.mu.Unlock()
			if d.register() {
				d.logger.Info("mdns: addresses changed, announcement renewed", "addresses", next)
			}
		}
	}
}

// lanAddrFingerprint lists the IPv4 addresses of the interfaces that are up
// and can multicast (what the announcement carries), sorted.
func lanAddrFingerprint() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var addrs []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagMulticast == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		list, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range list {
			if ipNet, ok := a.(*net.IPNet); ok && ipNet.IP.To4() != nil && !ipNet.IP.IsLinkLocalUnicast() {
				addrs = append(addrs, ipNet.IP.String())
			}
		}
	}
	slices.Sort(addrs)
	return strings.Join(addrs, ",")
}

// lanHTTPAddrFor: the extra plain-HTTP listener, only when the main one is
// HTTPS (with TRUSTED_LAN_HTTP the main listener is plain HTTP already).
func lanHTTPAddrFor(cfg Config) string {
	addr := strings.TrimSpace(cfg.LANHTTPAddr)
	if addr == "" || cfg.ProductionMode || cfg.TrustedLANHTTP {
		return ""
	}
	return addr
}

func (s *Server) lanHTTPAddr() string { return lanHTTPAddrFor(s.cfg) }

func (d *discovery) Close() {
	if d == nil {
		return
	}
	d.once.Do(func() { close(d.stop) })
	d.mu.Lock()
	defer d.mu.Unlock()
	d.closed = true
	if d.server != nil {
		d.server.Shutdown()
		d.server = nil
	}
}
