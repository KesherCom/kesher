# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Build & Development Commands

```sh
make deps            # install Go + npm dependencies
make dev-backend     # run Go backend on :8080
make dev-web         # run Vite dev server on :5173 (proxies /api and /ws to :8080)
make run-backend     # build frontend, then serve everything from backend
make build           # build both backend binary and frontend bundle
make test            # go test ./... + frontend TypeScript build check
make docker-up       # build Docker image and start via Compose on :8080
make docker-down     # stop Docker Compose
make clean           # remove backend/bin and web/dist
```

Run a single Go test:
```sh
cd backend && go test -run TestHubDirectRouting ./internal/app/
```

The frontend has no test runner — `make test` validates it via `tsc -b && vite build`.

## Architecture

This is a web-based intercom for church live productions, designed for 30–50 concurrent users on a trusted LAN. It has two main parts: a Go backend and a React/TypeScript frontend.

### Backend (`backend/`)

Single Go binary. Entrypoint is `cmd/server/main.go`, which loads config and starts the server.

All application logic lives in `backend/internal/app/` as a single package (`package app`):

- **server.go** — HTTP server setup, route registration, REST handlers, WebSocket handler, auth middleware (`withAuth`), CORS middleware. Routes are registered on `http.NewServeMux` (no router library). WebSocket messages are handled in a switch on `in.Type` inside `handleWS`.
- **hub.go** — In-memory WebSocket client registry. Manages presence broadcasting, event routing (direct/room/broadcast scopes), and client state (active room, voice mode, mic state, broadcast group membership). All clients are keyed by session token in a `sync.RWMutex`-protected map.
- **media.go** — WebRTC SFU using Pion (`pion/webrtc/v4`). Manages peer connections, audio track forwarding between peers in the same room, and broadcast group audio routing. Renegotiation is server-initiated (server creates offers, client sends answers). Tracks are forwarded as `TrackLocalStaticRTP`.
- **store.go** — SQLite persistence via `modernc.org/sqlite` (pure Go, no CGO). Schema migrations run on startup in `migrate()`, seed data in `seed()`. Manages CRUD for roles, rooms, broadcast groups, and users.
- **auth.go** — In-memory session manager with configurable TTL. Sessions are UUID-based bearer tokens.
- **config.go** — Reads config from environment variables (see README for the full list).
- **models.go** — All shared types: domain models, API request/response types, WebSocket message types.

Key design patterns:
- Admin endpoints require `session.RoleID == "producer"`.
- Hub and MediaManager have a circular reference (hub routes events, media routes audio; both need each other). Hub is created first, then MediaManager, then `hub.SetMediaManager(media)`.
- MediaManager directly accesses `hub.mu` and `hub.clients` for sending WebSocket messages to peers (see `sendWS`).
- Store errors use sentinel errors (`ErrInvalidInput`, `ErrConflict`, `ErrNotFound`) mapped to HTTP status codes in `writeStoreErr`.

### Frontend (`web/`)

React 18 + TypeScript + Vite. Single-page app in one `App.tsx` component (no routing library, no state management library).

- **api.ts** — Thin fetch wrappers for all REST endpoints. Auth is via `Authorization: Bearer <token>` header.
- **types.ts** — TypeScript types matching the backend JSON models.
- **App.tsx** — All UI and WebRTC client logic. Manages WebSocket connection with exponential backoff reconnect, WebRTC peer connection lifecycle, mic device selection, input level metering, and admin CRUD forms.

The Vite dev server proxies `/api` and `/ws` to `localhost:8080` (configured in `vite.config.ts`).

### Real-time Communication Flow

1. Client authenticates via `POST /api/login`, receives a session token.
2. Client opens WebSocket at `/ws?token=<token>`.
3. Server creates a Pion PeerConnection for the client, adds a recvonly audio transceiver.
4. Client captures mic, adds audio track to its own RTCPeerConnection, sends `webrtc_ready`.
5. Server triggers SDP renegotiation (offer→answer) whenever room membership or broadcast state changes.
6. Audio tracks are forwarded per-room; broadcast groups temporarily route a source's audio to all member rooms.
7. Presence updates are broadcast to all connected clients on every state change.

### WebSocket Message Types (inbound from client)

`webrtc_ready`, `set_active_room`, `chat`, `signal`, `voice_state`, `webrtc_answer`, `webrtc_ice_candidate`

### WebSocket Message Types (outbound to client)

`presence`, `chat`, `signal`, `voice_state`, `webrtc_offer`, `webrtc_ice_candidate`

## Go Module Path

The Go module is `github.com/staubichsauger/live-production-intercom/backend`.

## Testing

Backend tests use Go's standard `testing` package — no external test frameworks. Tests use `:memory:` SQLite databases. There are currently tests for `auth.go` and `hub.go`.

## Docker

Multi-stage Dockerfile at `backend/Dockerfile` builds both frontend (Node 22) and backend (Go 1.23), producing an Alpine-based image. Docker Compose config is at `deploy/compose/docker-compose.yml`. Data is persisted via a named volume (`intercom_data`) for the SQLite database.
