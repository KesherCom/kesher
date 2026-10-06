# 0003: Silence suppression only for always-on mics, one-frame pre-roll

Date: 2026-10-06 · Status: accepted

## Context

An always-on mic sends 200 packets per second even when nobody speaks.
With 50 users on one server, idle open mics are wasted relay work and
network load, and they carry room noise to every listener.

## Decision

The audio engine (`crates/kesher-audio`, `Capture::flush_frame`) withholds
frames that contain no speech, **only in always-on mode**:

- energy detector with an adaptive noise floor (speech: 10 dB above the
  floor, or louder than -30 dBFS),
- 400 ms hangover so word endings and short pauses are kept,
- **one 5 ms frame of pre-roll** sent before the first speech frame,
- the encoder keeps running and sequence numbers stay contiguous, so the
  listener sees a new talk spurt, not packet loss.

With PTT held, every frame is sent: pressing the button already says
"I am talking", and no word onset may be cut.

## Why

- Measured with the speech bench (LAN): MOS 4.26 to 4.28 with suppression
  vs. 4.30 without, and 24 % fewer packets on a dense speech clip; idle
  open mics send almost nothing.
- **Pre-roll length matters.** A 20 ms pre-roll was tried first: the
  listener starts playing at the first packet, so the extra frames became
  up to 16 ms of added latency per talk spurt and lowered MOS to 4.08. One
  frame keeps the onset and costs at most one frame of delay.

## Revisit when

- users report cut-off word onsets with quiet talkers or loud rooms
  (then: per-station switch, or tune the thresholds), or
- browsers should save bandwidth too (Opus DTX on the WebRTC path; not
  enabled today).
