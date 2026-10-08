# Running the Kesher server

The server is one program: web UI, API and audio relay. Clients (browsers,
desktop app, Raspberry Pi stations) connect to it. Pick the way that fits:

| Where | How | Section |
| --- | --- | --- |
| **Linux server** (permanent installation, up to ~50 people) | One install command (Docker, published image) | [Linux server with Docker](#linux-server-with-docker-recommended) |
| Windows or Mac PC (small setup, rehearsal, test) | Download the server program and start it | [Windows or Mac PC](#windows-or-mac-pc) |
| Windows or Mac with Docker Desktop | Build from the repository | [Docker Desktop](#docker-desktop-windows-or-mac) |
| Trusted certificate for your own domain | Let's Encrypt via DNS | [README: Docker](../../README.md#docker), `docker-compose.certmagic.yml` |

**Why HTTPS matters:** browsers only allow the microphone on `https://`
pages (or on `localhost`). The desktop app and the Pi stations work with
both HTTP and HTTPS. The Linux setup below uses HTTPS with a self-signed
certificate: each device confirms a warning once, then it works.

## Linux server with Docker (recommended)

Works on any 64-bit Linux server (x86 or ARM): Debian, Ubuntu, Raspberry Pi
OS, Fedora and others. Kesher runs in Docker and uses the server's network
directly (`network_mode: host`): no port mapping in the audio path, and no
IP address to configure.

### Install with one command

```sh
curl -fsSL https://raw.githubusercontent.com/KesherCom/kesher/main/deploy/server/install.sh | sudo bash
```

It asks no questions. It installs Docker if it is missing, sets up
`/opt/kesher`, downloads the server image, opens the firewall ports (ufw or
firewalld), starts Kesher (also after every reboot), installs the `kesher`
command and prints the address to open.

**Then open that address in a browser** (`https://<server-ip>:8443`,
confirm the certificate warning once). The first visit shows the setup
page:

1. choose the **admin PIN**,
2. keep the **example setup** (roles and party lines for a typical
   production, adjustable later) or start empty,
3. *Finish setup*: the admin area opens.

That is all. Running the installer again is safe: settings and data are
kept, the server is updated.

**Before the first release with Docker images** (or to test a branch), let
it build the image from that branch instead of downloading it:

```sh
curl -fsSL https://raw.githubusercontent.com/KesherCom/kesher/dev/deploy/server/install.sh | sudo bash -s -- --build --ref dev
```

Options (after `bash -s --`):

| Option | Meaning |
| --- | --- |
| `--pin PIN` | set the admin PIN now instead of on the setup page (letters, digits, `.` `-` `_`) |
| `--version 0.9.0` | a fixed release instead of `latest` (recommended for events) |
| `--build --ref BRANCH` | build the image from a branch on this machine |
| `--dir DIR` | install somewhere else than `/opt/kesher` |

### Connect

- **Browser:** open `https://<server-ip>:8443`, accept the certificate
  warning once, log in. The admin area uses the PIN from the setup page.
- **Desktop app:** the connection screen lists the server under "Im
  Netzwerk gefunden"; click *Verbinden*. Otherwise enter
  `http://<server-ip>:8080` (the app uses plain HTTP on the LAN; it cannot
  click through a self-signed certificate warning like a browser).
- **Raspberry Pi station:** install the package; the station finds the
  server and appears in the admin area under **Stations** for approval.
  See [raspberry-pi.md](../hardware/raspberry-pi.md).

Discovery works within one network. Background: [decision 0005](../decisions/0005-zero-config-stations.md).

### Everyday tasks

| Task | Command |
| --- | --- |
| Is it running? Which addresses? | `kesher status` |
| Follow the log | `kesher logs` |
| Update to the newest version | `sudo kesher update` |
| Switch to a specific version | `sudo kesher update 0.9.0` |
| Restart (e.g. after editing `/opt/kesher/.env`) | `sudo kesher restart` |
| Back up the database | `sudo kesher backup` |
| New certificate (after the server's IP changed) | `sudo kesher new-certificate` |
| Remove (keeps data; `--purge` deletes it) | `sudo kesher uninstall` |

Settings (ports, version) are in `/opt/kesher/.env`. The admin PIN is
changed in the admin area (Security - Admin PIN); an `ADMIN_PIN` in `.env`
would override it on every start.

### Manual installation (without the installer)

The installer only automates these steps:

1. Install Docker: `curl -fsSL https://get.docker.com | sudo sh`
2. Put [`docker-compose.yml`](../../deploy/server/docker-compose.yml) and
   [`.env.example`](../../deploy/server/.env.example) into `/opt/kesher` and
   rename `.env.example` to `.env`.
3. Open the ports in the table below, e.g.
   `sudo ufw allow 8443/tcp && sudo ufw allow 8080/tcp && sudo ufw allow 8081:8082/udp && sudo ufw allow 5353/udp`.
4. In `/opt/kesher`: `sudo docker compose up -d`, then open the address
   and finish the setup page.

| Port | Protocol | For |
| --- | --- | --- |
| 8443 | TCP | web UI and API for browsers (HTTPS) |
| 8080 | TCP | desktop app and Pi stations (plain HTTP on the LAN) |
| 8081 | UDP | audio of the desktop app and the Pi stations |
| 8082 | UDP | audio of browsers |
| 5353 | UDP | discovery (mDNS), so apps and stations find the server |

### If something does not work

| Symptom | Fix |
| --- | --- |
| Page loads, but no audio | UDP 8081 and 8082 must be open, also in firewalls between clients and server. |
| Desktop app or Pi does not find the server | They must be in the same network, and UDP 5353 must be open on the server. Otherwise enter the address (`http://<server-ip>:8080` in the app, `server = "https://<server-ip>:8443"` on the Pi). |
| Audio only works on some networks | The server has several networks: set `KESHER_PUBLIC_IP` in `/opt/kesher/.env` to the address clients use, then `sudo kesher new-certificate`. |
| Browser: no microphone | Use `https://`, not `http://`. |
| Someone else finished the setup page first | Only possible in the minutes between start and setup. Reset: `sudo kesher uninstall --purge`, install again. |
| `cannot download ghcr.io/...` | No release with Docker images yet: install with `--build --ref <branch>`. Maintainers: images must be public (see [Releases](../releases/README.md)). |
| Server does not start | `kesher logs` shows why. |

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
