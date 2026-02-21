# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Build, run, and test commands

Primary workflow is via `Makefile`:

```sh
make deps
make dev-backend
make dev-web
make run-backend
make run-backend-https LAN_IP=192.168.1.50
make run-backend-le DOMAIN=intercom.example.org
make run-backend-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare
make run-production-le DOMAIN=intercom.example.org
make run-production-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare
make build
make test
make docker-build
make docker-up
make docker-down
make clean
```

Useful direct commands:

```sh
make help
cd backend && go test ./...
cd backend && go test -run TestHubDirectRouting ./internal/app/
cd web && npm run build
```

There is no dedicated frontend test runner and no lint target in `Makefile`; validation is backend tests plus frontend TypeScript/Vite build.

Companion module (Bitfocus) has its own npm project:

```sh
cd companion/module-live-production-intercom && npm install
cd companion/module-live-production-intercom && npm run build
cd companion/module-live-production-intercom && npm run package
```

## High-level architecture

This repository has three parts:
- `backend/`: Go API + WebSocket event hub + embedded WebRTC SFU + SQLite persistence.
- `web/`: React/Vite SPA for operator clients.
- `companion/module-live-production-intercom/`: Bitfocus Companion module that controls active browser sessions through backend companion endpoints.

## Backend architecture (`backend/internal/app`)

- `server.go`: composition root for runtime behavior (HTTP routes, REST handlers, `/ws`, `/api/companion/*`, auth middleware, CORS, static SPA serving, optional HTTPS, production HTTP→HTTPS redirect).
- `hub.go`: in-memory real-time state keyed by session token; presence fanout; routing for `direct` / `room` / `broadcast` events; active room + listen/talk matrices; signal/reply metadata for companion workflows.
- `media.go`: Pion WebRTC SFU logic. Maintains peer connections, receives remote audio tracks, forwards RTP to selected listeners, handles offer/answer + ICE, and recomputes routing when room matrix / direct PTT / broadcast PTT changes.
- `store.go`: SQLite schema migration + seed + CRUD. Role/room/broadcast policy data is persisted and consulted by both event routing and media routing paths.
- `auth.go`: in-memory session manager (UUID bearer tokens, TTL from config).
- `config.go`: environment-driven config (TLS file mode and CertMagic DNS-01 mode, production listener split, session and CORS settings).
- `models.go`: shared API, WS, and domain types.

Important coupling to understand before changing routing logic:
- `Hub` and `MediaManager` are intentionally linked (`hub.SetMediaManager(media)`), and `MediaManager` reads hub client state while holding internal locks for routing decisions.
- Authorization for room/broadcast access is enforced in both event handling (`server.go` + `hub.go`) and media forwarding (`media.go`), so behavior changes usually require updates in both places.
- Store sentinel errors (`ErrInvalidInput`, `ErrConflict`, `ErrNotFound`) are mapped centrally in `writeStoreErr`.
- Current caveat: `requireAdmin` in `server.go` currently returns `true`, so admin endpoints are effectively not role-gated.

## Frontend architecture (`web/src`)

- `App.tsx` is the orchestration layer: login/bootstrap, WS lifecycle with reconnect backoff, RTCPeerConnection lifecycle, device selection, input metering, routing/voice state actions, and companion command handling.
- `api.ts` contains REST mutation/fetch wrappers; auth is bearer token in `Authorization`.
- `types.ts` mirrors backend JSON contracts.
- `components/` contains the station/simple views, admin modal/panels, and focused UI pieces.
- Vite dev server proxies `/api` and `/ws` to backend (`vite.config.ts`).

## Real-time flow (operator client)

1. Login via `POST /api/login`.
2. Open WebSocket `/ws?token=<token>`.
3. Server creates/ensures a WebRTC peer and sends offers.
4. Client sends room matrix + voice state events over WS.
5. Hub routes control events (chat/signal/voice), MediaManager routes audio by:
   - direct target (if active),
   - else active broadcast group rooms (if active),
   - else talk-room → listen-room overlap.
6. Presence updates are broadcast after state changes.

## Companion integration

- Discovery endpoint: `GET /api/companion/discovery?username=<username>`
- Bridge WebSocket: `/api/companion/ws?username=<username>`
- Backend binds companion commands to the latest active token for that username, then relays commands through normal WS control paths.

## Module path and runtime dependencies

- Go module path: `github.com/staubichsauger/live-production-intercom/backend`
- SQLite driver is `modernc.org/sqlite` (pure Go, no CGO runtime dependency).
