# Live Production Intercom
On-prem, web-based intercom for church live productions. Built for 30–50 concurrent users on a trusted LAN.

## Current state
- **Auth:** username + role selection login, in-memory sessions with configurable TTL (default 12 h).
- **Voice:** WebRTC SFU (Pion) embedded in the Go backend. Always-on and push-to-talk modes.
- **Rooms:** clients maintain a listen/talk room matrix; audio is routed by talk/listen overlap with role-policy enforcement.
- **Broadcast groups:** span multiple rooms. PTT on a broadcast group routes audio to all member rooms.
- **Direct PTT:** users can temporarily route mic audio to one direct target user.
- **Presence:** real-time presence over WebSocket — voice mode, mic state, active room, broadcast-active indicator.
- **Admin CRUD:** REST endpoints for managing roles, rooms, and broadcast groups (create/update/delete).
- **Persistence:** SQLite for roles, rooms, broadcast groups, and users.
- **Frontend:** React + TypeScript (Vite). Componentized station/simple views, mic/speaker device pickers, input level meter, and WebSocket reconnect with exponential backoff.

## Repository layout
```
backend/           Go API + WebSocket signaling + WebRTC SFU + SQLite
  cmd/server/      entrypoint
  internal/app/    server, hub, media, auth, store, models, config
web/               React + TypeScript frontend (Vite)
deploy/compose/    Docker Compose deployment
docs/              implementation plan
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
Run backend over HTTPS with self-signed certs (auto-generated if missing):
```sh
make run-backend-https LAN_IP=192.168.1.50
```
Run backend over HTTPS with Let's Encrypt certs already present under `/etc/letsencrypt/live/<domain>/`:
```sh
make run-backend-le DOMAIN=intercom.example.org
```
Run backend over HTTPS with in-app CertMagic automation (DNS-01 only):
```sh
make run-backend-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare
```
Run in production mode (HTTPS on `:443`, HTTP redirect on `:80`):
```sh
make run-production-le DOMAIN=intercom.example.org
```
Run in production mode with in-app CertMagic automation (DNS-01 only):
```sh
make run-production-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare
```

## Production (Docker Compose)
```sh
make docker-up     # builds image and starts on :8080
```
Open `http://<host>:8080`. Stop with `make docker-down`.

The Compose setup uses a named volume (`intercom_data`) for the SQLite database.

### Docker Compose with CertMagic (DNS-01)
Use the dedicated compose file and env template:
```sh
cp deploy/compose/.env.certmagic.example deploy/compose/.env.certmagic
# edit deploy/compose/.env.certmagic
docker compose -f deploy/compose/docker-compose.certmagic.yml --env-file deploy/compose/.env.certmagic up -d --build
```
This stack exposes `:80` and `:443`, enables `TLS_MODE=certmagic`, and persists cert/account state in the `intercom_certmagic` volume.

