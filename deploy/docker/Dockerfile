# syntax=docker/dockerfile:1
#
# kesher server image: Go backend with the web UI embedded in the binary.
#
# Targets (docker build --target <name>):
#   runtime     (default) plain image, TLS handled by the server itself
#               (TRUSTED_LAN_HTTP=true → HTTP, TLS_MODE=file|certmagic → HTTPS)
#   selfsigned  same binary plus an entrypoint that generates a persistent
#               self-signed certificate for LAN IPs/hostnames on first start
#
# Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t kesher .
#
# Multi-arch (linux/amd64 + linux/arm64, as published to ghcr.io): the web
# and Go stages run on the build machine's own platform (Go cross-compiles
# via TARGETARCH); only the small final stages are per-architecture.

# ── 1. Web UI (npm workspace: packages/client-core + web) ──────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS web-build
WORKDIR /src
# Only the workspaces needed for the web bundle; the desktop (Tauri) workspace
# pulls in native tooling we do not want in this image.
COPY package.json ./
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.workspaces=['packages/client-core','web'];fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
COPY packages/client-core/package.json packages/client-core/
COPY web/package.json web/
# npm 10 (bundled with node 22) crashes on these peer deps ("reading
# 'edgesOut'"); npm 11 resolves them.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g npm@11 && npm install --no-audit --no-fund
COPY packages/client-core/ packages/client-core/
COPY web/ web/
RUN npm run build --workspace web

# ── 2. Go backend with embedded UI ─────────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS go-build
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev
ARG BUILD_TIMESTAMP=unknown
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY backend/ .
RUN rm -rf ./internal/app/embedded_web && mkdir -p ./internal/app/embedded_web
COPY --from=web-build /src/web/dist ./internal/app/embedded_web
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags="-s -w -X github.com/KesherCom/kesher/backend/internal/app.Version=$VERSION -X github.com/KesherCom/kesher/backend/internal/app.BuildTimestamp=$BUILD_TIMESTAMP" \
      -o /out/server ./cmd/server

# ── 3a. Self-signed TLS variant ────────────────────────────────────────────
FROM alpine:3.21 AS selfsigned
LABEL org.opencontainers.image.title="kesher"
LABEL org.opencontainers.image.description="On-prem web-based intercom for church live productions (self-signed TLS)"
LABEL org.opencontainers.image.source="https://github.com/KesherCom/kesher"
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=go-build /out/server /app/server
COPY backend/image-effect-map.json /app/image-effect-map.json
COPY deploy/docker/entrypoint-selfsigned.sh /app/entrypoint-selfsigned.sh
# Strip CRLF in case the file was checked out on Windows without .gitattributes.
RUN mkdir -p /app/data /app/certs && sed -i 's/\r$//' /app/entrypoint-selfsigned.sh && chmod +x /app/entrypoint-selfsigned.sh
ENV APP_ADDR=:8443 \
    DB_PATH=/app/data/intercom.db \
    ALLOW_CORS=false \
    TRUSTED_LAN_HTTP=false \
    TLS_MODE=file \
    TLS_CERT_FILE=/app/certs/tls.crt \
    TLS_KEY_FILE=/app/certs/tls.key \
    UDP_AUDIO_ADDR=:8081 \
    WEBRTC_UDP_PORT=8082
EXPOSE 8443/tcp 8081/udp 8082/udp
VOLUME ["/app/data", "/app/certs"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget --no-check-certificate -qO- https://127.0.0.1:8443/api/healthz >/dev/null 2>&1 || exit 1
CMD ["/bin/sh", "/app/entrypoint-selfsigned.sh"]

# ── 3b. Default runtime (last stage = default target) ──────────────────────
FROM alpine:3.21 AS runtime
LABEL org.opencontainers.image.title="kesher"
LABEL org.opencontainers.image.description="On-prem web-based intercom for church live productions"
LABEL org.opencontainers.image.source="https://github.com/KesherCom/kesher"
WORKDIR /app
COPY --from=go-build /out/server /app/server
COPY backend/image-effect-map.json /app/image-effect-map.json
RUN mkdir -p /app/data
ENV APP_ADDR=:8080 \
    DB_PATH=/app/data/intercom.db \
    ALLOW_CORS=false \
    UDP_AUDIO_ADDR=:8081 \
    WEBRTC_UDP_PORT=8082
# 8080/tcp HTTP(S) + WebSocket, 8081/udp native (desktop app) audio relay,
# 8082/udp WebRTC media (browser audio). Publish all three.
EXPOSE 8080/tcp 8081/udp 8082/udp
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz >/dev/null 2>&1 || wget --no-check-certificate -qO- https://127.0.0.1:8080/api/healthz >/dev/null 2>&1 || exit 1
CMD ["/app/server"]
