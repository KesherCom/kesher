# Raspberry Pi node (`kesher-node`)

A Raspberry Pi with a USB headset becomes a fixed intercom station: no
screen, no browser, it starts with the Pi and reconnects by itself. It uses
the same low-latency audio engine as the desktop app (Opus in 5 ms frames
over the server's UDP relay), so it hears and is heard like any other
desktop client.

- Code: [`crates/kesher-node`](../../crates/kesher-node) (control
  connection, config, GPIO) on top of
  [`crates/kesher-audio`](../../crates/kesher-audio) (the shared engine)
- Packaging: [`deploy/node`](../../deploy/node) (Debian package, systemd
  unit, example config)
- Decisions behind it: [docs/decisions](../decisions/README.md)

## Supported hardware

One build (`arm64`) runs on every 64-bit Pi. Use **Raspberry Pi OS Lite
(64-bit)**, bookworm or newer.

| Board | Works | Notes |
| --- | --- | --- |
| Pi 5 | yes | Recommended for new stations. |
| Pi 4 | yes | Plenty of headroom. |
| Pi 3 B / 3 B+ | yes | Slowest CPU; Ethernet and USB share one USB 2.0 bus (see below). Fine for a normal station. |
| Pi Zero 2 W | yes | Wi-Fi only (2.4 GHz), so latency depends on the radio. |
| Pi Zero / Zero W (v1), Pi 1/2 | no | 32-bit only and too slow. |

Measured values per board go into the [measurements](#measurements) table.

### Audio hardware

- **USB headsets and USB audio interfaces** that run at 48 kHz (almost all
  do). The node opens the card directly through ALSA (`plughw`), without
  PulseAudio or PipeWire in between.
- **Pi 3:** its USB controller is known for occasional glitches with USB
  audio under load. If you hear clicks, try another USB port or headset, or
  use a Pi 4/5. An I2S audio board avoids USB entirely (not supported yet).
- The Pi's own headphone jack has no microphone input, so it is no use here.

### Network

Wired Ethernet is strongly recommended; the <20 ms goal assumes it. Wi-Fi
works but adds variable delay (typically 5 to 30 ms); see
[the Wi-Fi decision](../decisions/0001-wifi-not-dect.md) for how to set up a
Wi-Fi network for the intercom.

## Setup

The short version: install the package, plug in the headset, approve the
station in the admin area. No configuration on the Pi is needed when it is
in the same network as the server.

### 1. Prepare the SD card

In **Raspberry Pi Imager** choose *Raspberry Pi OS Lite (64-bit)* and, under
*Edit settings*:

- set a **hostname** per station, e.g. `stage-left` (it is the suggested
  name when you approve the station),
- enable **SSH**,
- set Wi-Fi only if the station has no cable.

Boot the Pi and log in: `ssh <user>@stage-left.local`.

### 2. Install the package

Download `kesher-node-raspberrypi-arm64.deb` from the
[GitHub releases](https://github.com/KesherCom/kesher/releases) (or build it,
see [Building](#building-from-source)), copy it to the Pi and install it:

```sh
scp kesher-node-raspberrypi-arm64.deb <user>@stage-left.local:
ssh <user>@stage-left.local
sudo apt install ./kesher-node-raspberrypi-arm64.deb
```

The station starts right away and from then on with every boot.

### 3. Plug in the headset

Any USB headset or USB audio interface. By default the station uses the
sound card with "USB" in its name; check with:

```sh
kesher-node devices
```

### 4. Approve the station

In the admin area, **Stations (Raspberry Pi)** shows the new station
(highlighted, "1 new"). Choose:

- the **name** in the user list (suggested: the hostname),
- the **role** (its party lines), one role per station because a role can
  only be logged in once,
- the **talk mode**: push to talk (button) or always on.

Click **Approve**. The station connects within a few seconds and appears in
the user list. Name, role and mode can be changed there at any time; the
station picks up changes immediately.

What happens behind it: the station finds the server on the network (mDNS),
creates its own ID and secret on first start, and logs in with them once
approved. A self-signed server certificate is remembered on first contact
and checked from then on. Details in
[decision 0005](../decisions/0005-zero-config-stations.md).

Check it on the Pi at any time:

```sh
sudo kesher-node check          # server found? which sound card?
journalctl -u kesher-node -f    # live log
```

### 5. Mic level

USB headsets start with their own default levels. Set them once with
`alsamixer` (F6 selects the card, F4 shows capture) and store them:

```sh
alsamixer
sudo alsactl store
```

Fine-tune with `input_gain_db` in `/etc/kesher/node.toml`.

### Optional: settings on the Pi

`/etc/kesher/node.toml` explains every option. Typical reasons to edit it
(then `sudo systemctl restart kesher-node`):

| Situation | Setting |
| --- | --- |
| Server in another network (discovery only works within one) | `server = "https://<ip>:8443"` |
| Sound card without "USB" in its name | `[audio] input = ...` / `output = ...` (part of the name from `kesher-node devices`) |
| Talk button / LED | `[gpio]`, see below |
| No approval step: log in with a fixed role | `role = "stage"` (then `name` and `mode` are set in the file too) |

## Talk button and LED

Optional, on the 40-pin header. The config uses **GPIO numbers**, not pin
numbers:

| Part | Connect | Config |
| --- | --- | --- |
| Talk button | GPIO17 (pin 11) and GND (pin 9) | `[gpio] talk_button = 17` |
| LED | GPIO27 (pin 13) -> 330 ohm resistor -> LED -> GND (pin 14) | `[gpio] talk_led = 27` |

No external pull-up is needed; the node enables the internal one.

| Mode | Button | LED |
| --- | --- | --- |
| push to talk | hold to talk | on while talking |
| always on | press to mute / unmute | on while the mic is open |

| LED pattern | Meaning |
| --- | --- |
| slow blink | no connection to the server |
| double blink | waiting for approval in the admin area |
| off / on | connected, silent / talking |

In always-on mode the node only sends while someone speaks (silence
suppression, as in the desktop app).

## What the node does by itself

- **Finds the server** on the network, and looks again if the server's
  address changes.
- **Reconnects** after network loss, server restarts or a missing USB
  headset (it restarts the audio when the device comes back).
- **Keeps its identity and session** across restarts
  (`/var/lib/kesher-node`), and logs out on a clean shutdown, so a reboot
  does not leave the role "in use".
- **Real-time audio**: the audio threads run with real-time priority
  (`SCHED_FIFO`); the service sets the CPU governor to `performance` and
  turns Wi-Fi power saving off (`/usr/lib/kesher-node/tune.sh`; disable with
  `KESHER_TUNE=0` in `/etc/default/kesher-node`).
- Logs a one-line audio summary every minute (packets, losses, jitter
  buffer) to the journal.

## Updating and removing

```sh
sudo apt install ./kesher-node-raspberrypi-arm64.deb    # newer file; keeps settings and approval
dpkg -s kesher-node | grep Version                       # installed version
sudo apt remove kesher-node                              # keeps the config
sudo apt purge kesher-node                               # removes everything (needs a new approval)
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `no Kesher server found on the network` | Server and Pi are in different networks, or the server's firewall blocks UDP 5353: set `server = "https://<ip>:8443"` in the config. |
| `waiting for approval` | Approve the station in the admin area -> Stations. |
| `this station was rejected` | Approve it in the admin area (Stations -> Approve…). |
| `the certificate of ... changed` | The server got a new certificate (e.g. `kesher new-certificate`): remove its line from `/var/lib/kesher-node/server-certs.json` and restart. |
| `the role assigned to this station is in use` | Someone else is logged in with that role: give the station its own role in the admin area. |
| `no input device matches "USB"` | The headset is not plugged in or has another name: run `kesher-node devices` and set part of the name in the config. |
| `config error: ...` | Fix the named line in `/etc/kesher/node.toml`; the service waits until then. |
| Connected, but nobody hears the node | Mic level (`alsamixer`), push to talk without a button, or the role has no talk party line (the log says so). |
| The node hears nothing | The role has no listen party line, or UDP port 8081 is blocked between node and server. |
| Clicks or dropouts | Check the minute summary in the journal (`lost/concealed`, `underruns`). On a Pi 3 try another USB port; prefer cable over Wi-Fi. |
| `could not enable real-time scheduling` | Running by hand instead of as the service; harmless for tests. |

## Measurements

Mouth-to-ear latency and engine load per board, measured with
`kesher_audio_bench` (see [testlab/README.md](../../testlab/README.md)). To be
filled in as boards are tested.

| Board | Network | Mouth-to-ear (p50 / p95) | Notes |
| --- | --- | --- | --- |
| Pi 5 | Ethernet | – | |
| Pi 4 | Ethernet | – | |
| Pi 3 B+ | Ethernet | – | |

## Building from source

The package is built in a Debian bookworm container (cross-compiled for
arm64), the same way locally and in CI:

```sh
make node-deb                  # dist/node/kesher-node-raspberrypi-arm64.deb
make node-deb NODE_ARCH=amd64  # x86 Linux
make node-test                 # unit tests on the host
```

Releases (tags `v*`) attach the `.deb` and `.tar.gz` for arm64 and amd64 to
the GitHub release, versioned like the server and the desktop app.
