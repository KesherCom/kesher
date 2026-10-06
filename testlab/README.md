# kesher test lab

The lab tests everything on **one PC** with **one command**:

```sh
make lab
```

That command does the following:

1. Builds the server, web UI and the desktop audio benchmark.
2. Starts four kesher servers, each behind a different emulated network.
3. Measures **latency and audio quality of the desktop app's native audio
   engine** on every network, and compares the result with your baseline.
4. Runs the **browser matrix**: Chromium, Firefox and WebKit, each against
   every network.
5. Stops everything and prints `PASS`/`FAIL` for each part.

```
                 ┌──────── kesher servers (local processes) ─────────┐
 desktop engine ─┤ lan    :8180   no emulation                       │
 (talker+listener)│ wifi   :8181   15 ms ±6 ms, 0.5 % loss            │
 Chromium ───────┤ wan    :8182   60 ms ±15 ms, 1 % loss, 0.5 % reord. │
 Firefox ────────┤ worst  :8183   150 ms ±40 ms, 5 % loss, 2 % reord.  │
 WebKit ─────────┘                                                    │
                 └────────────────────────────────────────────────────┘
```

The network emulation runs inside the server
(`backend/internal/app/emu_net.go`). It covers HTTP, WebSocket, WebRTC and the
native UDP relay of the desktop app, in both directions. The values are **per
client link and direction**. A talker→listener path therefore crosses the
profile twice: on `wan`, the network part alone is about 2 × (60…75) ms.

By default the servers run as normal processes, without Docker. Docker
Desktop's UDP forwarding on Windows and macOS would add latency and jitter of
its own and distort the measurements. `LAB_RUNTIME=docker make lab-up` uses
the containers instead (`deploy/compose/docker-compose.lab.yml`).

## Requirements

- Go 1.25+, Node.js 22+, Rust (the toolchain for `desktop/src-tauri`)
- On the first run, Playwright and its browsers are installed into
  `testlab/node_modules` (about 300 MB, one time only).
- Docker is **not** required.
- Optional, for the speech-quality column (`MOS`): Python 3 with numpy, scipy
  and `pesq` (`pip install numpy scipy pesq`). Without it the column stays
  empty and the run prints why.

## Desktop app: latency and audio quality (`make lab-desktop`)

```sh
make lab-desktop                      # all networks, 5 ms frames, 20 s each
make lab-desktop-baseline             # same, and save the result as the reference
LAB_FRAME_MS=2.5,5,10 make lab-desktop    # compare Opus frame sizes
LAB_PROFILES=lan,wan LAB_DESKTOP_SECONDS=60 make lab-desktop
node testlab/lab.mjs desktop --strict     # exit code 1 on a regression vs the baseline
```

### What is measured

The benchmark `kesher_audio_bench` (`desktop/src-tauri/src/bin/`) runs the
**app's real audio engine** (`audio_native.rs`): framing, Opus, UDP protocol,
jitter buffer, FEC/PLC and mixer. It runs two engines in the same process, a
talker and a listener, both logged in to the server like the app. Instead of
sound cards they use a virtual audio device: a clocked thread that calls the
same capture and playback callbacks the sound card driver would call. Because
both engines share one clock, the measurement is sample-accurate.

The talker sends a continuous 440 Hz test tone. Every 600 ms it inserts a
short marker burst. The listener times the markers and analyses the tone in
5 ms windows.

```
scenario     p50       p95       max       Δp50  Δp95  jbuf   distort Δdist SNR   dropout PLC/min fec  late heard
lan 5ms      12.89ms   12.89ms   12.89ms               7.4ms  0%            30dB  0%      0       0    0    17/17
wan 5ms      165.73ms  165.73ms  165.73ms              12.4ms 0.9%          31dB  0%      12      57   14   16/17
worst 2.5ms  390.24ms  390.24ms  391.7ms               7.5ms  15.2%         27dB  0%      466     539  159  16/17
```

| Column | Meaning |
| --- | --- |
| `p50` / `p95` / `max` | One-way latency from talker to listener: one device period on each side, framing, Opus, network, relay, jitter buffer, decode. **Not included:** the buffers of real sound cards and drivers (see hardware mode). |
| `Δp50` / `Δp95` / `Δdist` | Change compared with the baseline (`make lab-desktop-baseline`). This is the number to watch while you optimize. |
| `jbuf` | Average jitter-buffer target. |
| `distort` | Share of 5 ms windows where the received tone is audibly damaged (SNR < 20 dB): PLC artifacts, clicks, gaps. |
| `SNR` | Median tone SNR (a codec-quality indicator). |
| `dropout` | Windows that were completely silent. |
| `PLC/min` | Packet-loss concealment events in the engine, per minute. |
| `fec` | Packets rebuilt from Opus in-band FEC. |
| `late` | Packets that arrived too late for the jitter buffer. |
| `heard` | Markers received / markers sent. A missing marker means its packet was lost and concealed. |
| `MOS` / `MOSmin` | Speech quality: a voice clip (`assets/speech.wav`) goes through the same path, and wideband PESQ (ITU-T P.862.2) rates what the listener heard against what was sent. 1.0 = bad, 4.64 = perfect; mean and worst 8 s segment. Opus at 48 kbit/s over a clean LAN scores about 4.2–4.3. Unlike the test tone, this reacts to how loss and concealment sound on speech. |

Each run is saved to `testlab/results/desktop-<time>.json`, including the git
revision and the full engine counters. `desktop-baseline.json` is the
reference for the Δ columns. With `--strict`, the run fails when p95 gets
worse than the baseline by more than `LAB_DESKTOP_TOLERANCE_MS` (default 3) or
distortion by more than `LAB_DESKTOP_TOLERANCE_DISTORTION` (default 1 point)
or speech MOS drops by more than `LAB_DESKTOP_TOLERANCE_MOS` (default 0.2).

