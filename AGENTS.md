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
make lab          # one command: build, 4 servers behind emulated networks, desktop audio bench + browser matrix
make lab-desktop  # desktop native-engine latency/quality per network vs baseline (make lab-desktop-baseline)
make lab-up      # test lab: 4 servers behind emulated networks, kept running (native processes; LAB_RUNTIME=docker for containers)
make lab-test    # Playwright: browsers x network profiles + audio quality table
make lab-open    # logged-in browser windows for manual testing
make lab-down
make clean
```

Docker: one image `deploy/docker/Dockerfile` (targets `runtime`, `selfsigned`); compose files and `.env.example` in `deploy/compose/`.
WebRTC in containers needs `WEBRTC_UDP_PORT` (single UDP mux port, published 1:1) and `WEBRTC_PUBLIC_IPS` (host LAN IP).
Test lab lives in `testlab/` (own `package.json`, Playwright); see `testlab/README.md`. The benchmark binary is `crates/kesher-audio/src/bin/kesher_audio_bench.rs` (cargo feature `bench`, never bundled); it drives the real engine (`crates/kesher-audio/src/native.rs`) through `VirtualDevice`.

Rust code is one Cargo workspace at the repo root (`Cargo.toml`, committed `Cargo.lock`, output in `./target`):

- `crates/kesher-audio`: the native low-latency audio engine (capture -> Opus -> KSHR/UDP -> jitter buffer -> mix), shared by the desktop app and the node. Windows WASAPI in `wasapi.rs`, Linux real-time threads in `realtime_linux.rs`.
- `desktop/src-tauri`: Tauri app; uses the engine as `kesher_audio::native` (aliased `audio_native` in `main.rs`).
- `crates/kesher-node`: headless station for Raspberry Pi 3/4/5 (systemd service, `/etc/kesher/node.toml`, GPIO talk button/LED). Speaks the same protocol as the desktop app in performance mode (login, `/ws?transport=native`, `native_audio_endpoint`, `voice_state`). Packaged by `make node-deb` (Docker, `deploy/node/`); user docs in `docs/hardware/raspberry-pi.md`.

Design decisions are recorded in `docs/decisions/` (add a numbered file for new ones).

CI: `.github/workflows/ci.yml` runs on every push (Go tests, web build, Rust tests on Linux, arm64 node package). `release-binaries.yml` builds everything (server, node, Windows/macOS desktop) on tags `v*` (and publishes the release), on manual runs, and on pushes whose commit message contains `[full-build]` (build only, no release).

```sh
cargo test -p kesher-audio -p kesher-node
make node-deb            # arm64 .deb into dist/node/ (NODE_ARCH=amd64 for x86)
```

Useful direct commands:

```sh
make help
cd backend && go test ./...
cd backend && go test -run TestHubDirectRouting ./internal/app/
cd web && npm run build
cd web && npm run test
cd web && npm run test:watch
cd web && npm run test:e2e
cd web && npm run test:all
```

Frontend test tooling lives in `web/` (Vitest + Testing Library for unit/component tests, Playwright for E2E).
If Playwright browsers are missing locally, run:

```sh
cd web && npx playwright install chromium
```

There is still no dedicated frontend lint target in `Makefile`; frontend validation is `npm run build` plus tests.

## Pre-commit behavior

- `.pre-commit-config.yaml` includes `web-quick-tests` (`npm --prefix web run test`) for fast frontend regression checks on commit.
- It also runs `web-typescript-build` (`npm --prefix web run build`) and Prettier.
- If hooks auto-format files, re-stage (`git add -A`) and re-run the same commit command.

Companion module (Bitfocus) lives in a separate repository:
`https://github.com/KesherCom/companion-module-kesher`

## High-level architecture

This repository has two parts:

- `backend/`: Go API + WebSocket event hub + embedded WebRTC SFU + SQLite persistence.
- `web/`: React/Vite SPA for operator clients.

Desktop proxy is maintained in a separate repository:
`https://github.com/KesherCom/kesher-desktop-proxy`

## Backend architecture (`backend/internal/app`)

- `server.go`: composition root for runtime behavior (HTTP routes, REST handlers, `/ws`, `/api/companion/*`, auth middleware, CORS, static SPA serving, optional HTTPS, production HTTP→HTTPS redirect).
- `hub.go`: in-memory real-time state keyed by session token; presence fanout; routing for `direct` / `room` / `broadcast` events; active party‑line + listen/talk matrices; signal/reply metadata for companion workflows.
- `media.go`: Pion WebRTC SFU logic. Maintains peer connections, receives remote audio tracks, forwards RTP to selected listeners, handles offer/answer + ICE, and recomputes routing when room matrix / direct PTT / broadcast PTT changes.
- `store.go`: SQLite schema migration + seed + CRUD. Role/party-line/broadcast policy data is persisted and consulted by both event routing and media routing paths.
- `auth.go`: in-memory session manager (UUID bearer tokens, TTL from config).
- `config.go`: environment-driven config (TLS file mode and CertMagic DNS-01 mode, production listener split, session and CORS settings).
- `models.go`: shared API, WS, and domain types.
- `tls_certmagic.go`: CertMagic DNS-01 ACME integration; builds `certmagic.Config` from env vars and wires up DNS providers (cloudflare, hetzner, route53 via `libdns`).
- `static_embedded.go`: `//go:embed` for `embedded_web/` directory so the backend binary can serve frontend assets without `STATIC_DIR`. `make sync-embedded-web` copies `web/dist` into this directory before build.

Important coupling to understand before changing routing logic:

- `Hub` and `MediaManager` are intentionally linked (`hub.SetMediaManager(media)`), and `MediaManager` reads hub client state while holding internal locks for routing decisions.
- Authorization for party-line/broadcast access is enforced in both event handling (`server.go` + `hub.go`) and media forwarding (`media.go`), so behavior changes usually require updates in both places.
- Store sentinel errors (`ErrInvalidInput`, `ErrConflict`, `ErrNotFound`) are mapped centrally in `writeStoreErr`.
- Admin endpoints (`requireAdmin` in `server.go`) require the admin PIN in the `X-Admin-Pin` header (lab servers use `ADMIN_PIN`, default `123456`).

## Desktop proxy architecture

Desktop proxy implementation lives in the standalone repo:
`https://github.com/KesherCom/kesher-desktop-proxy`

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
4. Client sends party-line matrix + voice state events over WS.
5. Hub routes control events (chat/signal/voice), MediaManager routes audio by:
   - direct target (if active),
   - else active broadcast group party‑lines (if active),
   - else talk-room → listen-room overlap.
6. Presence updates are broadcast after state changes.

## Companion integration

- Discovery endpoint: `GET /api/companion/discovery?roleId=<roleId>` (preferred, `username` still supported as legacy fallback)
- Bridge WebSocket: `/api/companion/ws?roleId=<roleId>` (preferred, `username` still supported as legacy fallback)
- Backend binds companion commands to the latest active token for that role ID, then relays commands through normal WS control paths.

## Module paths and runtime dependencies

- Backend module: `github.com/KesherCom/kesher/backend`
- SQLite driver is `modernc.org/sqlite` (pure Go, no CGO runtime dependency).
- WebRTC SFU uses `github.com/pion/webrtc/v4`.
