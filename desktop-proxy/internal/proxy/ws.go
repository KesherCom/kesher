package proxy

import (
	"crypto/tls"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

type WSProxy struct {
	dialer   *websocket.Dialer
	upstream *url.URL
	logger   *slog.Logger
}

func NewWSProxy(upstream *url.URL, tlsConfig *tls.Config, logger *slog.Logger) *WSProxy {
	dialer := websocket.DefaultDialer
	dialer.TLSClientConfig = tlsConfig
	return &WSProxy{
		dialer:   dialer,
		upstream: upstream,
		logger:   logger,
	}
}

func IsWebSocketRequest(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func (p *WSProxy) Proxy(w http.ResponseWriter, r *http.Request) {
	target := *p.upstream
	target.Scheme = wsScheme(p.upstream.Scheme)
	target.Path = r.URL.Path
	target.RawPath = r.URL.RawPath
	target.RawQuery = r.URL.RawQuery

	upstreamHeader := websocketForwardHeaders(r.Header)
	upstreamConn, resp, err := p.dialer.Dial(target.String(), upstreamHeader)
	if err != nil {
		status := http.StatusBadGateway
		if resp != nil && resp.StatusCode != 0 {
			status = resp.StatusCode
		}
		http.Error(w, "websocket upstream unavailable", status)
		p.logger.Warn("websocket dial failed", "target", target.String(), "error", err)
		return
	}
	defer upstreamConn.Close()

	responseHeader := make(http.Header)
	if sub := upstreamConn.Subprotocol(); sub != "" {
		responseHeader.Set("Sec-WebSocket-Protocol", sub)
	}
	downstreamConn, err := (&websocket.Upgrader{
		CheckOrigin: func(_ *http.Request) bool { return true },
	}).Upgrade(w, r, responseHeader)
	if err != nil {
		p.logger.Warn("failed to upgrade local websocket", "error", err)
		return
	}
	defer downstreamConn.Close()

	errCh := make(chan error, 2)
	go relayWS(errCh, upstreamConn, downstreamConn)
	go relayWS(errCh, downstreamConn, upstreamConn)

	if relayErr := <-errCh; relayErr != nil && !websocket.IsCloseError(relayErr, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
		p.logger.Debug("websocket relay ended", "error", relayErr)
	}
}

func relayWS(errCh chan<- error, src *websocket.Conn, dst *websocket.Conn) {
	for {
		msgType, reader, err := src.NextReader()
		if err != nil {
			errCh <- err
			return
		}
		writer, err := dst.NextWriter(msgType)
		if err != nil {
			errCh <- err
			return
		}
		if _, err := io.Copy(writer, reader); err != nil {
			_ = writer.Close()
			errCh <- err
			return
		}
		if err := writer.Close(); err != nil {
			errCh <- err
			return
		}
	}
}

func wsScheme(httpScheme string) string {
	switch httpScheme {
	case "https":
		return "wss"
	default:
		return "ws"
	}
}

func websocketForwardHeaders(src http.Header) http.Header {
	dst := make(http.Header)
	for _, key := range []string{
		"Authorization",
		"Cookie",
		"Origin",
		"User-Agent",
		"Sec-WebSocket-Protocol",
	} {
		for _, value := range src.Values(key) {
			dst.Add(key, value)
		}
	}
	return dst
}
