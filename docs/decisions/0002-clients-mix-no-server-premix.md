# 0002: Clients mix; the server only forwards audio

Date: 2026-10-06 · Status: accepted

## Context

The UDP relay (`backend/internal/app/udp_audio.go`) forwards every
talker's Opus packets unchanged; each client decodes and mixes the talkers
it hears. The alternative is a server-side mix-minus: decode everyone, mix
per listener, encode one stream per listener. That was considered for
hardware stations.

## Decision

Keep forwarding. Desktop apps and Linux nodes (Raspberry Pi 3/4/5) mix
themselves. A server-side mix is only built if microcontroller stations
(e.g. ESP32) arrive, and then only for those stations.

## Why

- **Latency.** A server mix needs a jitter buffer per talker on the server
  and a second encode: about +5 to 8 ms, a large part of the <20 ms budget.
- **No need.** Even a Pi 3 decodes and mixes the few simultaneous talkers of
  an intercom easily; the engine already has per-source jitter buffers,
  FEC/PLC, mixing and a limiter.
- **Server simplicity.** Encoding on the server needs libopus via CGO and a
  stall-free 5 ms mixing clock per listener; today the server is pure Go
  and nearly free per packet.

## Revisit when

- stations that cannot decode several Opus streams (microcontrollers) are
  added. Then: pass single talkers through unchanged and mix only while two
  or more talk; share one encode between listeners with identical mixes.
- Wi-Fi airtime becomes the bottleneck with many wireless stations (one
  mixed stream per station is fewer packets than one per talker).
