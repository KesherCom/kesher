# AGENTS.md

Guidance for coding agents working in this repository.

## Build, run, and test commands

Primary workflow is via `Makefile`:

```sh
make deps
make dev-backend   # API + audio on :8080, no UI there
make dev-web       # the UI on :5173 (proxies /api and /ws to :8080)
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

Docker: one image `deploy/docker/Dockerfile` (targets `runtime`, `selfsigned`), published on release tags as `ghcr.io/keshercom/kesher` / `kesher-selfsigned` (amd64+arm64). `deploy/server/` = production Linux setup from the published image (`network_mode: host`, only `ADMIN_PIN` required): `install.sh` (one-command installer without questions, `--build --ref <branch>` builds the image locally; `KESHER_SOURCE_DIR` for testing from a checkout) and the `kesher` management command; guide `docs/deployment/server.md`. It sets `FIRST_RUN_SETUP=true`: a fresh server shows a setup page (admin PIN, example or empty config; `backend/internal/app/setup.go`, `SetupView.tsx`) and admin login stays closed until then. The admin area sends the PIN entered at login (kept in sessionStorage), not a client-side default. `deploy/compose/` = build-from-source compose files (dev, Docker Desktop, CertMagic).
WebRTC in containers needs `WEBRTC_UDP_PORT` (single UDP mux port, published 1:1) and `WEBRTC_PUBLIC_IPS` (host LAN IP).
Test lab lives in `testlab/` (own `package.json`, Playwright); see `testlab/README.md`. The benchmark binary is `crates/kesher-audio/src/bin/kesher_audio_bench.rs` (cargo feature `bench`, never bundled); it drives the real engine (`crates/kesher-audio/src/native.rs`) through `VirtualDevice`.

Rust code is one Cargo workspace at the repo root (`Cargo.toml`, committed `Cargo.lock`, output in `./target`):

- `crates/kesher-audio`: the native low-latency audio engine (capture -> Opus -> KSHR/UDP -> jitter buffer -> mix), shared by the desktop app and the node. Windows WASAPI in `wasapi.rs`, Linux real-time threads in `realtime_linux.rs`.
- `desktop/src-tauri`: Tauri app; uses the engine as `kesher_audio::native` (aliased `audio_native` in `main.rs`).
- `crates/kesher-discovery`: finds servers on the LAN (mDNS `_kesher._tcp`); used by the node and the desktop app (`discover_servers` command, connection screen). The server side is `backend/internal/app/discovery.go` (`MDNS_ENABLED`, `MDNS_NAME`).
- `crates/kesher-node`: headless station for Raspberry Pi 3/4/5 (systemd service, `/etc/kesher/node.toml`, GPIO talk button/LED). Without `role` it pairs: `POST /api/devices/login` -> pending until approved in the admin area (Stations card, `backend/internal/app/devices.go`, `/api/admin/devices`); self-signed server certs are trusted on first use (`net.rs` `Trust`). See `docs/decisions/0005-zero-config-stations.md`. Speaks the same protocol as the desktop app in performance mode (login, `/ws?transport=native`, `native_audio_endpoint`, `voice_state`). Packaged by `make node-deb` (Docker, `deploy/node/`); user docs in `docs/hardware/raspberry-pi.md`.

Design decisions are recorded in `docs/decisions/` (add a numbered file for new ones).

UI follows the visual system in `docs/design/README.md` (decision 0007): signal colors with one meaning (hear green, on air red, call yellow, attention orange, cyan only for selection), IBM Plex, 44 px touch targets, three button kinds, one stroke icon set. Values are the `--k-*` variables in `packages/client-core/src/styles/tokens.css` (`theme.css` is only the page base); icons come from `components/Icon.tsx`; buttons are `.primary`/`.secondary`/`.danger`/`.k-icon-button`. Do not add raw colors.

CI: `.github/workflows/ci.yml` runs on every push (Go tests, client-core tests, web build, Rust tests on Linux, arm64 node package). `release-binaries.yml` builds everything (server, node, Windows/macOS desktop) on tags `v*` (and publishes the release), on manual runs, and on pushes whose commit message contains `[full-build]` (build only, no release). Release file names, versioning (`scripts/set-desktop-version.mjs`) and the release steps: `docs/releases/README.md`; keep `docs/releases/downloads.md` in sync when release files change.

```sh
cargo test -p kesher-audio -p kesher-node
make node-deb            # arm64 .deb into dist/node/ (NODE_ARCH=amd64 for x86)
```

Useful direct commands:

```sh
make help
cd backend && go test ./...
cd backend && go test -run TestHubDirectRouting ./internal/app/
npm --prefix packages/client-core test          # Vitest + Testing Library
npm --prefix packages/client-core run test:watch
npm --prefix web run build                      # TypeScript + Vite build of the browser shell
make lab-test                                   # Playwright in real browsers (testlab/)
```

All UI code and its unit tests live in `packages/client-core`; `web/` and `desktop/` only hold the entry points (`main.tsx`, `index.html`, Vite config). Browser tests with Playwright live in `testlab/` only. There is no separate frontend lint target; frontend validation is the build plus the tests.

## Pre-commit behavior

- `.pre-commit-config.yaml` runs `client-core-tests` (`npm --prefix packages/client-core run test`), `web-typescript-build` (`npm --prefix web run build`), Prettier, `go fmt` and gitleaks.
- If hooks auto-format files, re-stage (`git add -A`) and re-run the same commit command.

Companion module (Bitfocus) lives in a separate repository:
`https://github.com/KesherCom/companion-module-kesher`

