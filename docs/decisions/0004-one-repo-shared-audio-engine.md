# 0004: One repository; desktop app and Pi node share one audio engine

Date: 2026-10-06 · Status: accepted

## Context

With the Raspberry Pi node, Kesher has a second native client next to the
Tauri desktop app. Both need the same low-latency audio path (capture,
Opus, KSHR/UDP, jitter buffer, mixing).

## Decision

- Everything stays in this repository.
- The audio engine is its own crate, **`crates/kesher-audio`**, with no
  Tauri dependency. The desktop app (`desktop/src-tauri`) and the node
  (`crates/kesher-node`) both depend on it.
- One **Cargo workspace** at the repository root with one committed
  `Cargo.lock`; build output goes to `./target`.
- One version number: a release tag `vX.Y.Z` builds server, desktop app and
  node packages together (`.github/workflows/release-binaries.yml`).

## Why

- Engine fixes (latency, jitter buffer, silence suppression) reach both
  clients at once; with two repositories every change would have to be
  ported and released twice.
- The bench (`kesher_audio_bench`) lives with the engine and runs on Linux
  too, so the same measurements work on a Pi.
- A shared lock file keeps both clients on the same library versions.

## Consequences

- Build paths moved from `desktop/src-tauri/target` to `target/` (Makefile,
  test lab and CI were updated).
- Platform-specific code in the engine is gated by `cfg`: WASAPI on Windows
  (`wasapi.rs`), real-time threads on Linux (`realtime_linux.rs`).