## Local deployment with a publicly trusted certificate (provider-agnostic)
This setup gives LAN clients a trusted HTTPS URL (no browser warning) by combining:
- a real domain/subdomain you control (for example `intercom.example.org`)
- a public CA certificate (for example Let's Encrypt)
- local DNS override so LAN clients resolve that hostname to your local server IP

### Prerequisites
- A registered domain and DNS control for that domain.
- A fixed LAN IP for the server running this app.
- Your LAN clients use a DNS resolver you control (router DNS, local DNS server, etc.).
- Certificate issuance via ACME (DNS-01 challenge recommended for local/on-prem setups without inbound port forwarding).

### Step 1: Choose a hostname
Pick a dedicated hostname (example: `intercom.example.org`).

Use this same hostname consistently for:
- certificate issuance
- DNS records
- browser access URL

### Step 2: Configure local DNS (split DNS / override)
Create a local DNS record so LAN clients resolve your hostname to the server's LAN IP.

Example mapping:
- `intercom.example.org -> 192.168.x.y`

Then verify from a client:
```sh
nslookup intercom.example.org
```
Expected: the returned address is your LAN server IP.

### Step 3: Obtain a public certificate
Issue a certificate for your hostname using your ACME client.

For local-only deployments, DNS-01 is typically the easiest and safest approach because it does not require exposing ports 80/443 to the internet.

Place the resulting files at stable paths (or know their exact paths), typically:
- certificate chain file (`fullchain.pem`)
- private key file (`privkey.pem`)

### Step 4: Start the app in production mode (HTTPS + HTTP redirect)
Use the provided target:
```sh
make run-production-le DOMAIN=intercom.example.org
```
This starts:
- HTTPS app listener on `:443`
- HTTP listener on `:80` that redirects to HTTPS

### Step 5: Test end-to-end
- Open `https://intercom.example.org` from a LAN client.
- Confirm the certificate is trusted in browser certificate details.
- Confirm microphone permissions and WebRTC work over HTTPS.

### Operational notes
- Certificates expire and must be renewed (automate renewals when possible).
- If your DNS provider does not support API automation, renewal may be manual.
- Ensure your router/firewall allows LAN access to ports `80` and `443`.
- If clients bypass local DNS (for example via encrypted DNS), local override may fail; enforce your intended DNS path on managed networks.

## Automated ACME inside the app (CertMagic, DNS-01 only)
The backend can issue and renew certificates directly using CertMagic with DNS-01 challenge automation.

Important behavior:
- Only DNS-01 challenge is supported in this mode.
- HTTP-01 and TLS-ALPN-01 are intentionally disabled.
- A persistent storage path is required for account keys and cert state (`CERTMAGIC_STORAGE_PATH`).

Supported DNS providers in this build:
- `cloudflare`
- `hetzner`
- `route53`

Example production run:
```sh
cd backend && sudo env "PATH=$PATH" \
  STATIC_DIR=../web/dist \
  TRUSTED_LAN_HTTP=false \
  PRODUCTION_MODE=true \
  TLS_MODE=certmagic \
  CERTMAGIC_DOMAINS=intercom.example.org \
  CERTMAGIC_DNS_PROVIDER=cloudflare \
  CERTMAGIC_CHALLENGE=dns-01 \
  CERTMAGIC_CLOUDFLARE_API_TOKEN={{CLOUDFLARE_API_TOKEN}} \
  go run ./cmd/server
```

Provider-specific credentials:
- Cloudflare: `CERTMAGIC_CLOUDFLARE_API_TOKEN` (optional `CERTMAGIC_CLOUDFLARE_ZONE_TOKEN`)
- Hetzner: `CERTMAGIC_HETZNER_API_TOKEN`
- Route53 (optional overrides): `CERTMAGIC_ROUTE53_REGION`, `CERTMAGIC_ROUTE53_PROFILE`, `CERTMAGIC_ROUTE53_ACCESS_KEY_ID`, `CERTMAGIC_ROUTE53_SECRET_ACCESS_KEY`, `CERTMAGIC_ROUTE53_SESSION_TOKEN`, `CERTMAGIC_ROUTE53_HOSTED_ZONE_ID`

### LLM prompt template
Copy/paste this into your preferred LLM if you want guided setup help:

```text
You are my deployment copilot. Help me set up LOCAL/LAN HTTPS for my app using a PUBLICLY TRUSTED certificate, with a process tailored to my specific local preconditions.

Target architecture (important):
- Clients are on the same LAN as the server.
- Clients must open ONE URL: https://<hostname> (no certificate warning).
- The hostname is a real domain/subdomain I control.
- LAN DNS must resolve that hostname to the server's private LAN IP (split DNS / local DNS override).
- Certificate issuance should use ACME DNS-01 by default (avoid exposing the local server to the public internet).
- My app should run in production mode with HTTPS on :443 and HTTP on :80 redirecting to HTTPS.

Project-specific runtime target:
- Final run command should be: make run-production-le DOMAIN=<hostname>
- This app expects certificate/key files from Let's Encrypt paths and runs its own TLS termination.

How you should assist:
1) First ask discovery questions ONE BY ONE until you have enough info.
2) Then output:
   a) architecture summary (my exact setup)
   b) ordered implementation plan
   c) exact commands and exact UI steps
   d) verification commands after each phase
   e) troubleshooting for likely failure points
3) Prefer DNS-01 path first. Only suggest HTTP-01 when explicitly requested.
4) Keep secrets safe: never ask me to paste private keys; use placeholders for API tokens.

Mandatory discovery questions:
- Desired FQDN (exact hostname).
- DNS provider and whether DNS API automation is available.
- Router / DNS resolver used by clients and whether local DNS override is configurable.
- Server OS and server LAN IP.
- Whether ports 80/443 are available locally on the server.
- Whether renewal should be automated or manual.
- Whether clients are managed/unmanaged (for DNS/DoH enforcement considerations).

Output constraints:
- Commands must be copy/paste-ready.
- Separate generic commands from provider-specific values/placeholders.
- Explicitly call out where I must wait for DNS propagation and how to verify TXT/A records.
- End with a concise maintenance checklist (renewal checks, DNS checks, cert expiry checks).
```

## Environment variables
| Variable | Default | Description |
|---|---|---|
| `APP_ADDR` | `:8080` | Listen address |
| `STATIC_DIR` | _(empty)_ | Optional path to built frontend assets; when empty, backend serves embedded UI assets (if bundled at build time) |
| `DB_PATH` | `intercom.db` | SQLite database file path |
| `ALLOW_CORS` | `true` | Enable CORS headers (disable in production behind same origin) |
| `SESSION_TTL_MINUTES` | `720` | Session lifetime in minutes |
| `TRUSTED_LAN_HTTP` | `true` | Run plain HTTP (`true`) or HTTPS (`false`) |
| `TLS_MODE` | `file` | TLS source: `file` (existing cert/key paths) or `certmagic` (in-app ACME) |
| `TLS_CERT_FILE` | _(empty)_ | TLS certificate path (required when `TRUSTED_LAN_HTTP=false`) |
| `TLS_KEY_FILE` | _(empty)_ | TLS private key path (required when `TRUSTED_LAN_HTTP=false`) |
| `PRODUCTION_MODE` | `false` | Enable production listeners: HTTPS app server + HTTP redirect server |
| `PRODUCTION_HTTPS_ADDR` | `:443` | HTTPS listen address used when `PRODUCTION_MODE=true` |
| `PRODUCTION_HTTP_REDIRECT_ADDR` | `:80` | HTTP redirect listen address used when `PRODUCTION_MODE=true` |
| `CERTMAGIC_DOMAINS` | _(empty)_ | Comma-separated certificate domain list (required when `TLS_MODE=certmagic`) |
| `CERTMAGIC_EMAIL` | _(empty)_ | ACME account email (optional, recommended) |
| `CERTMAGIC_CA` | `https://acme-v02.api.letsencrypt.org/directory` | ACME directory URL |
| `CERTMAGIC_STORAGE_PATH` | `./certmagic-data` | Persistent CertMagic storage path |
| `CERTMAGIC_CHALLENGE` | `dns-01` | Challenge type; only `dns-01` is supported |
| `CERTMAGIC_DNS_PROVIDER` | _(empty)_ | DNS provider identifier (`cloudflare`, `hetzner`, `route53`) |
| `CERTMAGIC_PROPAGATION_DELAY_SECONDS` | `0` | Delay before checking DNS challenge propagation |
| `CERTMAGIC_PROPAGATION_TIMEOUT_SECONDS` | `120` | Max wait for DNS challenge propagation |
| `CERTMAGIC_DNS_RESOLVERS` | _(empty)_ | Comma-separated DNS resolvers (e.g. `1.1.1.1:53,8.8.8.8:53`) |

## HTTPS with a self-signed certificate
Generate a self-signed cert/key for your LAN IP (replace `192.168.1.50`):
```sh
mkdir -p backend/certs
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout backend/certs/lan-key.pem \
  -out backend/certs/lan-cert.pem \
  -subj "/CN=192.168.1.50" \
  -addext "subjectAltName=IP:192.168.1.50,DNS:localhost"
```
Run backend with HTTPS:
```sh
cd backend && TRUSTED_LAN_HTTP=false TLS_CERT_FILE=./certs/lan-cert.pem TLS_KEY_FILE=./certs/lan-key.pem go run ./cmd/server
```
Then open `https://<host>:8080`.

Production mode example (requires privileges for ports `80` and `443`):
```sh
cd backend && sudo env "PATH=$PATH" PRODUCTION_MODE=true TLS_CERT_FILE=./certs/lan-cert.pem TLS_KEY_FILE=./certs/lan-key.pem go run ./cmd/server
```

## Desktop launcher/proxy (localhost secure-context workaround)
For desktop clients, you can run a local proxy app that opens the browser on `http://127.0.0.1:<port>` and forwards all UI/API/WS traffic to your backend.

This avoids installing trust material system-wide on each client browser machine and uses the localhost secure-context behavior for `getUserMedia()`.

Important:
- The backend must serve the UI itself (either with `STATIC_DIR`, e.g. `make run-backend` / `make run-backend-https`, or with embedded UI assets in the binary).
- The desktop proxy does **not** bundle frontend assets.

## Single-binary backend (embedded UI)
The backend can embed the built frontend into the Go binary.

Build backend with embedded UI:
```sh
make build-backend
```

This runs `make sync-embedded-web` (builds `web/dist` and copies it to `backend/internal/app/embedded_web/`) before compiling `backend/bin/server`.

Runtime behavior:
- if `STATIC_DIR` is set, backend serves assets from that directory,
- otherwise it serves embedded assets from the binary.

Build:
```sh
make build-desktop-proxy
```

Run (HTTP upstream):
```sh
make run-desktop-proxy UPSTREAM=http://192.168.1.50:8080
```

Run (HTTPS upstream with private/self-signed CA):
```sh
make run-desktop-proxy UPSTREAM=https://intercom.example.org CA_FILE=/path/to/ca.pem
```

Run (HTTPS upstream with certificate/public-key pinning):
```sh
make run-desktop-proxy UPSTREAM=https://intercom.example.org PINS='spki-sha256:<base64>,cert-sha256:<hex>'
```

Direct binary example:
```sh
./desktop-proxy/bin/desktop-proxy --upstream http://192.168.1.50:8080
```

Phase C packaging (desktop release artifacts):
```sh
# build binaries for macOS, Linux, and Windows (amd64 + arm64)
make build-desktop-proxy-all DESKTOP_PROXY_VERSION=v0.1.0

# same as above, plus SHA256 checksum manifest
make package-desktop-proxy DESKTOP_PROXY_VERSION=v0.1.0
```

Artifacts are written to:
```text
desktop-proxy/dist/<version>/
```

Notes:
- Local listener defaults to `127.0.0.1:0` (ephemeral port on loopback only).
- Browser is auto-opened on startup (`--open-browser=false` to disable).
- All routes (including `/`, `/api/*`, and `/ws`) are forwarded upstream.
- Startup runs a preflight probe to `/api/healthz` by default (fail-fast if upstream is not reachable). Override with `PRECHECK_PATH=...` or disable via `SKIP_PREFLIGHT=1`.
- If `UPSTREAM` omits a port, scheme defaults are used (`http` -> `80`, `https` -> `443`) and the launcher logs a warning.

## Tests
```sh
make test          # runs go test ./... and frontend build check
```

## All Makefile targets
Run `make help` to see available targets:
`deps`, `dev-backend`, `dev-web`, `run-backend`, `run-backend-https`, `run-backend-le`, `run-backend-certmagic`, `run-production-le`, `run-production-certmagic`, `run-desktop-proxy`, `sync-embedded-web`, `build-backend`, `build-web`, `build-desktop-proxy`, `build-desktop-proxy-all`, `package-desktop-proxy`, `build`, `test`, `docker-build`, `docker-up`, `docker-down`, `clean`.


