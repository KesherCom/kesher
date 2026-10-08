# Running the Kesher server

The server is one program: web UI, API and audio relay. Clients (browsers,
desktop app, Raspberry Pi stations) connect to it. Pick the way that fits:

| Where | How | Section |
| --- | --- | --- |
| **Linux server** (permanent installation, up to ~50 people) | Docker with the published image, no source code needed | [Linux server with Docker](#linux-server-with-docker-recommended) |
| Windows or Mac PC (small setup, rehearsal, test) | Download the server program and start it | [Windows or Mac PC](#windows-or-mac-pc) |
| Windows or Mac with Docker Desktop | Build from the repository | [Docker Desktop](#docker-desktop-windows-or-mac) |
| Trusted certificate for your own domain | Let's Encrypt via DNS | [README: Docker](../../README.md#docker), `docker-compose.certmagic.yml` |

**Why HTTPS matters:** browsers only allow the microphone on `https://`
pages (or on `localhost`). The desktop app and the Pi stations work with
both HTTP and HTTPS. The Linux setup below uses HTTPS with a self-signed
certificate: each device confirms a warning once, then it works.

## Linux server with Docker (recommended)

Works on any 64-bit Linux server (x86 or ARM) with Docker. The container
uses the server's network directly (`network_mode: host`): no port mapping
in the audio path, and no IP address to configure.

### 1. Install Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
```

### 2. Get the two files

Create a folder and download `docker-compose.yml` and `.env.example` from
[`deploy/server`](../../deploy/server) of the release you want (replace
`v0.9.0` with the current release from the
[releases page](https://github.com/KesherCom/kesher/releases)):

```sh
sudo mkdir -p /opt/kesher && cd /opt/kesher
sudo curl -fsSLO https://raw.githubusercontent.com/KesherCom/kesher/v0.9.0/deploy/server/docker-compose.yml
sudo curl -fsSL -o .env https://raw.githubusercontent.com/KesherCom/kesher/v0.9.0/deploy/server/.env.example
```

### 3. Set the admin PIN

```sh
sudo nano .env
```

Set `ADMIN_PIN=` to your own PIN. Everything else can stay as it is. For
events, set `KESHER_VERSION` to a fixed release (e.g. `0.9.0`) so the
server only changes when you decide to.

### 4. Open the firewall

| Port | Protocol | For |
| --- | --- | --- |
| 8443 | TCP | web UI and API |
| 8081 | UDP | audio of the desktop app and the Pi stations |
| 8082 | UDP | audio of browsers |

With `ufw`:

```sh
sudo ufw allow 8443/tcp && sudo ufw allow 8081:8082/udp
```

### 5. Start

```sh
sudo docker compose up -d
sudo docker compose logs -f
```

The log shows `generated self-signed certificate for ...` with the server's
addresses, then `starting server`. Stop following the log with Ctrl+C; the
server keeps running and starts again after a reboot.

### 6. Connect

- **Browser:** open `https://<server-ip>:8443`, accept the certificate
  warning once, log in. The admin area uses the PIN from step 3.
- **Desktop app:** server address `https://<server-ip>:8443`.
- **Raspberry Pi station:** in `/etc/kesher/node.toml`
  `server = "https://<server-ip>:8443"` and `tls_insecure = true` (the
  certificate is self-signed); see [raspberry-pi.md](../hardware/raspberry-pi.md).

### Everyday tasks

All commands in `/opt/kesher`:

| Task | Command |
| --- | --- |
| Status / logs | `sudo docker compose ps` / `sudo docker compose logs -f` |
| Update | set `KESHER_VERSION` in `.env` (or keep `latest`), then `sudo docker compose pull && sudo docker compose up -d` |
| Restart | `sudo docker compose restart` |
| Stop | `sudo docker compose down` (data is kept) |
| Back up the database | `sudo docker compose cp kesher:/app/data/intercom.db ./intercom-backup.db` |
| New certificate (after the server's IP changed) | `sudo docker compose down && sudo docker volume rm kesher_kesher_certs && sudo docker compose up -d` |

### If something does not work

| Symptom | Fix |
| --- | --- |
| `set ADMIN_PIN in .env` on start | Step 3: `ADMIN_PIN=` must not be empty. |
| Page loads, but no audio | UDP 8081 and 8082 must be open (step 4), also in firewalls between clients and server. |
| Audio only works on some networks | The server has several networks: set `KESHER_PUBLIC_IP` in `.env` to the address clients use, then recreate the certificate (table above). |
| Browser: no microphone | Use `https://`, not `http://`. |
| `pull access denied` | The image is not public yet (maintainers: see [Releases](../releases/README.md)). |

## Windows or Mac PC

For a single PC, the server program alone is simpler and faster than
Docker:

1. Download `kesher-server-windows-amd64.zip` (or
   `kesher-server-darwin-arm64.tar.gz` / `-amd64` for Mac) from the
   [releases page](https://github.com/KesherCom/kesher/releases) and unpack it.
2. Start it from a terminal in that folder, with your own admin PIN.
   Windows (PowerShell):

   ```powershell
   $env:ADMIN_PIN="4711"; .\kesher-windows-amd64.exe
   ```

   This serves `http://<pc-ip>:8080`. For HTTPS (microphone in browsers on
   other devices) add `$env:TRUSTED_LAN_HTTP="false";` before the program;
   it then uses a self-signed certificate.
3. When Windows asks about the firewall, allow access on **private
   networks**.

The PC must stay on and must not go to sleep while the intercom is in use.

## Docker Desktop (Windows or Mac)

Docker Desktop cannot use `network_mode: host`, so the Linux setup above
does not apply. Use the compose files in [`deploy/compose`](../../deploy/compose),
which publish the ports and build the image from the repository; see
[README: Docker](../../README.md#docker). Set `KESHER_PUBLIC_IP` to the PC's
LAN address there. Audio passes through Docker Desktop's port forwarding,
which adds a little latency; for regular use prefer a Linux server or the
plain server program.
