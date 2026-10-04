# kesher - Live Production Intercom

On-prem, web-based intercom for church live productions. Built for 30–50 concurrent users on a trusted LAN.

**Features:** WebRTC voice (always-on + push-to-talk), party‑lines with listen/talk matrix, broadcast groups spanning multiple party‑lines, direct PTT between users, real-time presence, role-based access, admin CRUD for roles/party‑lines/broadcasts, SQLite persistence.

## Quick start

**Prerequisites:** Go 1.25+, Node.js 22+, npm

```sh
make deps          # install all dependencies
make dev-backend   # terminal 1 — backend on :8080
make dev-web       # terminal 2 — frontend on :5173 (proxies API to backend)
```

Or serve everything from the backend:

```sh
make run-backend   # builds frontend, then starts backend with embedded UI on :8080
```

Open `http://localhost:8080` (or `:5173` if using the Vite dev server).

## Downloadable builds

Prebuilt binaries are published in GitHub Releases:

- https://github.com/KesherCom/kesher/releases

Release assets are named like:

- `kesher-darwin-arm64.tar.gz`
- `kesher-darwin-amd64.tar.gz`
- `kesher-windows-amd64.zip`
- `kesher-windows-arm64.zip`

Each archive contains a single backend binary (`kesher-<os>-<arch>` or `kesher-<os>-<arch>.exe`) with the web UI already embedded.

### Running unsigned binaries (macOS / Windows)

Some environments block unsigned binaries by default.

- **macOS (Gatekeeper):**
  1. Try to run the binary once from Terminal.
  2. If blocked, open **System Settings → Privacy & Security** and allow the app anyway.
  3. Run again.
  4. Optional CLI alternative: `xattr -d com.apple.quarantine ./kesher-darwin-arm64` (adjust filename as needed).
- **Windows (SmartScreen/Defender):**
  1. Run the `.exe`.
  2. If SmartScreen warns, click **More info** → **Run anyway**.
  3. If Defender quarantines it, restore/allow the file in Windows Security, then run again.

Desktop proxy binaries are maintained in a separate repository:
`https://github.com/KesherCom/kesher-desktop-proxy`

## HTTPS options

| Method                         | Command                                                                          | Notes                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Self-signed (dev/LAN)          | `make run-backend-https`                                                         | Generates an internal cert at startup. Browsers will show a warning.      |
| Let's Encrypt (existing certs) | `make run-backend-le DOMAIN=intercom.example.org`                                | Reads certs from `/etc/letsencrypt/live/<domain>/`                        |
| CertMagic (automated DNS-01)   | `make run-backend-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare` | Issues/renews certs in-app. Providers: `cloudflare`, `hetzner`, `route53` |

For production (HTTPS on `:443`, HTTP→HTTPS redirect on `:80`):

```sh
make run-production-le DOMAIN=intercom.example.org
# or
make run-production-certmagic DOMAIN=intercom.example.org DNS_PROVIDER=cloudflare
```

## Docker

One image (`deploy/docker/Dockerfile`) contains the Go server with the web UI
embedded. Three ready-made compose files cover the usual setups:

