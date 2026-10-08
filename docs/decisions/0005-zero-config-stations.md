# 0005: Stations need no configuration (discovery, approval, LAN HTTP)

Date: 2026-10-08 · Status: accepted

## Context

Setting up a Raspberry Pi station meant editing a config file on the Pi
(server address, role, name), and the recommended Linux server uses a
self-signed HTTPS certificate, which the desktop app's WebView rejects
outright. The goal: install, plug in, approve, done.

## Decision

1. **Discovery.** The server announces itself via mDNS/DNS-SD as
   `_kesher._tcp` (`backend/internal/app/discovery.go`, TXT `scheme`,
   `version`, `http_port`). The node and the desktop app browse for it
   (`crates/kesher-discovery`). A configured address still wins.
2. **Approval instead of credentials.** A node without a `role` creates a
   device ID and a secret on first start and calls
   `POST /api/devices/login`. Unknown devices are stored as *pending* and
   shown in the admin area (Stations); an admin approves them with name,
   role and talk mode. Only a hash of the secret is stored; the first
   device to present an ID owns it (trust on first use), the approval is
   the gate. Changing a station's settings revokes its session with reason
   `device_updated`, and the node logs in again with the new settings.
3. **Certificates: trust on first use.** The node verifies public-CA
   certificates normally; a self-signed one is accepted on first contact
   and pinned per server (`server-certs.json`), like SSH host keys.
4. **Plain HTTP for native clients.** With `LAN_HTTP_ADDR` the server also
   serves plain HTTP next to HTTPS (on by default in `deploy/server`, port
   8080). Browsers keep HTTPS (needed for the microphone); the desktop app
   uses the HTTP address, which discovery reports as `http_url`.

## Why

- Each station is set up in under a minute, by people who do not edit
  files on a Pi.
- No secrets to distribute: the admin PIN never leaves the admin's browser.
- HTTP on the LAN was already the documented mode for the desktop app; the
  extra listener keeps it working when browsers need HTTPS on the same
  server.

## Limits and alternatives

- mDNS does not cross networks/VLANs; then the address is configured.
  Behind Docker's bridge network the announcement does not reach the LAN
  (`deploy/server` uses host networking).
- Anyone on the LAN can create pending entries (capped at 100) but not
  approve them.
- The desktop app's traffic on port 8080 is unencrypted, like any plain
  HTTP LAN setup. A server-generated local CA that devices install once
  would allow HTTPS everywhere without warnings; not done yet.