The speech recordings of every run stay in
`testlab/results/speech/<run>-<profile>-<frame>/` (`reference.wav` = sent,
`degraded.wav` = heard, delayed by the latency) — listen to them when a
number looks odd. The clip itself is synthetic speech from the offline
Windows voices (German and English intercom calls), regenerated with
`powershell -File testlab/assets/make-speech.ps1`; replace it with real
recordings (48 kHz, 16-bit, mono) for a more realistic score.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAB_PROFILES` | `lan,wifi,wan,worst` | networks to measure |
| `LAB_FRAME_MS` | `5` | Opus frame sizes (`2.5`, `5`, `10`) |
| `LAB_DESKTOP_SECONDS` | `20` | measurement time per scenario |
| `LAB_DESKTOP_PERIOD` | `128` | virtual device period in samples (128 = 2.67 ms) |
| `LAB_<PROFILE>_<KEY>` | see table below | override network values, e.g. `LAB_WAN_LATENCY_MS=30` |
| `LAB_VERBOSE` | unset | show the benchmark's engine log |
| `LAB_SPEECH` | on | `0` skips the speech-quality pass |
| `LAB_SPEECH_SECONDS` | `24` | length of the speech pass per scenario |
| `LAB_PYTHON` | `python` / `python3` | interpreter for `lib/pesq_score.py` |

### Real mouth-to-ear latency with your sound card (`make lab-desktop-hw`)

The hardware mode adds the device and driver latency that the virtual device
leaves out. It uses the click test that is built into the app:

1. The engine plays a click.
2. The relay echoes it back to the same client.
3. The click must reach the microphone input, through a cable from the
   headphone output to line-in, or through a speaker next to the mic.

The result is the real mouth-to-ear time, including WASAPI exclusive/shared
mode or Core Audio buffers. The table also shows which audio backend and
period were opened.

```sh
make lab-desktop-hw
LAB_HW_INPUT="Line In (Realtek)" LAB_HW_OUTPUT="Speakers (Realtek)" make lab-desktop-hw
LAB_HW_BACKEND=exclusive make lab-desktop-hw     # or: shared, system
LAB_HW_RUNS=30 LAB_PROFILES=lan make lab-desktop-hw
```

### Testing the desktop app by hand

To use the real Tauri app against the lab:

1. Run `make lab-up`.
2. In the app, set the server URL to `http://127.0.0.1:8182`, or the port of
   another profile.
3. Run the app's own latency test.

## Browsers (`make lab-test`, `make lab-open`)

```sh
make lab-up       # start the servers (with web UI) and keep them running
make lab-test     # Playwright: chromium/firefox/webkit × all networks + audio table
make lab-open     # logged-in browser windows for manual testing
make lab-down
```

| Test | Checks |
| --- | --- |
| `smoke` | `/api/healthz` responds, the login page renders, the real login works, the WebSocket connects, and the WebRTC peer reaches `connected` |
| `audio` › same browser | user A holds **Hold to talk** on FOH and user B listens: audio arrives and is not silent, loss and concealment stay within the profile limits, and B hears silence after A releases |
| `audio` › across engines | the same check between engines (Chromium ↔ Firefox) |

The browsers use a fake microphone: a 440 Hz tone. At the end you get a table
of packet loss, concealment, jitter buffer and RTT, also saved to
`testlab/results/audio-*.json`.

```sh
LAB_BROWSERS=chromium,firefox LAB_PROFILES=lan,wan make lab-test
LAB_BROWSERS=chrome,msedge make lab-test                  # your installed Chrome / Edge
node testlab/lab.mjs test -- -g "across browser" --headed # extra args go to Playwright
make lab-open LAB_OPEN_ARGS="--browsers chromium,firefox,msedge --profile wan --real-mic"
npm --prefix testlab run report                           # HTML report incl. traces
```

> **WebKit on Windows/Linux:** Playwright's WebKit build has neither WebRTC
> nor `getUserMedia` there, so only the UI smoke test runs for WebKit. For real
> Safari, use an iPhone or iPad on the LAN.

## Networks, ports, overrides

| Profile | HTTP | WebRTC UDP | Native UDP | Emulation per link and direction |
| --- | --- | --- | --- | --- |
| `lan` | 8180 | 18180 | 18280 | none |
| `wifi` | 8181 | 18181 | 18281 | 15 ms, ±6 ms jitter, 0.5 % loss |
| `wan` | 8182 | 18182 | 18282 | 60 ms, ±15 ms, 1 % loss, 0.5 % reorder |
| `worst` | 8183 | 18183 | 18283 | 150 ms, ±40 ms, 5 % loss, 2 % reorder, 0.5 % duplicates |

Override any value with `LAB_<PROFILE>_{LATENCY_MS,JITTER_MS,LOSS_PCT,REORDER_PCT,DUPLICATE_PCT}`.

How the emulation behaves:

- Jitter keeps packets in order, like queueing on a real link.
- Only "reordered" packets overtake or get overtaken.
- Server logs are written to `testlab/results/logs/`.

**Other devices** (phones, a second PC) can join the servers started by
`make lab-up` at `http://<pc-ip>:818x`. The PC's LAN IP is detected and
advertised; override it with `LAB_PUBLIC_IP`. Browsers on other devices only
allow the microphone over HTTPS, so there they can only listen.

## Headless probes (NetLab)

`make nettest` is the older, Docker-based lab with Go probes. The desktop
benchmark above replaces it for the desktop app, because it measures the real
Rust engine instead of a reimplementation of the protocol.
