package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/staubichsauger/live-production-intercom/desktop-proxy/internal/proxy"
	"github.com/staubichsauger/live-production-intercom/desktop-proxy/internal/trust"
)

const launchTokenCookieName = "lp_launch_token"

func main() {
	var (
		upstreamRaw       string
		listenAddr        string
		openBrowserOnBoot bool
		caFile            string
		pinsRaw           string
		preflightPath     string
		skipPreflight     bool
		logJSON           bool
	)
	flag.StringVar(&upstreamRaw, "upstream", "", "Upstream backend URL (required), e.g. http://192.168.1.50:8080 or https://intercom.example.org")
	flag.StringVar(&listenAddr, "listen", "127.0.0.1:0", "Local listen address (use loopback only)")
	flag.BoolVar(&openBrowserOnBoot, "open-browser", true, "Open system browser on startup")
	flag.StringVar(&caFile, "ca-file", "", "Optional PEM file with CA cert(s) for upstream HTTPS trust")
	flag.StringVar(&pinsRaw, "pins", "", "Optional comma-separated TLS pins: spki-sha256:<base64> and/or cert-sha256:<hex>")
	flag.StringVar(&preflightPath, "preflight-path", "/api/healthz", "Upstream path to probe before serving local traffic")
	flag.BoolVar(&skipPreflight, "skip-preflight", false, "Skip startup preflight probe to upstream")
	flag.BoolVar(&logJSON, "log-json", false, "Emit JSON logs")
	flag.Parse()

	if strings.TrimSpace(upstreamRaw) == "" {
		fmt.Fprintln(os.Stderr, "missing required --upstream")
		os.Exit(2)
	}

	upstreamURL, err := url.Parse(upstreamRaw)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid --upstream URL: %v\n", err)
		os.Exit(2)
	}
	if upstreamURL.Scheme != "http" && upstreamURL.Scheme != "https" {
		fmt.Fprintln(os.Stderr, "--upstream must use http or https")
		os.Exit(2)
	}
	if upstreamURL.Host == "" {
		fmt.Fprintln(os.Stderr, "--upstream must include host")
		os.Exit(2)
	}

	if err := ensureLoopbackListenAddr(listenAddr); err != nil {
		fmt.Fprintf(os.Stderr, "invalid --listen: %v\n", err)
		os.Exit(2)
	}

	logger := newLogger(logJSON)
	pins := splitCSV(pinsRaw)
	if upstreamURL.Port() == "" {
		logger.Warn("upstream URL has no explicit port; using scheme default", "scheme", upstreamURL.Scheme, "effectivePort", trust.EffectivePort(upstreamURL))
	}

	transport, tlsCfg, err := trust.NewTransport(upstreamURL, trust.Options{
		CAFile: caFile,
		Pins:   pins,
	})
	if err != nil {
		logger.Error("failed to configure upstream transport", "error", err)
		os.Exit(1)
	}
	if !skipPreflight {
		if err := runPreflightProbe(upstreamURL, preflightPath, transport); err != nil {
			logger.Error("upstream preflight failed", "error", err, "probeURL", trust.BuildURLWithPath(upstreamURL, preflightPath))
			os.Exit(1)
		}
		logger.Info("upstream preflight successful", "probeURL", trust.BuildURLWithPath(upstreamURL, preflightPath))
	}

	httpProxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	httpProxy.Transport = transport
	httpProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, e error) {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		logger.Warn("http proxy error", "error", e)
	}

	launchToken, err := newLaunchToken()
	if err != nil {
		logger.Error("failed to create launch token", "error", err)
		os.Exit(1)
	}

	wsProxy := proxy.NewWSProxy(upstreamURL, tlsCfg, logger)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !authorizeLocalSession(w, r, launchToken) {
			return
		}
		if proxy.IsWebSocketRequest(r) {
			wsProxy.Proxy(w, r)
			return
		}
		httpProxy.ServeHTTP(w, r)
	})

	server := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		logger.Error("failed to listen", "addr", listenAddr, "error", err)
		os.Exit(1)
	}
	localURL := fmt.Sprintf("http://%s/?launch_token=%s", ln.Addr().String(), url.QueryEscape(launchToken))
	logger.Info("desktop proxy listening", "addr", ln.Addr().String(), "upstream", upstreamURL.String())

	if openBrowserOnBoot {
		if err := openBrowser(localURL); err != nil {
			logger.Warn("failed to open browser automatically", "error", err, "url", localURL)
		}
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Serve(ln)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logger.Info("shutdown signal received", "signal", sig.String())
	case serveErr := <-errCh:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("server terminated unexpectedly", "error", serveErr)
			os.Exit(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Warn("graceful shutdown failed", "error", err)
		_ = server.Close()
	}
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func runPreflightProbe(upstream *url.URL, path string, transport *http.Transport) error {
	client := &http.Client{
		Transport: transport.Clone(),
		Timeout:   5 * time.Second,
	}
	req, err := http.NewRequest(http.MethodGet, trust.BuildURLWithPath(upstream, path), nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("unexpected status: %s", resp.Status)
	}
	return nil
}

func newLogger(asJSON bool) *slog.Logger {
	if asJSON {
		return slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, nil))
}

func ensureLoopbackListenAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("listen host must be an IP loopback address, got %q", host)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("listen host must be loopback, got %q", host)
	}
	return nil
}

func newLaunchToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func authorizeLocalSession(w http.ResponseWriter, r *http.Request, expectedToken string) bool {
	if cookie, err := r.Cookie(launchTokenCookieName); err == nil && cookie.Value == expectedToken {
		return true
	}

	if token := r.URL.Query().Get("launch_token"); token != "" && token == expectedToken {
		http.SetCookie(w, &http.Cookie{
			Name:     launchTokenCookieName,
			Value:    expectedToken,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})
		target := *r.URL
		q := target.Query()
		q.Del("launch_token")
		target.RawQuery = q.Encode()
		http.Redirect(w, r, target.String(), http.StatusFound)
		return false
	}

	http.Error(w, "desktop launcher token missing or invalid", http.StatusForbidden)
	return false
}

func openBrowser(targetURL string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", targetURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL)
	default:
		cmd = exec.Command("xdg-open", targetURL)
	}
	return cmd.Start()
}