## High-level architecture

- `backend/`: Go API + WebSocket event hub + embedded WebRTC SFU + native UDP audio relay + SQLite persistence.
- `packages/client-core/`: the one React UI (station, admin, settings), shared by the browser and the desktop app.
- `web/`: browser shell (Vite entry, PWA files in `public/`).
- `desktop/`: Tauri desktop app (`src-web/` shell around client-core, `src-tauri/` native side).
- `crates/`: Rust audio engine, LAN discovery, Raspberry Pi node.
- `testlab/`: emulated networks, browser and audio benchmarks.
- `deploy/`: Docker image, compose files, server installer, node packaging.

## Backend architecture (`backend/internal/app`)

- `server.go`: composition root for runtime behavior (HTTP routes, REST handlers, `/ws`, `/api/companion/*`, auth middleware, CORS, static SPA serving, optional HTTPS, production HTTP→HTTPS redirect).
- `hub.go`: in-memory real-time state keyed by session token; presence fanout; routing for `direct` / `room` / `broadcast` events; active party‑line + listen/talk matrices; signal/reply metadata for companion workflows.
- `media.go`: Pion WebRTC SFU logic. Maintains peer connections, receives remote audio tracks, forwards RTP to selected listeners, handles offer/answer + ICE, and recomputes routing when room matrix / direct PTT / broadcast PTT changes.
- `store.go`: SQLite schema migration + seed + CRUD. Role/party-line/broadcast policy data is persisted and consulted by both event routing and media routing paths.
- `auth.go`: in-memory session manager (UUID bearer tokens, TTL from config).
- `config.go`: environment-driven config (TLS file mode and CertMagic DNS-01 mode, production listener split, session and CORS settings).
- `models.go`: shared API, WS, and domain types.
- `tls_certmagic.go`: CertMagic DNS-01 ACME integration; builds `certmagic.Config` from env vars and wires up DNS providers (cloudflare, hetzner, route53 via `libdns`).
- `static_embedded.go`: `//go:embed` of `embedded_web/` so a built binary serves the UI without `STATIC_DIR`. The folder is filled only during a build (`scripts/embedded-web.mjs fill`, used by `make build-backend`, the Dockerfile, CI and testlab) and emptied right after, so `go run` / `make dev-backend` never serves an old UI; without a UI the server answers pages with a hint to `make dev-web`.

Important coupling to understand before changing routing logic:

- `Hub` and `MediaManager` are intentionally linked (`hub.SetMediaManager(media)`), and `MediaManager` reads hub client state while holding internal locks for routing decisions.
- Authorization for party-line/broadcast access is enforced in both event handling (`server.go` + `hub.go`) and media forwarding (`media.go`), so behavior changes usually require updates in both places.
- Store sentinel errors (`ErrInvalidInput`, `ErrConflict`, `ErrNotFound`) are mapped centrally in `writeStoreErr`.
- Admin endpoints (`requireAdmin` in `server.go`) require the admin PIN in the `X-Admin-Pin` header (lab servers use `ADMIN_PIN`, default `123456`).

## Frontend architecture (`packages/client-core/src`)

- `App.tsx`: screens (setup, login, station/simple view, admin, settings) and wiring.
- `hooks/useIntercomSession.ts`: login/bootstrap, WS lifecycle with reconnect backoff, RTCPeerConnection, routing/voice state, chat, companion commands; `hooks/useLocalMic.ts` etc. for devices and metering.
- `api.ts`: REST wrappers; auth is the bearer token in `Authorization`.
- `types.ts` mirrors backend JSON contracts.
- `components/`: station and simple views, `admin/`, `settings/`, `panels/`, `Icon.tsx`.
- `app/`: settings storage, keyboard shortcuts, small helpers.
- The Vite dev servers (`web/vite.config.ts` :5173, `desktop/vite.config.ts` :1420) proxy `/api` and `/ws` to :8080.

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

- Roles are shared by default (several logins per role); only roles with `exclusive` ask to take over. A direct call to `role:<roleId>` reaches everyone in the role (`directTargetMatches` in `hub.go`).
- Stream Decks: one Companion connection per deck with `?deck=<serial or name>` on discovery, profile, `/api/companion/ws` and `/api/image-stream`. A deck belongs to a place (`placeId` sent at login, `lib/place.ts`; stations use `station-<device id>`), controls whoever is logged in there and has its own layout (falls back to that login's role layout). Pairing: code on the unpaired deck, entered in the app (`/api/user/stream-decks/pair`) or in the admin area (`/api/admin/stream-decks`). Code in `backend/internal/app/stream_decks.go`; companion state is keyed by `deck:<id>` instead of the role ID. See `docs/decisions/0006-shared-roles-and-stream-decks-per-place.md`.
- Older connections use `?roleId=<roleId>` (`username` is rejected) and bind to the latest login of that role.

## Module paths and runtime dependencies

- Backend module: `github.com/KesherCom/kesher/backend`
- SQLite driver is `modernc.org/sqlite` (pure Go, no CGO runtime dependency).
- WebRTC SFU uses `github.com/pion/webrtc/v4`.
