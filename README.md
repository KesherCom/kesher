# Live Production Intercom
On-prem, web-based intercom for church live productions.

## Monorepo layout
- `backend/` Go API + WebSocket signaling + SQLite persistence
- `web/` React + TypeScript frontend
- `deploy/compose/` Docker Compose deployment
- `docs/implementation-plan.md` product and architecture plan

## Quick start (dev)
1. Backend:
   - `cd backend`
   - `go run ./cmd/server`
2. Frontend:
   - `cd web`
   - `npm install`
   - `npm run dev`

Backend defaults to `:8080`; frontend defaults to `:5173`.

## Quick start (on-prem container)
From repo root:
- `docker compose -f deploy/compose/docker-compose.yml up --build`

Then open `http://<host>:8080`.

## Hardening features currently included
- WebSocket reconnect with exponential backoff in the web client
- Safer WebRTC renegotiation/offer flow and buffered ICE handling on server/client
- Presence includes voice mode + mic on/off state
- Microphone input device picker and local input level meter

## Soak test (session/auth smoke)
Run repeated login/bootstrap/logout cycles:
- `bash scripts/soak/session_soak.sh http://localhost:8080 30 20`

