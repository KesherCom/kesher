# Live Production Intercom
On-prem, web-based intercom for church live productions. Built for 30–50 concurrent users on a trusted LAN.

## Current state
- **Auth:** username + role selection login, in-memory sessions with configurable TTL (default 12 h). Admin endpoints gated to the `producer` role.
- **Voice:** WebRTC SFU (Pion) embedded in the Go backend. Always-on and push-to-talk modes.
- **Rooms:** users join a room; audio is routed per-room through the SFU. Room switching re-negotiates media tracks.
- **Broadcast groups:** span multiple rooms. PTT on a broadcast group routes audio to all member rooms.
- **Presence:** real-time presence over WebSocket — voice mode, mic state, active room, broadcast-active indicator.
- **Admin CRUD:** REST endpoints for managing roles, rooms, and broadcast groups (create/update/delete).
- **Persistence:** SQLite for roles, rooms, broadcast groups, and users.
- **Frontend:** React + TypeScript (Vite). Includes mic device picker, input level meter, and WebSocket reconnect with exponential backoff.

## Repository layout
```
backend/           Go API + WebSocket signaling + WebRTC SFU + SQLite
  cmd/server/      entrypoint
  internal/app/    server, hub, media, auth, store, models, config
web/               React + TypeScript frontend (Vite)
deploy/compose/    Docker Compose deployment
docs/              implementation plan
scripts/           soak tests
```

## Prerequisites
- Go 1.23+
- Node.js 22+ / npm
- Docker & Docker Compose (for container deployment)

## Development
Install all dependencies:
```sh
make deps
```

Run backend and frontend separately:
```sh
# Terminal 1 – backend (listens on :8080)
make dev-backend

# Terminal 2 – frontend dev server (listens on :5173, proxies API to backend)
make dev-web
```

Or build the frontend and serve everything from the backend:
```sh
make run-backend   # builds web/, then starts backend with STATIC_DIR=../web/dist
```

## Production (Docker Compose)
```sh
make docker-up     # builds image and starts on :8080
```
Open `http://<host>:8080`. Stop with `make docker-down`.

The Compose setup uses a named volume (`intercom_data`) for the SQLite database.

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `APP_ADDR` | `:8080` | Listen address |
| `STATIC_DIR` | _(empty)_ | Path to built frontend assets (enables static file serving) |
| `DB_PATH` | `intercom.db` | SQLite database file path |
| `ALLOW_CORS` | `true` | Enable CORS headers (disable in production behind same origin) |
| `SESSION_TTL_MINUTES` | `720` | Session lifetime in minutes |
| `TRUSTED_LAN_HTTP` | `true` | Run plain HTTP (set to `false` for HTTPS with local certs) |

## Tests
```sh
make test          # runs go test ./... and frontend build check
```

## Soak test
Smoke-test login/bootstrap/logout cycles:
```sh
bash scripts/soak/session_soak.sh http://localhost:8080 30 20
```

## All Makefile targets
Run `make help` to see available targets:
`deps`, `dev-backend`, `dev-web`, `run-backend`, `build`, `test`, `docker-build`, `docker-up`, `docker-down`, `clean`.

