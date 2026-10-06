//! Kesher's low-latency audio engine: capture -> Opus -> KSHR/UDP and back,
//! with per-source jitter buffers and mixing. Used by the desktop app
//! (`desktop/src-tauri`) and the headless Raspberry Pi node
//! (`crates/kesher-node`). See `native.rs` for the design.

pub mod native;
#[cfg(target_os = "linux")]
mod realtime_linux;
#[cfg(target_os = "windows")]
pub mod wasapi;