| Setup | Compose file | URL | Microphone works on |
| --- | --- | --- | --- |
| HTTP on a trusted LAN | `docker-compose.yml` | `http://<ip>:8080` | the server PC itself (localhost) and the desktop app |
| Self-signed HTTPS | `docker-compose.selfsigned.yml` | `https://<ip>:8443` | every device, after accepting the certificate once |
| Trusted HTTPS (Let's Encrypt, DNS-01) | `docker-compose.certmagic.yml` | `https://<your-domain>` | every device, no warning |

### 1. Configure

```sh
cp deploy/compose/.env.example deploy/compose/.env
```

Set at least:

- `KESHER_PUBLIC_IP`: the **LAN IP of the Docker host**, i.e. the address
  clients use to reach it. The server advertises it for audio, so leaving it
  at `127.0.0.1` means only the host PC itself gets audio.
- `ADMIN_PIN`: change it from the default `123456`.

Docker Compose reads `deploy/compose/.env` automatically.

### 2. Start

```sh
make docker-up          # HTTP on :8080        (docker-compose.yml)
make docker-up-https    # self-signed on :8443 (docker-compose.selfsigned.yml)
make docker-logs        # follow logs
make docker-down        # stop (data stays in the Docker volume)
```

Or call compose directly, e.g. for CertMagic (fill in the `CERTMAGIC_*` values in `.env` first):

```sh
docker compose -f deploy/compose/docker-compose.certmagic.yml up -d --build
```

### Ports and firewall

| Port | Protocol | Purpose |
| --- | --- | --- |
| 8080 / 8443 / 80+443 | TCP | web UI, API, WebSocket (depends on the setup) |
| 8082 (`KESHER_WEBRTC_UDP_PORT`) | UDP | **browser audio** (WebRTC, all peers multiplexed on one port) |
| 8081 (`KESHER_NATIVE_UDP_PORT`) | UDP | low-latency audio of the desktop app |

The UDP ports are published 1:1, so the host port equals the container port.
The server tells clients which port to use, so the two must not differ.
Open all of these ports in the host firewall.

**No audio but the UI works?** Check these in order:

1. `KESHER_PUBLIC_IP` must be the IP the clients use.
2. The UDP ports must be open.
3. The container log should show
   `webrtc: advertising public ICE host addresses`.

### Data, updates, backups

- The SQLite DB lives in the volume `kesher_data` (`/app/data/intercom.db`).
  Certificates live in `kesher_certs` (self-signed) or `kesher_certmagic`.
- To update: `git pull && make docker-up` rebuilds the image and recreates the
  container. Data is kept.
- To back up the DB:
  `docker compose -f deploy/compose/docker-compose.yml cp kesher:/app/data/intercom.db ./intercom-backup.db`
- The self-signed certificate is generated once for `localhost` and
  `KESHER_PUBLIC_IP` (`CERT_EXTRA_SAN` adds more names). After the IP changes,
  regenerate it:
  `docker compose -f deploy/compose/docker-compose.selfsigned.yml down && docker volume rm kesher-selfsigned_kesher_certs`

### Linux alternative: host networking

On a Linux host you can skip the port mapping and the public IP. Add
`network_mode: host` to the service and remove its `ports:` section. The
server then sees the real interfaces. This does not work with Docker Desktop
(Windows/macOS).

## LAN deployment with trusted HTTPS (no browser warnings)

To give LAN clients a trusted `https://` URL without certificate warnings, you need:

1. A domain you control (e.g. `intercom.example.org`)
2. A local DNS override so that domain resolves to your server's LAN IP
3. A publicly trusted certificate (e.g. from Let's Encrypt via DNS-01 challenge)

Once you have the certificate and DNS in place:

```sh
make run-production-le DOMAIN=intercom.example.org
```

Verify: open `https://intercom.example.org` from a LAN client — no warning, mic permissions work.

> **Tip:** If you'd like step-by-step guidance tailored to your specific setup, see the [LLM prompt template](#llm-prompt-template) below.

## Desktop proxy (alternative to HTTPS)

Instead of setting up HTTPS, you can distribute a small desktop app that proxies through `localhost`, which browsers treat as a secure context (mic access works without HTTPS).
The backend must serve the UI itself (`make run-backend` or the embedded binary). The proxy does **not** bundle frontend assets.
Desktop proxy source, run/build instructions, and release artifacts are in:
`https://github.com/KesherCom/kesher-desktop-proxy`

### macOS desktop release signing (maintainers)

The GitHub workflow supports two modes:

- With all Apple secrets configured: signed + notarized artifacts.
- Without Apple secrets: unsigned artifacts (build still succeeds).

Signed + notarized artifacts are recommended to avoid Gatekeeper warnings in normal user environments.

Required GitHub Actions secrets (repository settings):

- `APPLE_CERTIFICATE`: Base64-encoded `.p12` certificate export (Developer ID Application)
- `APPLE_CERTIFICATE_PASSWORD`: Password for the `.p12` certificate
- `APPLE_SIGNING_IDENTITY`: Certificate common name, e.g. `Developer ID Application: Example GmbH (TEAMID1234)`
- `APPLE_ID`: Apple ID used for notarization
- `APPLE_PASSWORD`: App-specific password for that Apple ID
- `APPLE_TEAM_ID`: Apple Developer Team ID

If one or more secrets are missing, macOS builds continue in unsigned mode.

If you are not part of the Apple Developer Program yet, you can still ship unsigned test artifacts. Users may need to open the app manually via Finder context menu (Open) or allow it in Privacy & Security.

## Single-binary build (embedded UI)

```sh
make build-backend   # builds frontend into the Go binary
./backend/bin/server # serves UI + API from one binary, no STATIC_DIR needed
```

## Tests

```sh
make test   # backend go tests + frontend build + client-core unit tests
```

### Test lab: everything in one command

```sh
make lab
```

`make lab` builds everything and starts four servers locally, each behind a
different emulated network: lan, wifi, wan and worst. No Docker is needed.
Then it measures two things:

- **Desktop app:** latency and audio quality of the app's real native audio
  engine for every network, compared with your saved baseline.
- **Browsers:** Chromium, Firefox and WebKit against every network (login,
  WebRTC, audio from talker to listener).

At the end it stops the servers and prints `PASS`/`FAIL` for each part.

While working on the desktop audio path:

```sh
make lab-desktop-baseline          # save a reference measurement
make lab-desktop                   # after each change: shows Δ latency / Δ distortion per network
LAB_FRAME_MS=2.5,5,10 make lab-desktop
make lab-desktop-hw                # real mouth-to-ear with your sound card (cable/speaker loopback)
```

See [testlab/README.md](testlab/README.md) for all details and options.

## Load testing (real-world style)

The backend includes a staged load test that simulates:

- increasing concurrent clients,
- realistic operator WS traffic (`chat`, `signal`, `voice_state`, matrix updates),
- real WebRTC signaling (`webrtc_offer`/`webrtc_answer`/ICE) and synthetic RTP audio streams,
- non-ideal Wi-Fi style behavior (latency, jitter, packet loss, occasional disconnect/reconnect).

Run it with:

```sh
make loadtest
# or run the built-in 20-client profile
make loadtest-20
```

Useful tuning variables:

```sh
LOADTEST_STAGE_CLIENTS=20,40,80 \
LOADTEST_STAGE_HOLD_SECONDS=20,30,45 \
LOADTEST_RAMP_INTERVAL_MS=250 \
LOADTEST_ACTION_INTERVAL_MS=800 \
LOADTEST_NET_BASE_LATENCY_MS=40 \
LOADTEST_NET_JITTER_MS=30 \
LOADTEST_NET_SPIKE_CHANCE=0.10 \
LOADTEST_NET_SPIKE_LATENCY_MS=220 \
LOADTEST_NET_PACKET_LOSS=0.04 \
LOADTEST_NET_MEDIA_PACKET_LOSS=0.06 \
LOADTEST_NET_DISCONNECTS_PER_MIN=0.30 \
make loadtest
```

The run prints per-stage and final summaries (client counts, queue pressure, dropped messages, reconnects, etc.) so you can compare profiles over time.

Profile selection is also available via `LOADTEST_PROFILE` (`default` or `20clients`).

Run `make help` for all available targets.

## Environment variables

You can also use a `config.yaml` (or `config.yml`) in the backend working directory instead of environment variables.
To specify a custom path, set `APP_CONFIG_FILE` (or `CONFIG_FILE`).
If a config file is present, it is used as the config source; otherwise env vars are used.
Start from the provided example with:

```sh
cp config.yaml.example config.yaml
```

Example:

```yaml
app_addr: ":8080"
db_path: "intercom.db"
allow_cors: true
session_ttl_minutes: 720
trusted_lan_http: true
tls_mode: "internal"
tls_cert_file: ""
tls_key_file: ""
production_mode: false
production_https_addr: ":443"
production_http_redirect_addr: ":80"
certmagic_domains: []
certmagic_email: ""
certmagic_ca: "https://acme-v02.api.letsencrypt.org/directory"
certmagic_storage_path: "./certmagic-data"
certmagic_challenge: "dns-01"
certmagic_dns_provider: ""
certmagic_propagation_delay_seconds: 0
certmagic_propagation_timeout_seconds: 120
certmagic_dns_resolvers: []
telegram_bot_token: ""
telegram_webhook_secret: ""
telegram_mode: "polling"
companion_shared_secret: ""
companion_allowed_usernames: []
desktop_audio_adaptation_profile: "balanced"
webrtc_udp_port: 0
webrtc_public_ips: []
```

| Variable                        | Default       | Description                                                                          |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `APP_ADDR`                      | `:8080`       | Listen address                                                                       |
| `STATIC_DIR`                    | _(empty)_     | Path to built frontend assets; when empty, serves embedded assets                    |
| `DB_PATH`                       | `intercom.db` | SQLite database file path                                                            |
| `ALLOW_CORS`                    | `true`        | Enable CORS headers                                                                  |
| `SESSION_TTL_MINUTES`           | `720`         | Session lifetime in minutes                                                          |
| `TRUSTED_LAN_HTTP`              | `true`        | `true` = plain HTTP, `false` = HTTPS                                                 |
| `TLS_MODE`                      | `internal`    | `internal` (auto self-signed), `file` (cert/key paths), or `certmagic` (in-app ACME) |
| `TLS_CERT_FILE`                 | _(empty)_     | TLS certificate path (required when `TLS_MODE=file`)                                 |
| `TLS_KEY_FILE`                  | _(empty)_     | TLS key path (required when `TLS_MODE=file`)                                         |
| `PRODUCTION_MODE`               | `false`       | HTTPS on `:443` + HTTP redirect on `:80`                                             |
| `PRODUCTION_HTTPS_ADDR`         | `:443`        | HTTPS listen address in production mode                                              |
| `PRODUCTION_HTTP_REDIRECT_ADDR` | `:80`         | HTTP redirect address in production mode                                             |
| `ADMIN_PIN`                     | `123456`      | PIN for the admin area — change it                                                   |
| `WEBRTC_UDP_PORT`               | `0`           | Multiplex all WebRTC media on this single UDP port (`0` = random port per peer). Set in Docker/behind firewalls |
| `WEBRTC_PUBLIC_IPS`             | _(empty)_     | IP advertised to browsers instead of the local interface IPs (Docker host LAN IP)    |
| `UDP_AUDIO_ADDR`                | `:8081`       | Native (desktop app) UDP audio relay listen address; empty disables it               |
| `UDP_AUDIO_ADVERTISE_IP`        | _(empty)_     | IP advertised to the desktop app for the UDP relay (default: host from the request)  |
| `COMPANION_SHARED_SECRET`       | _(empty)_     | Optional shared secret required by Companion discovery and bridge endpoints           |
| `COMPANION_ALLOWED_USERNAMES`   | _(empty)_     | Optional comma-separated allowlist of usernames that may be controlled by Companion   |

### Desktop audio adaptation profile (YAML)

The native desktop audio engine can read an adaptation profile from `config.yaml`/`config.yml`:

```yaml
desktop_audio_adaptation_profile: "balanced"
```

Supported values:

- `balanced` (default)
- `ultra-low-latency`
- `robust-wlan`

Priority order for profile selection is:

1. Tauri `start_audio_engine` payload field `adaptation_profile`
2. Environment variable `KESHER_AUDIO_PROFILE`
3. YAML key `desktop_audio_adaptation_profile`
4. Built-in default `balanced`

### CertMagic variables (when `TLS_MODE=certmagic`)

| Variable                                | Default                  | Description                               |
| --------------------------------------- | ------------------------ | ----------------------------------------- |
| `CERTMAGIC_DOMAINS`                     | _(empty)_                | Comma-separated domain list (required)    |
| `CERTMAGIC_EMAIL`                       | _(empty)_                | ACME account email (recommended)          |
| `CERTMAGIC_CA`                          | Let's Encrypt production | ACME directory URL                        |
| `CERTMAGIC_STORAGE_PATH`                | `./certmagic-data`       | Persistent storage for certs/account keys |
| `CERTMAGIC_DNS_PROVIDER`                | _(empty)_                | `cloudflare`, `hetzner`, or `route53`     |
| `CERTMAGIC_PROPAGATION_TIMEOUT_SECONDS` | `120`                    | Max wait for DNS propagation              |

Provider-specific credentials:

- **Cloudflare:** `CERTMAGIC_CLOUDFLARE_API_TOKEN` (optional: `CERTMAGIC_CLOUDFLARE_ZONE_TOKEN`)
- **Hetzner:** `CERTMAGIC_HETZNER_API_TOKEN`
- **Route53:** `CERTMAGIC_ROUTE53_REGION`, `CERTMAGIC_ROUTE53_ACCESS_KEY_ID`, `CERTMAGIC_ROUTE53_SECRET_ACCESS_KEY` (and optionally `_PROFILE`, `_SESSION_TOKEN`, `_HOSTED_ZONE_ID`)

## LLM prompt template

Paste this into an LLM for guided HTTPS setup help tailored to your environment:

<details>
<summary>Click to expand prompt</summary>

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

</details>
