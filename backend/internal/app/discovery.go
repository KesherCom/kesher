package app

// LAN discovery: the server announces itself via mDNS/DNS-SD as
// "_kesher._tcp", so Raspberry Pi stations and the desktop app find it
// without typing an address. TXT records: scheme=http|https, version=...
//
// Works when the server shares the clients' network: natively or in Docker
// with network_mode: host (deploy/server). Behind Docker's bridge network
// the multicast does not reach the LAN; clients then need the address.
// MDNS_ENABLED=false turns it off, MDNS_NAME sets the shown name.

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/libp2p/zeroconf/v2"
)

const discoveryService = "_kesher._tcp"

type discovery struct {
	server *zeroconf.Server
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
	server, err := zeroconf.Register(name, discoveryService, "local.", port, txt, nil)
	if err != nil {
		logger.Warn("mdns: announcement failed", "error", err)
		return nil
	}
	logger.Info("mdns: announcing server on the LAN", "name", name, "service", discoveryService, "port", port, "scheme", scheme)
	return &discovery{server: server}
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
	if d != nil && d.server != nil {
		d.server.Shutdown()
	}
}
