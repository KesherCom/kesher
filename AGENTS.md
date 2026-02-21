# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Build & Development Commands

```sh
make deps            # install Go + npm dependencies
make dev-backend     # run Go backend on :8080
make dev-web         # run Vite dev server on :5173 (proxies /api and /ws to :8080)
make run-web         # alias for dev-web
make run-backend     # build frontend, then serve everything from backend
make run-backend-https LAN_IP=192.168.1.50
                    # build frontend, auto-generate self-signed certs if missing, run backend over HTTPS
make run-backend-le DOMAIN=intercom.example.org
                    # build frontend, copy Let's Encrypt certs from /etc/letsencrypt/live/<domain>/, run backend over HTTPS
make run-production-le DOMAIN=intercom.example.org
                    # production mode: HTTPS app server (:443) + HTTP redirect (:80)
make build           # build both backend binary and frontend bundle
make test            # go test ./... + frontend build check
make docker-build    # build Docker image via compose
make docker-up       # build Docker image and start via Compose on :8080
make docker-down     # stop Docker Compose
make clean           # remove backend/bin and web/dist
```

Run a single Go test:
```sh
cd backend && go test -run TestHubDirectRouting ./internal/app/
```

The frontend has no dedicated test runner — `make test` validates it via `npm run build` (TypeScript + Vite build).

## Architecture

This is a web-based intercom for church live productions, designed for 30–50 concurrent users on a trusted LAN. It has two main parts: a Go backend and a React/TypeScript frontend.

### Backend (`backend/`)

Single Go binary. Entrypoint is `cmd/server/main.go`, which loads config and starts the server.

All application logic lives in `backend/internal/app/` as a single package (`package app`):

- **server.go** — HTTP server setup, route registration, REST handlers, WebSocket handler, auth middleware (`withAuth`), CORS middleware, static SPA fallback handler, optional HTTPS, and production HTTP→HTTPS redirect server. Routes are registered on `http.NewServeMux`.
- **hub.go** — In-memory WebSocket client registry keyed by session token, with presence broadcasting, routed event delivery (direct/room/broadcast), active room + listen/talk room matrix state, voice mode state, and broadcast-active indicators.
- **media.go** — WebRTC SFU using Pion (`pion/webrtc/v4`). Manages peer connections, inbound remote tracks, outbound forwarding via `TrackLocalStaticRTP`, renegotiation (server-created offers), ICE flow, direct PTT targeting, and broadcast-group audio routing.
- **store.go** — SQLite persistence via `modernc.org/sqlite` (pure Go, no CGO). Schema migrations run on startup in `migrate()`, seed data in `seed()`. Manages CRUD for roles, rooms, broadcast groups, and users.
- **auth.go** — In-memory session manager with configurable TTL. Sessions are UUID-based bearer tokens.
- **config.go** — Reads config from environment variables (see README for the full list).
- **models.go** — All shared types: domain models, API request/response types, WebSocket message types.

Key design patterns:
- Hub and MediaManager have a circular reference (hub routes events, media routes audio; both need each other). Hub is created first, then MediaManager, then `hub.SetMediaManager(media)`.
- MediaManager directly accesses `hub.mu` and `hub.clients` for sending WebSocket messages to peers (see `sendWS`).
- Store errors use sentinel errors (`ErrInvalidInput`, `ErrConflict`, `ErrNotFound`) mapped to HTTP status codes in `writeStoreErr`.
- Role-based room policy enforcement is applied in both event routing and media routing (`RoomRolePolicies`, `isRoleAllowed`).
- Current implementation note: `requireAdmin` currently returns `true` unconditionally, so admin REST endpoints are not effectively role-gated right now.

### Frontend (`web/`)

React 18 + TypeScript + Vite. Single-page app split across multiple components (no routing library, no external state-management library).

- **api.ts** — Thin fetch wrappers for REST endpoints. Auth is via `Authorization: Bearer <token>` header.
- **types.ts** — TypeScript types matching backend JSON models.
- **App.tsx** — Core app orchestration: login/bootstrap flow, WebSocket lifecycle with exponential backoff reconnect, WebRTC peer lifecycle, device selection, audio metering, and routing/voice state sync.
- **components/** — UI split into `LoginView`, `StationIntercomView`, `SimpleIntercomView`, panel components, and admin components.

The Vite dev server proxies `/api` and `/ws` to `localhost:8080` (configured in `vite.config.ts`).

### Real-time Communication Flow

1. Client authenticates via `POST /api/login`, receives a session token.
2. Client opens WebSocket at `/ws?token=<token>`.
3. Server creates a Pion PeerConnection for the client, adds a recvonly audio transceiver.
4. Client captures mic, adds local audio track to its RTCPeerConnection, sends `webrtc_ready`.
5. Client sends room matrix (`listenRoomIds`, `talkRoomIds`, `activeRoomId`) via `set_room_matrix`.
6. Server enforces role policies for routing and renegotiates media as needed (offer→answer).
7. Audio is forwarded by room overlap by default; direct PTT and broadcast-group PTT can override routing.
8. Presence updates are broadcast to all connected clients on every state change.

### WebSocket Message Types (inbound from client)

`webrtc_ready`, `set_active_room`, `set_room_matrix`, `chat`, `signal`, `voice_state`, `webrtc_answer`, `webrtc_ice_candidate`

### WebSocket Message Types (outbound to client)

`presence`, `chat`, `signal`, `voice_state`, `webrtc_offer`, `webrtc_ice_candidate`

## Go Module Path

The Go module is `github.com/staubichsauger/live-production-intercom/backend`.

## Testing

Backend tests use Go's standard `testing` package (no external test framework). Current test files are `backend/internal/app/auth_test.go` and `backend/internal/app/hub_test.go`. Frontend validation is via build (`npm run build`).

## Docker

Multi-stage Dockerfile at `backend/Dockerfile` builds frontend (Node 22) and backend (Go 1.23), producing an Alpine runtime image. Docker Compose config is at `deploy/compose/docker-compose.yml`. Data persists via named volume `intercom_data` for SQLite.
