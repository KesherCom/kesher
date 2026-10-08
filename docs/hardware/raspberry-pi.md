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

### 1. Prepare the SD card

In **Raspberry Pi Imager** choose *Raspberry Pi OS Lite (64-bit)* and, under
*Edit settings*:

- set a **hostname** per station, e.g. `stage-left` (it becomes the name in
  the user list unless the config sets one),
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

This installs the program, the `kesher-node` service (enabled, started once
the config has been edited) and the config `/etc/kesher/node.toml`.

### 3. Create a role on the server

In the admin area create **one role per node** (a role can only be logged in
once) and give it its party lines. Note the role ID.

The server needs its native UDP relay (on by default, UDP port 8081); with
Docker, publish that port and set `KESHER_PUBLIC_IP` (see the main README).

### 4. Configure

Plug in the headset and check that it is recognised:

```sh
kesher-node devices
```

Edit the config (every option is explained in the file):

```sh
sudo nano /etc/kesher/node.toml
```

At minimum set `server`, `role` and, under `[audio]`, part of the headset's
name (`"USB"` usually works). Then check and start:

```sh
sudo kesher-node check
sudo systemctl restart kesher-node
journalctl -u kesher-node -f
```

A working node logs `logged in`, `connected`, `audio running: ...` and its
party lines, and appears in the user list on the server.

### 5. Mic level

USB headsets start with their own default levels. Set them once with
`alsamixer` (F6 selects the card, F4 shows capture) and store them:

```sh
alsamixer
sudo alsactl store
```

Fine-tune with `input_gain_db` in the config.

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
| `ptt` | hold to talk | on while talking |
| `always_on` | press to mute / unmute | on while the mic is open |

The LED blinks slowly while the node is not connected. In `always_on` mode
the node only sends while someone speaks (silence suppression, as in the
desktop app).

## What the node does by itself

- **Reconnects** after network loss, server restarts or a missing USB
  headset (it restarts the audio when the device comes back).
- **Keeps its session** across restarts (`/var/lib/kesher-node`), and logs
  out on a clean shutdown, so a reboot does not leave the role "in use".
- **Real-time audio**: the audio threads run with real-time priority
  (`SCHED_FIFO`); the service sets the CPU governor to `performance` and
  turns Wi-Fi power saving off (`/usr/lib/kesher-node/tune.sh`; disable with
  `KESHER_TUNE=0` in `/etc/default/kesher-node`).
- Logs a one-line audio summary every minute (packets, losses, jitter
  buffer) to the journal.

## Updating and removing

```sh
sudo apt install ./kesher-node-raspberrypi-arm64.deb    # newer file; keeps node.toml
dpkg -s kesher-node | grep Version                       # installed version
sudo apt remove kesher-node                              # keeps the config
sudo apt purge kesher-node                               # removes everything
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `role "x" is in use by "y"` | Another client is logged in with this role. Give the node its own role, or set `takeover = true` if the role belongs to this node only. |
| `no input device matches "USB"` | The headset is not plugged in or has another name: run `kesher-node devices` and use part of the name shown there. |
| `config error: ...` | Fix the named line in `/etc/kesher/node.toml`; the service waits until then. |
| Connected, but nobody hears the node | Mic level (`alsamixer`), mode `ptt` without a button, or the role has no talk party line (the log says so). |
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
