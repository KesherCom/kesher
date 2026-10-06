//! Native low-latency audio engine for the Kesher Performance Mode.
//!
//! This module is the desktop counterpart to the Go `UDPAudioRelay`
//! (see `backend/internal/app/udp_audio.go`). Browser clients keep using
//! WebRTC; the desktop app uses this engine whenever the server offers it.
//!
//! Latency budget (mouth to ear, wired LAN) and where each part lives:
//!
//!   capture device buffer   driver (BufferSize::Fixed(128) requested)
//!   framing                 one Opus frame (2.5 / 5 ms) accumulated here
//!   Opus algorithmic delay  2.5 ms (Application::LowDelay, CELT only)
//!   network + relay         < 1 ms on wired LAN
//!   jitter buffer           adaptive, starts at one frame per source
//!   output device buffer    driver (BufferSize::Fixed(128) requested)
//!
//! To keep the software part of that budget near zero, there are no thread
//! hops on the audio path:
//!
//!   Capture:  CPAL input callback -> accumulate one frame -> Opus encode ->
//!             UDP send, all inside the callback.
//!   Playback: UDP receive thread -> bounded queue -> CPAL output callback,
//!             which owns one jitter buffer + Opus decoder per source,
//!             decodes on demand (with FEC/PLC on loss) and mixes.
//!
//! The callbacks never allocate or take locks: all buffers, decoders and
//! queues are created before the streams start.
//!
//! Wire format: KSHR v2 (20-byte header carrying the source ID plus the
//! source's own sequence/timestamp), falling back to v1 for older servers.
//!
//! Device access: on Windows the engine prefers WASAPI exclusive mode, then
//! WASAPI low-latency shared mode (IAudioClient3), then cpal (WASAPI shared
//! with the engine's default period); see `audio_wasapi.rs`. macOS uses cpal
//! (Core Audio). The stats log shows the callback sizes actually delivered.

#![allow(clippy::too_many_arguments)]

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus::{Application, Channels, Decoder, Encoder};
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ── Constants ────────────────────────────────────────────────────────────

/// 48 kHz mono — matches the relay/codec contract.
pub const NATIVE_SAMPLE_RATE: u32 = 48_000;
const SAMPLES_PER_MS: f32 = 48.0;
/// Default frame: 5 ms @ 48 kHz. 2.5 ms (120) and 10 ms (480) are allowed.
const DEFAULT_FRAME_SAMPLES: usize = 240;
const ALLOWED_FRAME_SAMPLES: [usize; 3] = [120, 240, 480];
/// Hardware-buffer wish size; the driver may round up or reject it.
pub const NATIVE_HW_BUFFER_SAMPLES: u32 = 128;
/// Default Opus bitrate for the performance profile.
pub const NATIVE_OPUS_BITRATE: i32 = 48_000;

/// UDP wire-format constants — mirror the Go side `udp_audio.go`.
const UDP_MAGIC: &[u8; 4] = b"KSHR";
const UDP_VERSION_1: u8 = 0x01;
const UDP_VERSION_2: u8 = 0x02;
const UDP_HEADER_LEN_V1: usize = 16;
const UDP_HEADER_LEN_V2: usize = 20;
const UDP_FLAG_AUDIO: u8 = 1 << 0;
const UDP_FLAG_REGISTER: u8 = 1 << 1;
const UDP_FLAG_HEARTBEAT: u8 = 1 << 2;
const UDP_FLAG_LOOPBACK: u8 = 1 << 3;
/// Largest Opus payload we send or accept (relay limit).
const MAX_OPUS_PACKET: usize = 1200;
/// Opus never decodes more than 120 ms per packet.
const MAX_DECODED_SAMPLES: usize = 5760;

/// Jitter buffer / mixer sizing.
const MAX_SOURCES: usize = 32;
const JITTER_SLOTS: usize = 64;
const PCM_CAPACITY: usize = MAX_DECODED_SAMPLES * 2;
const MIX_CHUNK: usize = 4096;
const RX_QUEUE_DEPTH: usize = 256;
/// Consecutive output callbacks we may conceal an underrun before treating
/// the source as silent (end of talk spurt).
const MAX_EXPAND_RUN: u32 = 4;
/// Window over which the jitter buffer must stay above target + one frame
/// before the persistent excess is dropped (bursts after a stall, clock
/// drift). Short, because the excess is real delay every listener hears.
const LATENCY_WINDOW_SAMPLES: u64 = 12_000;
/// Time without a jitter underrun before the target shrinks by 0.5 ms.
const TARGET_DECAY_SAMPLES: u64 = 3 * 48_000;
const TARGET_DECAY_STEP: usize = 24;
/// Smallest target increase after a jitter underrun (1 ms).
const TARGET_MIN_STEP: usize = 48;
/// Lowest jitter-buffer target (2 ms). On a wired LAN the only jitter is
/// device-period quantization, so the target may sit below one frame.
const TARGET_FLOOR_SAMPLES: usize = 96;
/// Excess over the target tolerated for a whole window before trimming.
const TRIM_MARGIN_SAMPLES: usize = 48;
/// Crossfade length when cutting decoded audio (about 0.7 ms).
const TRIM_CROSSFADE: usize = 32;
/// At most this many packets are decoded in one callback to trim smoothly;
/// a larger backlog is skipped undecoded.
const TRIM_MAX_DECODES: usize = 8;
const MAX_TARGET_SAMPLES: usize = 4_800;
/// Free a source slot after this long without packets.
const SOURCE_RELEASE_IDLE_SAMPLES: u64 = 5 * 48_000;

/// Silence suppression (always-on mics): how long to keep sending after the
/// last speech frame, so word endings and short pauses are not cut.
const VAD_HANGOVER_MS: u32 = 400;
/// Audio sent ahead of a detected onset (already encoded), so a soft first
/// consonant is not clipped. Kept to one 5 ms frame: the pre-roll leaves as
/// a burst and the listener starts playing on its first packet, so every
/// pre-roll frame adds its length to that talk spurt's latency (20 ms of
/// pre-roll measured as +16 ms in the lab).
const VAD_PREROLL_MS: u32 = 5;
/// A frame counts as speech this far above the tracked noise floor...
const VAD_SNR_DB: f32 = 10.0;
/// ...and above this absolute level; anything louder than VAD_LOUD_DB is
/// always speech.
const VAD_MIN_DB: f32 = -60.0;
const VAD_LOUD_DB: f32 = -30.0;
/// The noise floor follows quiet frames quickly and loud ones only slowly.
const VAD_FLOOR_RISE_DB_PER_S: f32 = 1.0;
/// Encoded frames kept for the pre-roll (covers 20 ms at 2.5 ms frames).
const ENCODED_RING: usize = 9;

/// UDP socket buffer size. A listener on a busy party line receives
/// (talkers - 1) x 200 packets/s, and a server hiccup arrives as one burst;
/// a larger buffer keeps such a burst instead of dropping it. (Safety
/// margin: with 8 talkers on an otherwise idle lab machine the 64 KiB OS
/// default did not lose packets either.)
const SOCKET_BUFFER_BYTES: usize = 1 << 20;

const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(1000);
/// Re-send REGISTER every N heartbeats so a lost REGISTER or a relay restart
/// heals itself.
const REGISTER_EVERY_HEARTBEATS: u32 = 5;
/// Also the level-meter cadence: the receive thread wakes at least this often.
const RECV_TIMEOUT: Duration = Duration::from_millis(50);
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(50);
/// Per-source output gains are kept in a fixed lock-free table.
const MAX_GAIN_ENTRIES: usize = 64;
const MAX_OUTPUT_GAIN: f32 = 2.0;
const MAX_INPUT_GAIN: f32 = 16.0;
const MIN_GATE_THRESHOLD_DB: f32 = -72.0;
const MAX_GATE_THRESHOLD_DB: f32 = -12.0;
const GATE_ATTACK_MS: f32 = 10.0;
const GATE_RELEASE_MS: f32 = 150.0;
const STATS_LOG_INTERVAL: Duration = Duration::from_secs(5);
const STREAM_INIT_TIMEOUT: Duration = Duration::from_secs(3);

/// Latency test: prime the loopback path for 200 ms, then send one click and
/// wait up to 1 s for it to come back through output -> input.
const LATENCY_TEST_PRIME_SAMPLES: usize = 9_600;
const LATENCY_TEST_TIMEOUT_SAMPLES: u64 = 48_000;
const LATENCY_TEST_THRESHOLD: f32 = 0.15;
const LATENCY_CLICK_HALF: usize = 24;

const TEST_IDLE: u8 = 0;
const TEST_ARMED: u8 = 1;
const TEST_RUNNING: u8 = 2;
const TEST_DONE: u8 = 3;
const TEST_FAILED: u8 = 4;

// ── Public IPC types ─────────────────────────────────────────────────────

/// Parameters required to start the native engine. Sent by the WebView once
/// it received `native_audio_endpoint` over the WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartNativeParams {
    pub server_host: String,
    pub server_port: u16,
    pub session_token: String,
    pub token_hash: u32,
    /// Optional CPAL input device name; default if None or not found.
    pub input_device_id: Option<String>,
    /// Optional CPAL output device name; default if None or not found.
    pub output_device_id: Option<String>,
    /// KSHR protocol version announced by the server (1 if absent).
    #[serde(default)]
    pub protocol_version: Option<u8>,
    /// Opus frame duration announced by the server (2.5, 5 or 10 ms).
    #[serde(default)]
    pub frame_duration_ms: Option<f32>,
    /// Device access: "auto" (default), "exclusive", "shared" (low-latency
    /// shared) or "system" (cpal). Windows only; other platforms use cpal.
    #[serde(default)]
    pub audio_backend: Option<String>,
}

/// What the engine actually opened, reported back to the WebView.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartInfo {
    pub input: StreamReport,
    pub output: StreamReport,
    pub frame_ms: f32,
    pub protocol_version: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamReport {
    pub backend: String,
    pub device: String,
    /// Device period in ms when known (cpal with driver default: None).
    pub period_ms: Option<f32>,
}

/// Level-meter event emitted ~20x per second while the engine runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLevelEvent {
    /// Peak of the outgoing mic signal (after gain and gate), 0..1.
    pub input_peak: f32,
    /// Peak of the mixed output, 0..1.
    pub output_peak: f32,
    /// Per-source peaks (after per-user gain) for sources heard recently.
    pub sources: Vec<SourceLevel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLevel {
    pub source_id: u32,
    pub peak: f32,
}

pub type LevelSink = Box<dyn Fn(NativeLevelEvent) + Send + 'static>;

/// Capabilities reported to the WebView so it can pick the transport.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioInfo {
    pub protocol_version: u8,
}

pub fn info() -> NativeAudioInfo {
    NativeAudioInfo {
        protocol_version: UDP_VERSION_2,
    }
}

/// Tauri-managed runtime state. `settings` outlives engine restarts, so the
/// WebView can push gains before or while the engine runs.
pub struct NativeAudioState {
    pub engine: Mutex<Option<RunningNativeEngine>>,
    settings: Arc<Settings>,
}

impl Default for NativeAudioState {
    fn default() -> Self {
        Self {
            engine: Mutex::new(None),
            settings: Arc::new(Settings::default()),
        }
    }
}

/// A live native engine. Dropping it stops capture, playback and network.
pub struct RunningNativeEngine {
    shared: Arc<Shared>,
}

impl Drop for RunningNativeEngine {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
    }
}

// ── Shared state and stats ───────────────────────────────────────────────

#[derive(Default)]
struct Stats {
    tx_packets: AtomicU64,
    tx_errors: AtomicU64,
    rx_packets: AtomicU64,
    rx_queue_full: AtomicU64,
    capture_callback_frames: AtomicU32,
    output_callback_frames: AtomicU32,
    active_sources: AtomicU32,
    max_target_samples: AtomicU32,
    max_queued_samples: AtomicU32,
    jitter_underruns: AtomicU64,
    concealed: AtomicU64,
    fec_recovered: AtomicU64,
    late_packets: AtomicU64,
    latency_trims: AtomicU64,
    /// Virtual device only: ticks that ran more than one period late.
    virtual_late_ticks: AtomicU64,
    /// Stalls on the wire: gaps between consecutive sent / received audio
    /// packets during continuous audio (diagnostics for latency spikes).
    tx_gaps_over_20ms: AtomicU64,
    rx_gaps_over_20ms: AtomicU64,
    tx_max_gap_us: AtomicU64,
    rx_max_gap_us: AtomicU64,
    /// Longest single socket.send() call in the capture path.
    tx_send_max_us: AtomicU64,
    /// Frames not sent because silence suppression judged them silent.
    vad_suppressed: AtomicU64,
    /// Mix samples that exceeded full scale and were clipped, out of all
    /// mixed samples (several loud talkers at once).
    clipped_samples: AtomicU64,
    mixed_samples: AtomicU64,
    /// Time spent in the output callback (decode + jitter buffers + mix).
    render_calls: AtomicU64,
    render_total_us: AtomicU64,
    render_max_us: AtomicU64,
}

/// Records the gap since `last` into the max/over-20ms counters.
fn record_gap(last: &mut Option<Instant>, now: Instant, max_us: &AtomicU64, over: &AtomicU64) -> Duration {
    let gap = last.map_or(Duration::ZERO, |prev| now.saturating_duration_since(prev));
    *last = Some(now);
    max_us.fetch_max(gap.as_micros() as u64, Ordering::Relaxed);
    if gap > Duration::from_millis(20) {
        over.fetch_add(1, Ordering::Relaxed);
    }
    gap
}

/// User settings read lock-free by the audio callbacks.
struct Settings {
    input_gain_bits: AtomicU32,
    gate_enabled: AtomicBool,
    /// Linear amplitude.
    gate_threshold_bits: AtomicU32,
    /// Silence suppression: skip sending while the mic only picks up noise.
    /// Set by the app for always-on mode (PTT sends everything).
    vad_enabled: AtomicBool,
    /// Bumped on every gain-table update so sources re-resolve their gain.
    gains_generation: AtomicU32,
    gains: [GainEntry; MAX_GAIN_ENTRIES],
}

#[derive(Default)]
struct GainEntry {
    /// 0 = unused slot.
    source_id: AtomicU32,
    gain_bits: AtomicU32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            input_gain_bits: AtomicU32::new(1.0f32.to_bits()),
            gate_enabled: AtomicBool::new(false),
            gate_threshold_bits: AtomicU32::new(db_to_amplitude(-52.0).to_bits()),
            vad_enabled: AtomicBool::new(false),
            gains_generation: AtomicU32::new(0),
            gains: std::array::from_fn(|_| GainEntry::default()),
        }
    }
}

impl Settings {
    fn input_gain(&self) -> f32 {
        f32::from_bits(self.input_gain_bits.load(Ordering::Relaxed))
    }

    fn gate_threshold(&self) -> Option<f32> {
        self.gate_enabled
            .load(Ordering::Relaxed)
            .then(|| f32::from_bits(self.gate_threshold_bits.load(Ordering::Relaxed)))
    }

    /// Gain for a source; 1.0 for sources the WebView has not configured.
    fn output_gain(&self, source_id: u32) -> f32 {
        // 0 marks empty slots (and is what v1 relays send for every source).
        if source_id == 0 {
            return 1.0;
        }
        self.gains
            .iter()
            .find(|e| e.source_id.load(Ordering::Acquire) == source_id)
            .map_or(1.0, |e| f32::from_bits(e.gain_bits.load(Ordering::Relaxed)))
    }

    fn set_output_gains(&self, gains: &[(u32, f32)]) {
        let mut entries = self.gains.iter();
        for (&(id, gain), entry) in gains.iter().filter(|(id, _)| *id != 0).zip(&mut entries) {
            entry.gain_bits.store(gain.clamp(0.0, MAX_OUTPUT_GAIN).to_bits(), Ordering::Relaxed);
            entry.source_id.store(id, Ordering::Release);
        }
        for entry in entries {
            entry.source_id.store(0, Ordering::Release);
        }
        self.gains_generation.fetch_add(1, Ordering::Release);
    }
}

fn db_to_amplitude(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Peaks written by the callbacks (as f32 bits; for non-negative floats the
/// bit pattern orders like the value, so fetch_max works) and drained by the
/// level emitter.
struct Levels {
    input_peak_bits: AtomicU32,
    output_peak_bits: AtomicU32,
    /// Indexed like Playback::sources.
    source_ids: [AtomicU32; MAX_SOURCES],
    source_peak_bits: [AtomicU32; MAX_SOURCES],
}

impl Default for Levels {
    fn default() -> Self {
        Self {
            input_peak_bits: AtomicU32::new(0),
            output_peak_bits: AtomicU32::new(0),
            source_ids: std::array::from_fn(|_| AtomicU32::new(0)),
            source_peak_bits: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }
}

impl Levels {
    fn take_event(&self) -> NativeLevelEvent {
        let take = |a: &AtomicU32| f32::from_bits(a.swap(0, Ordering::Relaxed));
        let mut sources = Vec::new();
        for (id, peak) in self.source_ids.iter().zip(&self.source_peak_bits) {
            let peak = take(peak);
            let id = id.load(Ordering::Relaxed);
            if id != 0 && peak > 0.0 {
                sources.push(SourceLevel { source_id: id, peak });
            }
        }
        NativeLevelEvent {
            input_peak: take(&self.input_peak_bits),
            output_peak: take(&self.output_peak_bits),
            sources,
        }
    }
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    mic_active: AtomicBool,
    test_state: AtomicU8,
    test_result_us: AtomicU64,
    stats: Stats,
    settings: Arc<Settings>,
    levels: Levels,
}

// ── Wire-format helpers ──────────────────────────────────────────────────

fn header_len(version: u8) -> usize {
    if version == UDP_VERSION_2 {
        UDP_HEADER_LEN_V2
    } else {
        UDP_HEADER_LEN_V1
    }
}

/// Writes a client->server header and returns its length. Client packets
/// carry source_id 0; the relay fills in the real one on fan-out.
fn write_header(
    buf: &mut [u8],
    version: u8,
    flags: u8,
    sequence: u16,
    timestamp: u32,
    token_hash: u32,
) -> usize {
    buf[0..4].copy_from_slice(UDP_MAGIC);
    buf[4] = version;
    buf[5] = flags;
    buf[6..8].copy_from_slice(&sequence.to_be_bytes());
    buf[8..12].copy_from_slice(&timestamp.to_be_bytes());
    buf[12..16].copy_from_slice(&token_hash.to_be_bytes());
    if version == UDP_VERSION_2 {
        buf[16..20].copy_from_slice(&0u32.to_be_bytes());
    }
    header_len(version)
}

/// Decoded view of a server-origin packet. Payload aliases the recv buffer.
struct ParsedPacket<'a> {
    flags: u8,
    sequence: u16,
    source_id: u32,
    payload: &'a [u8],
}

fn parse_header(buf: &[u8]) -> Option<ParsedPacket<'_>> {
    if buf.len() < UDP_HEADER_LEN_V1 || &buf[0..4] != UDP_MAGIC {
        return None;
    }
    let version = buf[4];
    if version != UDP_VERSION_1 && version != UDP_VERSION_2 {
        return None;
    }
    let len = header_len(version);
    if buf.len() < len {
        return None;
    }
    let source_id = if version == UDP_VERSION_2 {
        u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]])
    } else {
        0 // v1 relays cannot tell sources apart
    };
    Some(ParsedPacket {
        flags: buf[5],
        sequence: u16::from_be_bytes([buf[6], buf[7]]),
        source_id,
        payload: &buf[len..],
    })
}

/// Signed distance a - b on the 16-bit sequence circle.
fn seq_diff(a: u16, b: u16) -> i32 {
    a.wrapping_sub(b) as i16 as i32
}

fn frame_samples_from_ms(ms: Option<f32>) -> usize {
    let env = std::env::var("KESHER_NATIVE_FRAME_MS")
        .ok()
        .and_then(|v| v.trim().parse::<f32>().ok());
    let wanted = env
        .or(ms)
        .map(|ms| (ms * SAMPLES_PER_MS).round() as usize)
        .unwrap_or(DEFAULT_FRAME_SAMPLES);
    if ALLOWED_FRAME_SAMPLES.contains(&wanted) {
        wanted
    } else {
        log::warn!("[native] unsupported frame size {wanted} samples, using 5 ms");
        DEFAULT_FRAME_SAMPLES
    }
}

fn hw_buffer_samples() -> u32 {
    std::env::var("KESHER_NATIVE_HW_BUFFER")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| (16..=4096).contains(v))
        .unwrap_or(NATIVE_HW_BUFFER_SAMPLES)
}

// ── Devices and streams ──────────────────────────────────────────────────

fn pick_device(host: &cpal::Host, name: Option<&str>, input: bool) -> Result<cpal::Device, String> {
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        let devices = if input {
            host.input_devices()
        } else {
            host.output_devices()
        };
        if let Ok(mut devices) = devices {
            if let Some(device) = devices.find(|d| d.name().ok().as_deref() == Some(name)) {
                return Ok(device);
            }
        }
        // WebView device IDs are not CPAL names on every platform; never fail
        // the engine because of that.
        log::warn!("[native] device {name:?} not found, using system default");
    }
    let device = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    device.ok_or_else(|| {
        format!(
            "no default {} device",
            if input { "input" } else { "output" }
        )
    })
}

/// 48 kHz with the device's native channel count. Requests a small fixed
/// buffer and lets the caller fall back to the driver default.
fn stream_config(device: &cpal::Device, input: bool, fixed: Option<u32>) -> Result<cpal::StreamConfig, String> {
    let default = if input {
        device.default_input_config()
    } else {
        device.default_output_config()
    }
    .map_err(|e| format!("default config: {e}"))?;
    Ok(cpal::StreamConfig {
        channels: default.channels().max(1),
        sample_rate: cpal::SampleRate(NATIVE_SAMPLE_RATE),
        buffer_size: match fixed {
            Some(n) => cpal::BufferSize::Fixed(n),
            None => cpal::BufferSize::Default,
        },
    })
}

/// Runs `build` with a fixed small buffer first and the driver default as
/// fallback, since many drivers reject explicit buffer sizes.
fn build_with_fallback<F>(device: &cpal::Device, input: bool, mut build: F) -> Result<(cpal::Stream, cpal::StreamConfig), String>
where
    F: FnMut(&cpal::StreamConfig) -> Result<cpal::Stream, cpal::BuildStreamError>,
{
    let kind = if input { "input" } else { "output" };
    let fixed = stream_config(device, input, Some(hw_buffer_samples()))?;
    match build(&fixed) {
        Ok(stream) => return Ok((stream, fixed)),
        Err(e) => log::warn!(
            "[native] {kind}: fixed buffer {:?} rejected ({e}), using driver default",
            fixed.buffer_size
        ),
    }
    let default = stream_config(device, input, None)?;
    build(&default)
        .map(|stream| (stream, default))
        .map_err(|e| format!("build {kind} stream: {e}"))
}

/// Spawns a thread that owns a (!Send) CPAL stream until `stop` is set.
/// Returns once the stream is playing or failed to open.
fn spawn_stream_thread<F>(name: &str, shared: Arc<Shared>, open: F) -> Result<(), String>
where
    F: FnOnce() -> Result<cpal::Stream, String> + Send + 'static,
{
    let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let stream = match open().and_then(|s| s.play().map(|_| s).map_err(|e| format!("play: {e}"))) {
                Ok(s) => {
                    let _ = ready_tx.send(Ok(()));
                    s
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            while !shared.stop.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(stream);
        })
        .map_err(|e| format!("spawn {name}: {e}"))?;
    ready_rx
        .recv_timeout(STREAM_INIT_TIMEOUT)
        .map_err(|_| format!("{name}: device did not start in time"))?
}

// ── Capture path ─────────────────────────────────────────────────────────

/// Owned by the input callback: frames, encodes and sends without leaving
/// the audio thread.
struct Capture {
    encoder: Encoder,
    socket: UdpSocket,
    version: u8,
    token_hash: u32,
    frame_samples: usize,
    channels: usize,
    accum: Vec<f32>,
    packet: Vec<u8>,
    sequence: u16,
    timestamp: u32,
    /// Absolute index of the next captured sample.
    position: u64,
    was_sending: bool,
    /// When the previous packet of the current talk spurt was sent.
    last_send: Option<Instant>,
    /// Recently encoded frames (for the silence-suppression pre-roll).
    ring: Vec<EncodedFrame>,
    ring_pos: usize,
    vad: Vad,
    /// Frames left in the hangover after the last speech frame.
    hangover: u32,
    /// True while frames are being withheld as silence.
    suppressing: bool,
    test_frames: usize,
    test_click_at: Option<u64>,
    /// Noise-gate envelope, 0 (closed) .. 1 (open).
    gate_envelope: f32,
    gate_attack: f32,
    gate_release: f32,
    shared: Arc<Shared>,
}

/// One-pole smoothing coefficient for a time constant at 48 kHz.
fn smoothing_coefficient(ms: f32) -> f32 {
    1.0 - (-2.0 * std::f32::consts::PI * (1000.0 / ms) / NATIVE_SAMPLE_RATE as f32).exp()
}

impl Capture {
    fn on_input(&mut self, data: &[f32]) {
        let frames = data.len() / self.channels;
        self.shared
            .stats
            .capture_callback_frames
            .store(frames as u32, Ordering::Relaxed);
        let gain = self.shared.settings.input_gain();
        let gate = self.shared.settings.gate_threshold();
        let mut peak = 0.0f32;
        for frame in data.chunks_exact(self.channels) {
            let raw = frame[0];
            // The latency test listens to the raw input.
            self.detect_click(raw);
            let gated = match gate {
                Some(threshold) => {
                    let open = raw.abs() >= threshold;
                    let coeff = if open { self.gate_attack } else { self.gate_release };
                    let target = if open { 1.0 } else { 0.0 };
                    self.gate_envelope += (target - self.gate_envelope) * coeff;
                    raw * self.gate_envelope
                }
                None => raw,
            };
            let sample = (gated * gain).clamp(-1.0, 1.0);
            peak = peak.max(sample.abs());
            self.accum.push(sample);
            self.position += 1;
            if self.accum.len() == self.frame_samples {
                self.flush_frame();
                self.accum.clear();
            }
        }
        // Metered regardless of PTT so the settings meter shows the mic.
        self.shared
            .levels
            .input_peak_bits
            .fetch_max(peak.to_bits(), Ordering::Relaxed);
    }

    fn detect_click(&mut self, sample: f32) {
        let Some(click_at) = self.test_click_at else {
            return;
        };
        if self.position > click_at && sample.abs() >= LATENCY_TEST_THRESHOLD {
            let samples = self.position - click_at;
            self.shared
                .test_result_us
                .store(samples * 1_000_000 / NATIVE_SAMPLE_RATE as u64, Ordering::Release);
            self.shared.test_state.store(TEST_DONE, Ordering::Release);
            self.test_click_at = None;
        } else if self.position - click_at > LATENCY_TEST_TIMEOUT_SAMPLES {
            self.shared.test_state.store(TEST_FAILED, Ordering::Release);
            self.test_click_at = None;
        }
    }

    fn flush_frame(&mut self) {
        let frame_start = self.position - self.frame_samples as u64;
        let mut flags = UDP_FLAG_AUDIO;
        let (send, testing) = match self.shared.test_state.load(Ordering::Acquire) {
            TEST_ARMED => {
                self.test_frames = 0;
                self.test_click_at = None;
                self.shared.test_state.store(TEST_RUNNING, Ordering::Release);
                flags |= UDP_FLAG_LOOPBACK;
                self.accum.fill(0.0);
                (true, true)
            }
            TEST_RUNNING => {
                // The mic is replaced by silence plus one click so the
                // measurement cannot feed back; frames only echo to us.
                flags |= UDP_FLAG_LOOPBACK;
                self.accum.fill(0.0);
                self.test_frames += self.frame_samples;
                if self.test_click_at.is_none() && self.test_frames >= LATENCY_TEST_PRIME_SAMPLES {
                    let half = LATENCY_CLICK_HALF.min(self.frame_samples / 2);
                    self.accum[..half].fill(0.9);
                    self.accum[half..2 * half].fill(-0.9);
                    self.test_click_at = Some(frame_start);
                }
                (true, true)
            }
            _ => (self.shared.mic_active.load(Ordering::Acquire), false),
        };
        if !send {
            self.was_sending = false;
            self.last_send = None;
            self.timestamp = self.timestamp.wrapping_add(self.frame_samples as u32);
            return;
        }
        if !self.was_sending {
            // New talk spurt: start the encoder from a clean state.
            let _ = self.encoder.reset_state();
            self.was_sending = true;
            for f in &mut self.ring {
                f.pending = false;
            }
            self.vad.reset();
            self.hangover = self.frames_for_ms(VAD_HANGOVER_MS);
            self.suppressing = false;
        }

        // Every frame is encoded (keeps the encoder state continuous and
        // fills the pre-roll); whether it is sent is decided below.
        let slot = self.ring_pos;
        self.ring_pos = (self.ring_pos + 1) % ENCODED_RING;
        let timestamp = self.timestamp;
        self.timestamp = self.timestamp.wrapping_add(self.frame_samples as u32);
        let frame = &mut self.ring[slot];
        match self.encoder.encode_float(&self.accum, &mut frame.data) {
            Ok(n) => {
                frame.len = n;
                frame.timestamp = timestamp;
                frame.pending = true;
            }
            Err(_) => {
                frame.pending = false;
                self.shared.stats.tx_errors.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }

        if testing || !self.shared.settings.vad_enabled.load(Ordering::Relaxed) {
            self.suppressing = false;
            self.send_slot(slot, flags);
            return;
        }
        let frame_ms = self.frame_samples as f32 / SAMPLES_PER_MS;
        if self.vad.is_speech(&self.accum, frame_ms) {
            self.hangover = self.frames_for_ms(VAD_HANGOVER_MS);
        } else {
            self.hangover = self.hangover.saturating_sub(1);
        }
        if self.hangover == 0 {
            // Silence: withhold the frame (it stays in the ring as pre-roll).
            self.suppressing = true;
            self.shared.stats.vad_suppressed.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self.suppressing {
            // Speech onset after silence: send the pre-roll first, oldest
            // first, then this frame. Sequence numbers stay contiguous, so
            // the listener sees a normal new talk spurt, not packet loss.
            let preroll = (self.frames_for_ms(VAD_PREROLL_MS) as usize).min(ENCODED_RING - 1);
            for back in (1..=preroll).rev() {
                let idx = (slot + ENCODED_RING - back) % ENCODED_RING;
                if self.ring[idx].pending {
                    self.send_slot(idx, flags);
                }
            }
            self.suppressing = false;
        }
        self.send_slot(slot, flags);
    }

    fn frames_for_ms(&self, ms: u32) -> u32 {
        (ms as f32 * SAMPLES_PER_MS / self.frame_samples as f32).ceil() as u32
    }

    /// Sends one encoded frame from the ring with the next sequence number.
    fn send_slot(&mut self, slot: usize, flags: u8) {
        let header = header_len(self.version);
        let frame = &mut self.ring[slot];
        frame.pending = false;
        let n = frame.len;
        self.packet[header..header + n].copy_from_slice(&frame.data[..n]);
        write_header(
            &mut self.packet,
            self.version,
            flags,
            self.sequence,
            frame.timestamp,
            self.token_hash,
        );
        let stats = &self.shared.stats;
        let before = Instant::now();
        match self.socket.send(&self.packet[..header + n]) {
            Ok(_) => stats.tx_packets.fetch_add(1, Ordering::Relaxed),
            Err(_) => stats.tx_errors.fetch_add(1, Ordering::Relaxed),
        };
        let after = Instant::now();
        stats
            .tx_send_max_us
            .fetch_max(after.duration_since(before).as_micros() as u64, Ordering::Relaxed);
        record_gap(&mut self.last_send, after, &stats.tx_max_gap_us, &stats.tx_gaps_over_20ms);
        self.sequence = self.sequence.wrapping_add(1);
    }
}

/// One encoded Opus frame waiting in the capture ring.
struct EncodedFrame {
    data: Vec<u8>,
    len: usize,
    timestamp: u32,
    /// Encoded but not sent yet (candidate for the pre-roll).
    pending: bool,
}

/// Energy-based voice activity detection with an adaptive noise floor.
/// Cheap enough for the audio callback; tuned to keep speech (including
/// soft onsets, helped by hangover and pre-roll) and drop steady room noise.
#[derive(Default)]
struct Vad {
    noise_db: Option<f32>,
}

impl Vad {
    fn reset(&mut self) {
        self.noise_db = None;
    }

    fn is_speech(&mut self, frame: &[f32], frame_ms: f32) -> bool {
        let energy = frame.iter().map(|x| x * x).sum::<f32>() / frame.len().max(1) as f32;
        let db = 10.0 * (energy + 1e-12).log10();
        let floor = self.noise_db.get_or_insert(db.min(-50.0));
        if db < *floor {
            *floor += (db - *floor) * 0.3;
        } else {
            *floor += (db - *floor).min(VAD_FLOOR_RISE_DB_PER_S * frame_ms / 1000.0);
        }
        *floor = floor.clamp(-100.0, -30.0);
        db >= VAD_LOUD_DB || (db >= VAD_MIN_DB && db >= *floor + VAD_SNR_DB)
    }
}

fn new_capture(
    socket: &UdpSocket,
    version: u8,
    token_hash: u32,
    frame_samples: usize,
    channels: usize,
    shared: &Arc<Shared>,
) -> Result<Capture, String> {
    let mut encoder = Encoder::new(NATIVE_SAMPLE_RATE, Channels::Mono, Application::LowDelay)
        .map_err(|e| format!("opus encoder: {e}"))?;
    let _ = encoder.set_bitrate(opus::Bitrate::Bits(NATIVE_OPUS_BITRATE));
    let _ = encoder.set_inband_fec(true);
    let _ = encoder.set_packet_loss_perc(5);
    Ok(Capture {
        encoder,
        socket: socket.try_clone().map_err(|e| format!("socket clone: {e}"))?,
        version,
        token_hash,
        frame_samples,
        channels: channels.max(1),
        accum: Vec::with_capacity(frame_samples),
        packet: vec![0u8; UDP_HEADER_LEN_V2 + MAX_OPUS_PACKET],
        sequence: 0,
        timestamp: 0,
        position: 0,
        was_sending: false,
        last_send: None,
        ring: (0..ENCODED_RING)
            .map(|_| EncodedFrame {
                data: vec![0u8; MAX_OPUS_PACKET],
                len: 0,
                timestamp: 0,
                pending: false,
            })
            .collect(),
        ring_pos: 0,
        vad: Vad::default(),
        hangover: 0,
        suppressing: false,
        test_frames: 0,
        test_click_at: None,
        gate_envelope: 0.0,
        gate_attack: smoothing_coefficient(GATE_ATTACK_MS),
        gate_release: smoothing_coefficient(GATE_RELEASE_MS),
        shared: Arc::clone(shared),
    })
}

/// Opens the capture device through cpal (Core Audio on macOS, WASAPI
/// shared on Windows).
fn open_capture_cpal<M>(device_name: Option<String>, make: M) -> Result<(cpal::Stream, StreamReport), String>
where
    M: Fn(usize) -> Result<Capture, String>,
{
    let host = cpal::default_host();
    let device = pick_device(&host, device_name.as_deref(), true)?;
    let name = device.name().unwrap_or_default();
    let mut init_error = None;
    let (stream, config) = build_with_fallback(&device, true, |config| {
        let mut capture = match make(config.channels as usize) {
            Ok(c) => c,
            Err(e) => {
                init_error = Some(e);
                return Err(cpal::BuildStreamError::StreamConfigNotSupported);
            }
        };
        device.build_input_stream(
            config,
            move |data: &[f32], _| capture.on_input(data),
            |err| log::warn!("[native][capture] stream error: {err}"),
            None,
        )
    })
    .map_err(|e| init_error.take().unwrap_or(e))?;
    Ok((stream, cpal_report(name, &config)))
}

fn cpal_report(device: String, config: &cpal::StreamConfig) -> StreamReport {
    StreamReport {
        backend: "system".to_string(),
        device,
        period_ms: match config.buffer_size {
            cpal::BufferSize::Fixed(n) => Some(n as f32 / SAMPLES_PER_MS),
            cpal::BufferSize::Default => None,
        },
    }
}

// ── Playback path ────────────────────────────────────────────────────────

/// One received Opus frame, passed by value so the queue never allocates.
struct RxPacket {
    source_id: u32,
    sequence: u16,
    len: u16,
    data: [u8; MAX_OPUS_PACKET],
}

struct Slot {
    present: bool,
    sequence: u16,
    len: u16,
    data: [u8; MAX_OPUS_PACKET],
}

/// Fixed-capacity FIFO of decoded samples.
struct PcmRing {
    buf: Vec<f32>,
    read: usize,
    len: usize,
}

impl PcmRing {
    fn new(capacity: usize) -> Self {
        Self {
            buf: vec![0.0; capacity],
            read: 0,
            len: 0,
        }
    }

    fn push(&mut self, samples: &[f32]) {
        let cap = self.buf.len();
        for &s in samples {
            if self.len == cap {
                self.read = (self.read + 1) % cap;
                self.len -= 1;
            }
            self.buf[(self.read + self.len) % cap] = s;
            self.len += 1;
        }
    }

    /// Adds up to `out.len()` samples times `gain` into `out`; returns the
    /// peak of what was added.
    fn mix_into(&mut self, out: &mut [f32], gain: f32) -> f32 {
        let cap = self.buf.len();
        let n = self.len.min(out.len());
        let mut peak = 0.0f32;
        for (i, o) in out[..n].iter_mut().enumerate() {
            let v = self.buf[(self.read + i) % cap] * gain;
            peak = peak.max(v.abs());
            *o += v;
        }
        self.discard(n);
        peak
    }

    /// Removes `n` samples from the front and crossfades across the cut so
    /// the jump does not click. Falls back to a plain cut if too short.
    fn discard_crossfade(&mut self, n: usize) {
        let cap = self.buf.len();
        if n == 0 || self.len < n + TRIM_CROSSFADE {
            self.discard(n);
            return;
        }
        for i in 0..TRIM_CROSSFADE {
            let w = (i + 1) as f32 / (TRIM_CROSSFADE + 1) as f32;
            let old = self.buf[(self.read + i) % cap];
            let new_idx = (self.read + n + i) % cap;
            self.buf[new_idx] = old * (1.0 - w) + self.buf[new_idx] * w;
        }
        self.discard(n);
    }

    fn discard(&mut self, n: usize) {
        let n = n.min(self.len);
        self.read = (self.read + n) % self.buf.len();
        self.len -= n;
    }

    fn clear(&mut self) {
        self.read = 0;
        self.len = 0;
    }
}

/// Per-source jitter buffer + decoder. Decodes on demand from the output
/// callback so no decoded audio waits longer than necessary.
struct Source {
    in_use: bool,
    id: u32,
    decoder: Decoder,
    slots: Vec<Slot>,
    have_any: bool,
    next_seq: u16,
    highest_seq: u16,
    buffering: bool,
    pcm: PcmRing,
    /// Samples per packet, learned from the stream (2.5..20 ms).
    frame_samples: usize,
    /// Jitter-buffer target in samples (packets + decoded audio).
    target: usize,
    expand_run: u32,
    idle_samples: u64,
    window_min: usize,
    window_elapsed: u64,
    since_jitter_underrun: u64,
    /// Per-user gain, re-resolved when the settings generation changes.
    gain: f32,
    gain_generation: u32,
}

impl Source {
    fn new() -> Result<Self, String> {
        let decoder = Decoder::new(NATIVE_SAMPLE_RATE, Channels::Mono).map_err(|e| format!("opus decoder: {e}"))?;
        let slots = (0..JITTER_SLOTS)
            .map(|_| Slot {
                present: false,
                sequence: 0,
                len: 0,
                data: [0u8; MAX_OPUS_PACKET],
            })
            .collect();
        Ok(Self {
            in_use: false,
            id: 0,
            decoder,
            slots,
            have_any: false,
            next_seq: 0,
            highest_seq: 0,
            buffering: true,
            pcm: PcmRing::new(PCM_CAPACITY),
            frame_samples: DEFAULT_FRAME_SAMPLES,
            target: DEFAULT_FRAME_SAMPLES,
            expand_run: 0,
            idle_samples: 0,
            window_min: usize::MAX,
            window_elapsed: 0,
            since_jitter_underrun: 0,
            gain: 1.0,
            gain_generation: u32::MAX,
        })
    }

    fn activate(&mut self, id: u32) {
        self.in_use = true;
        self.id = id;
        let _ = self.decoder.reset_state();
        for slot in &mut self.slots {
            slot.present = false;
        }
        self.have_any = false;
        self.buffering = true;
        self.pcm.clear();
        self.frame_samples = DEFAULT_FRAME_SAMPLES;
        self.target = DEFAULT_FRAME_SAMPLES;
        self.expand_run = 0;
        self.idle_samples = 0;
        self.window_min = usize::MAX;
        self.window_elapsed = 0;
        self.since_jitter_underrun = 0;
        self.gain_generation = u32::MAX;
    }

    /// Audio waiting to be played: decoded samples plus buffered packets.
    fn queued(&self) -> usize {
        if !self.have_any {
            return self.pcm.len;
        }
        let span = (seq_diff(self.highest_seq, self.next_seq) + 1).max(0) as usize;
        self.pcm.len + span * self.frame_samples
    }

    fn insert(&mut self, pkt: &RxPacket, stats: &Stats) {
        self.idle_samples = 0;
        if !self.have_any {
            self.have_any = true;
            self.next_seq = pkt.sequence;
            self.highest_seq = pkt.sequence;
        }
        let mut ahead = seq_diff(pkt.sequence, self.next_seq);
        if ahead < 0 && self.buffering && self.pcm.len == 0 && -ahead < JITTER_SLOTS as i32 {
            // Not playing yet: an earlier packet arrived after a later one,
            // so the stream simply starts earlier.
            self.next_seq = pkt.sequence;
            ahead = 0;
        }
        if ahead < 0 {
            stats.late_packets.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if ahead >= JITTER_SLOTS as i32 {
            // Sequence jump (sender restarted): start over.
            for slot in &mut self.slots {
                slot.present = false;
            }
            self.pcm.clear();
            self.next_seq = pkt.sequence;
            self.highest_seq = pkt.sequence;
            self.buffering = true;
            self.expand_run = 0;
        } else if self.expand_run > 0 && pkt.sequence == self.next_seq {
            // The packet we were concealing arrived late: real jitter.
            self.raise_target(stats);
        }
        let payload = &pkt.data[..pkt.len as usize];
        if let Ok(n) = self.decoder.get_nb_samples(payload) {
            if n > 0 && n <= MAX_DECODED_SAMPLES {
                self.frame_samples = n;
            }
        }
        let slot = &mut self.slots[pkt.sequence as usize % JITTER_SLOTS];
        slot.present = true;
        slot.sequence = pkt.sequence;
        slot.len = pkt.len;
        slot.data[..payload.len()].copy_from_slice(payload);
        if seq_diff(pkt.sequence, self.highest_seq) > 0 {
            self.highest_seq = pkt.sequence;
        }
    }

    /// Decodes the next packet in sequence order. Missing packets are
    /// recovered from the next packet's FEC data or concealed. Returns false
    /// when nothing is buffered.
    fn decode_next(&mut self, scratch: &mut [f32], stats: &Stats) -> bool {
        if !self.have_any {
            return false;
        }
        let idx = self.next_seq as usize % JITTER_SLOTS;
        if self.slots[idx].present && self.slots[idx].sequence == self.next_seq {
            let slot = &mut self.slots[idx];
            slot.present = false;
            if let Ok(n) = self.decoder.decode_float(&slot.data[..slot.len as usize], scratch, false) {
                self.pcm.push(&scratch[..n]);
            }
            self.next_seq = self.next_seq.wrapping_add(1);
            self.expand_run = 0;
            return true;
        }
        if seq_diff(self.highest_seq, self.next_seq) > 0 {
            // A later packet exists, so this one is lost. (Waiting for it
            // with PLC was measured in the lab: it lowered speech MOS on
            // jittery links, so a gap is filled from FEC/PLC right away.)
            let frame = self.frame_samples.min(scratch.len());
            let next = self.next_seq.wrapping_add(1);
            let next_idx = next as usize % JITTER_SLOTS;
            let decoded = if self.slots[next_idx].present && self.slots[next_idx].sequence == next {
                stats.fec_recovered.fetch_add(1, Ordering::Relaxed);
                let slot = &self.slots[next_idx];
                self.decoder
                    .decode_float(&slot.data[..slot.len as usize], &mut scratch[..frame], true)
            } else {
                stats.concealed.fetch_add(1, Ordering::Relaxed);
                self.decoder.decode_float(&[], &mut scratch[..frame], false)
            };
            if let Ok(n) = decoded {
                self.pcm.push(&scratch[..n]);
            }
            self.slots[idx].present = false;
            self.next_seq = next;
            return true;
        }
        false
    }

    /// Gives the buffer more headroom after a packet missed its playout time.
    fn raise_target(&mut self, stats: &Stats) {
        let step = (self.frame_samples / 4).max(TARGET_MIN_STEP);
        self.target = (self.target + step).min(MAX_TARGET_SAMPLES);
        self.since_jitter_underrun = 0;
        stats.jitter_underruns.fetch_add(1, Ordering::Relaxed);
    }

    /// Removes `samples` of queued audio to cut latency. With `smooth`, up
    /// to TRIM_MAX_DECODES packets are decoded so the cut happens inside
    /// decoded audio with a crossfade (keeps decoder state continuous);
    /// otherwise, and for any larger backlog, whole packets are skipped
    /// undecoded (used while the source is silent anyway).
    fn drop_samples(&mut self, samples: usize, scratch: &mut [f32], stats: &Stats, smooth: bool) {
        let frame = self.frame_samples.max(1);
        let mut left = samples;
        if smooth {
            // Skip whole packets beyond what we are willing to decode.
            let decodable = TRIM_MAX_DECODES * frame;
            while left > decodable + self.pcm.len && self.skip_packet() {
                left -= frame;
            }
            let mut decodes = 0;
            while self.pcm.len < left + TRIM_CROSSFADE && decodes < TRIM_MAX_DECODES {
                if !self.decode_next(scratch, stats) {
                    break;
                }
                decodes += 1;
            }
            self.pcm.discard_crossfade(left.min(self.pcm.len));
        } else {
            let from_pcm = left.min(self.pcm.len);
            self.pcm.discard(from_pcm);
            left -= from_pcm;
            while left >= frame && self.skip_packet() {
                left -= frame;
            }
        }
    }

    /// Drops the next packet undecoded. False when none is buffered.
    fn skip_packet(&mut self) -> bool {
        if !self.have_any || seq_diff(self.highest_seq, self.next_seq) < 0 {
            return false;
        }
        let idx = self.next_seq as usize % JITTER_SLOTS;
        self.slots[idx].present = false;
        self.next_seq = self.next_seq.wrapping_add(1);
        true
    }

    /// Renders this source into `mix`; returns the peak it contributed.
    fn render(&mut self, mix: &mut [f32], scratch: &mut [f32], stats: &Stats, settings: &Settings) -> f32 {
        let frames = mix.len();
        self.idle_samples += frames as u64;
        if self.idle_samples > SOURCE_RELEASE_IDLE_SAMPLES {
            self.in_use = false;
            return 0.0;
        }
        let generation = settings.gains_generation.load(Ordering::Acquire);
        if generation != self.gain_generation {
            self.gain = settings.output_gain(self.id);
            self.gain_generation = generation;
        }
        if self.buffering {
            if self.have_any && self.queued() >= self.target {
                self.buffering = false;
                self.window_min = usize::MAX;
                self.window_elapsed = 0;
                // After a stall the backlog arrives as one burst; start at
                // the target instead of playing the whole backlog late.
                let excess = self.queued().saturating_sub(self.target);
                if excess >= self.frame_samples {
                    self.drop_samples(excess, scratch, stats, false);
                    stats.latency_trims.fetch_add(1, Ordering::Relaxed);
                }
            } else {
                return 0.0;
            }
        }
        while self.pcm.len < frames {
            if !self.decode_next(scratch, stats) {
                break;
            }
        }
        if self.pcm.len < frames {
            if self.expand_run < MAX_EXPAND_RUN {
                // Underrun: stretch with Opus PLC instead of a hard gap. The
                // sequence does not advance, so a late packet still plays.
                let need = frames - self.pcm.len;
                let chunk = need.div_ceil(120) * 120;
                let chunk = chunk.min(scratch.len());
                if let Ok(n) = self.decoder.decode_float(&[], &mut scratch[..chunk], false) {
                    self.pcm.push(&scratch[..n]);
                }
                self.expand_run += 1;
                stats.concealed.fetch_add(1, Ordering::Relaxed);
            } else {
                // Talk spurt ended (or the link stalled): rebuffer.
                self.buffering = true;
                self.expand_run = 0;
            }
        }
        let peak = self.pcm.mix_into(mix, self.gain);

        // Latency control: if the buffer never dropped below target + one
        // frame during a whole window, we are carrying excess delay (burst
        // or clock drift) — drop one frame.
        let queued = self.queued();
        self.window_min = self.window_min.min(queued);
        self.window_elapsed += frames as u64;
        self.since_jitter_underrun += frames as u64;
        if self.window_elapsed >= LATENCY_WINDOW_SAMPLES {
            if !self.buffering && self.window_min > self.target + TRIM_MARGIN_SAMPLES {
                // The buffer never came near the target for a whole window:
                // that much delay is persistent, drop all of it at once.
                let excess = self.window_min - self.target;
                self.drop_samples(excess, scratch, stats, true);
                stats.latency_trims.fetch_add(1, Ordering::Relaxed);
            }
            self.window_min = usize::MAX;
            self.window_elapsed = 0;
        }
        if self.since_jitter_underrun >= TARGET_DECAY_SAMPLES {
            self.target = self.target.saturating_sub(TARGET_DECAY_STEP).max(TARGET_FLOOR_SAMPLES);
            self.since_jitter_underrun = 0;
        }
        peak
    }
}

/// Mix limiter: transparent up to LIMIT_KNEE, then bends smoothly towards
/// full scale instead of clipping hard. Several talkers at normal level sum
/// above 1.0 (8 at once overshot on ~0.2 % of samples in the lab), and hard
/// clipping is heard as crackle.
const LIMIT_KNEE: f32 = 0.75;

fn soft_limit(x: f32) -> f32 {
    let a = x.abs();
    if a <= LIMIT_KNEE {
        return x;
    }
    let headroom = 1.0 - LIMIT_KNEE;
    (LIMIT_KNEE + headroom * ((a - LIMIT_KNEE) / headroom).tanh()).copysign(x)
}

/// Owned by the output callback: drains the network queue, renders every
/// source into a mono mix and writes it to all device channels.
struct Playback {
    rx: Receiver<RxPacket>,
    sources: Vec<Source>,
    mix: Vec<f32>,
    scratch: Vec<f32>,
    channels: usize,
    shared: Arc<Shared>,
}

impl Playback {
    fn new(rx: Receiver<RxPacket>, channels: usize, shared: Arc<Shared>) -> Result<Self, String> {
        let sources = (0..MAX_SOURCES).map(|_| Source::new()).collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            rx,
            sources,
            mix: vec![0.0; MIX_CHUNK],
            scratch: vec![0.0; MAX_DECODED_SAMPLES],
            channels,
            shared,
        })
    }

    fn route(&mut self, pkt: RxPacket) {
        let stats = &self.shared.stats;
        if let Some(src) = self.sources.iter_mut().find(|s| s.in_use && s.id == pkt.source_id) {
            src.insert(&pkt, stats);
            return;
        }
        if let Some(src) = self.sources.iter_mut().find(|s| !s.in_use) {
            src.activate(pkt.source_id);
            src.insert(&pkt, stats);
        }
    }

    fn on_output(&mut self, out: &mut [f32]) {
        let started = Instant::now();
        while let Ok(pkt) = self.rx.try_recv() {
            self.route(pkt);
        }
        let channels = self.channels;
        let frames = out.len() / channels;
        let Playback {
            sources,
            mix,
            scratch,
            shared,
            ..
        } = self;
        let stats = &shared.stats;
        let settings = &*shared.settings;
        let levels = &shared.levels;
        stats.output_callback_frames.store(frames as u32, Ordering::Relaxed);
        let mut done = 0;
        let mut output_peak = 0.0f32;
        let mut clipped = 0u64;
        while done < frames {
            let n = (frames - done).min(mix.len());
            let mix = &mut mix[..n];
            mix.fill(0.0);
            for (slot, src) in sources.iter_mut().enumerate() {
                if !src.in_use {
                    continue;
                }
                let peak = src.render(mix, scratch, stats, settings);
                levels.source_ids[slot].store(src.id, Ordering::Relaxed);
                levels.source_peak_bits[slot].fetch_max(peak.to_bits(), Ordering::Relaxed);
            }
            for (i, &v) in mix.iter().enumerate() {
                if v.abs() > 1.0 {
                    clipped += 1;
                }
                let v = soft_limit(v);
                output_peak = output_peak.max(v.abs());
                let base = (done + i) * channels;
                out[base..base + channels].fill(v);
            }
            done += n;
        }
        levels.output_peak_bits.fetch_max(output_peak.to_bits(), Ordering::Relaxed);
        stats.clipped_samples.fetch_add(clipped, Ordering::Relaxed);
        stats.mixed_samples.fetch_add(frames as u64, Ordering::Relaxed);
        let mut active = 0u32;
        let mut max_target = 0usize;
        let mut max_queued = 0usize;
        for src in sources.iter().filter(|s| s.in_use && !s.buffering) {
            active += 1;
            max_target = max_target.max(src.target);
            max_queued = max_queued.max(src.queued());
        }
        stats.active_sources.store(active, Ordering::Relaxed);
        stats.max_target_samples.store(max_target as u32, Ordering::Relaxed);
        stats.max_queued_samples.fetch_max(max_queued as u32, Ordering::Relaxed);
        let took = started.elapsed().as_micros() as u64;
        stats.render_calls.fetch_add(1, Ordering::Relaxed);
        stats.render_total_us.fetch_add(took, Ordering::Relaxed);
        stats.render_max_us.fetch_max(took, Ordering::Relaxed);
    }
}

/// Holds the packet-queue sender of whichever playback backend started.
type QueueSlot = Arc<Mutex<Option<SyncSender<RxPacket>>>>;

/// Builds a Playback with a fresh packet queue and publishes the sender.
/// Called only once a backend has otherwise succeeded, so a failed attempt
/// never leaves a dead queue behind.
fn new_playback(channels: usize, shared: &Arc<Shared>, slot: &QueueSlot) -> Result<Playback, String> {
    let (tx, rx) = sync_channel::<RxPacket>(RX_QUEUE_DEPTH);
    let playback = Playback::new(rx, channels.max(1), Arc::clone(shared))?;
    *slot.lock().unwrap() = Some(tx);
    Ok(playback)
}

/// Opens the output device through cpal.
fn open_playback_cpal(device_name: Option<String>, shared: Arc<Shared>, slot: QueueSlot) -> Result<(cpal::Stream, StreamReport), String> {
    let host = cpal::default_host();
    let device = pick_device(&host, device_name.as_deref(), false)?;
    let name = device.name().unwrap_or_default();
    let mut init_error = None;
    let (stream, config) = build_with_fallback(&device, false, |config| {
        let mut playback = match new_playback(config.channels as usize, &shared, &slot) {
            Ok(p) => p,
            Err(e) => {
                init_error = Some(e);
                return Err(cpal::BuildStreamError::StreamConfigNotSupported);
            }
        };
        device.build_output_stream(
            config,
            move |out: &mut [f32], _| playback.on_output(out),
            |err| log::warn!("[native][playback] stream error: {err}"),
            None,
        )
    })
    .map_err(|e| init_error.take().unwrap_or(e))?;
    Ok((stream, cpal_report(name, &config)))
}

// ── Backend selection ────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
    #[cfg(target_os = "windows")]
    WasapiExclusive,
    #[cfg(target_os = "windows")]
    WasapiShared,
    System,
}

/// Backends to try, best latency first. Each falls back to the next.
fn backend_chain(preference: Option<&str>) -> Vec<Backend> {
    #[cfg(target_os = "windows")]
    {
        let env = std::env::var("KESHER_NATIVE_AUDIO_BACKEND").ok();
        match env.as_deref().or(preference).unwrap_or("auto") {
            "system" => vec![Backend::System],
            "shared" => vec![Backend::WasapiShared, Backend::System],
            _ => vec![Backend::WasapiExclusive, Backend::WasapiShared, Backend::System],
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = preference;
        vec![Backend::System]
    }
}

#[cfg(target_os = "windows")]
fn wasapi_report(info: crate::audio_wasapi::StreamInfo) -> StreamReport {
    log::info!(
        "[native] {} on {:?}: period {} frames, {} ch, {}",
        info.mode.label(),
        info.device,
        info.period_frames,
        info.channels,
        info.format
    );
    StreamReport {
        backend: info.mode.label().to_string(),
        device: info.device,
        period_ms: Some(info.period_frames as f32 / SAMPLES_PER_MS),
    }
}

fn open_output(preference: Option<&str>, device: Option<String>, shared: &Arc<Shared>, slot: &QueueSlot) -> Result<StreamReport, String> {
    let mut errors = Vec::new();
    for backend in backend_chain(preference) {
        let result = match backend {
            #[cfg(target_os = "windows")]
            Backend::WasapiExclusive | Backend::WasapiShared => {
                use crate::audio_wasapi::{start_render, RenderCallback, WasapiMode};
                let mode = if backend == Backend::WasapiExclusive {
                    WasapiMode::Exclusive
                } else {
                    WasapiMode::SharedLowLatency
                };
                let (stop_shared, cb_shared, cb_slot) = (Arc::clone(shared), Arc::clone(shared), Arc::clone(slot));
                start_render(
                    device.clone(),
                    mode,
                    move || stop_shared.stop.load(Ordering::Acquire),
                    move |channels| {
                        let mut playback = new_playback(channels, &cb_shared, &cb_slot)?;
                        Ok(Box::new(move |out: &mut [f32]| playback.on_output(out)) as RenderCallback)
                    },
                )
                .map(wasapi_report)
            }
            Backend::System => {
                let (device, cb_shared, cb_slot) = (device.clone(), Arc::clone(shared), Arc::clone(slot));
                let (report_tx, report_rx) = sync_channel(1);
                spawn_stream_thread("kesher-native-playback", Arc::clone(shared), move || {
                    let (stream, report) = open_playback_cpal(device, cb_shared, cb_slot)?;
                    let _ = report_tx.send(report);
                    Ok(stream)
                })
                .and_then(|_| report_rx.recv().map_err(|_| "no playback report".to_string()))
            }
        };
        match result {
            Ok(report) => return Ok(report),
            Err(e) => {
                log::warn!("[native] output backend {backend:?} unavailable: {e}");
                errors.push(format!("{backend:?}: {e}"));
            }
        }
    }
    Err(format!("no output device could be opened ({})", errors.join("; ")))
}

fn open_input<M>(preference: Option<&str>, device: Option<String>, shared: &Arc<Shared>, make: M) -> Result<StreamReport, String>
where
    M: Fn(usize) -> Result<Capture, String> + Clone + Send + 'static,
{
    let mut errors = Vec::new();
    for backend in backend_chain(preference) {
        let result = match backend {
            #[cfg(target_os = "windows")]
            Backend::WasapiExclusive | Backend::WasapiShared => {
                use crate::audio_wasapi::{start_capture, CaptureCallback, WasapiMode};
                let mode = if backend == Backend::WasapiExclusive {
                    WasapiMode::Exclusive
                } else {
                    WasapiMode::SharedLowLatency
                };
                let stop_shared = Arc::clone(shared);
                let make = make.clone();
                start_capture(
                    device.clone(),
                    mode,
                    move || stop_shared.stop.load(Ordering::Acquire),
                    move |channels| {
                        let mut capture = make(channels)?;
                        Ok(Box::new(move |data: &[f32]| capture.on_input(data)) as CaptureCallback)
                    },
                )
                .map(wasapi_report)
            }
            Backend::System => {
                let (device, make) = (device.clone(), make.clone());
                let (report_tx, report_rx) = sync_channel(1);
                spawn_stream_thread("kesher-native-capture", Arc::clone(shared), move || {
                    let (stream, report) = open_capture_cpal(device, make)?;
                    let _ = report_tx.send(report);
                    Ok(stream)
                })
                .and_then(|_| report_rx.recv().map_err(|_| "no capture report".to_string()))
            }
        };
        match result {
            Ok(report) => return Ok(report),
            Err(e) => {
                log::warn!("[native] input backend {backend:?} unavailable: {e}");
                errors.push(format!("{backend:?}: {e}"));
            }
        }
    }
    Err(format!("no input device could be opened ({})", errors.join("; ")))
}

// ── Virtual device (benchmarks) ──────────────────────────────────────────

/// Fills one period of mono input. The `Instant` is when the first sample
/// of the period was "recorded".
pub type VirtualInput = Box<dyn FnMut(&mut [f32], Instant) + Send>;
/// Receives one period of mono output. The `Instant` is when its first
/// sample "plays".
pub type VirtualOutput = Box<dyn FnMut(&[f32], Instant) + Send>;

/// A clocked stand-in for a duplex sound card. It drives the engine's real
/// capture and playback callbacks, so a benchmark measures exactly the app's
/// audio path (framing, Opus, network, jitter buffer, FEC/PLC, mixing)
/// without device drivers. Like a device, each tick delivers the period
/// recorded during [t - period, t) and asks for the period played from t.
pub struct VirtualDevice {
    pub period_frames: usize,
    pub input: VirtualInput,
    pub output: VirtualOutput,
    /// Shared clock for running many virtual devices in one process (all
    /// ticks at once, no spinning thread per device). Its period wins over
    /// `period_frames`. None = this device keeps its own clock.
    pub clock: Option<Arc<VirtualClock>>,
}

/// One tick source for several virtual devices. A single high-priority
/// thread keeps time; devices block on a condvar instead of each spinning
/// a core, which would otherwise starve the server and network threads the
/// benchmark is measuring.
#[cfg_attr(not(feature = "bench"), allow(dead_code))]
pub struct VirtualClock {
    period_frames: usize,
    /// (tick count, time of the latest tick)
    state: Mutex<(u64, Instant)>,
    ticked: std::sync::Condvar,
    stop: AtomicBool,
}

#[cfg_attr(not(feature = "bench"), allow(dead_code))]
impl VirtualClock {
    pub fn start(period_frames: usize) -> Arc<Self> {
        let period_frames = period_frames.clamp(16, 4096);
        let period = Duration::from_secs_f64(period_frames as f64 / NATIVE_SAMPLE_RATE as f64);
        let clock = Arc::new(Self {
            period_frames,
            state: Mutex::new((0, Instant::now())),
            ticked: std::sync::Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let ticker = Arc::clone(&clock);
        let _ = std::thread::Builder::new().name("kesher-virtual-clock".into()).spawn(move || {
            raise_virtual_thread_priority();
            let mut tick = Instant::now() + period;
            while !ticker.stop.load(Ordering::Acquire) {
                sleep_until(tick);
                if Instant::now().saturating_duration_since(tick) > period * 8 {
                    tick = Instant::now();
                }
                {
                    let mut st = ticker.state.lock().unwrap();
                    st.0 += 1;
                    st.1 = tick;
                }
                ticker.ticked.notify_all();
                tick += period;
            }
            ticker.ticked.notify_all();
        });
        clock
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.ticked.notify_all();
    }

    /// Blocks until the tick count exceeds `seen` (or ~100 ms pass).
    fn wait_after(&self, seen: u64) -> Option<(u64, Instant)> {
        let st = self.state.lock().unwrap();
        let (st, _) = self
            .ticked
            .wait_timeout_while(st, Duration::from_millis(100), |st| st.0 <= seen && !self.stop.load(Ordering::Acquire))
            .unwrap();
        (st.0 > seen).then_some((st.0, st.1))
    }
}

fn open_virtual<M>(device: VirtualDevice, shared: &Arc<Shared>, slot: &QueueSlot, make: M) -> Result<(StreamReport, StreamReport), String>
where
    M: Fn(usize) -> Result<Capture, String>,
{
    let VirtualDevice {
        period_frames,
        mut input,
        mut output,
        clock,
    } = device;
    let period_frames = clock.as_ref().map_or(period_frames, |c| c.period_frames).clamp(16, 4096);
    let mut playback = new_playback(1, shared, slot)?;
    let mut capture = make(1)?;
    let period = Duration::from_secs_f64(period_frames as f64 / NATIVE_SAMPLE_RATE as f64);
    let shared = Arc::clone(shared);
    std::thread::Builder::new()
        .name("kesher-native-virtual".into())
        .spawn(move || {
            raise_virtual_thread_priority();
            let mut in_buf = vec![0.0f32; period_frames];
            let mut out_buf = vec![0.0f32; period_frames];
            let mut process = |at: Instant| {
                input(&mut in_buf, at - period);
                capture.on_input(&in_buf);
                out_buf.fill(0.0);
                playback.on_output(&mut out_buf);
                output(&out_buf, at);
            };
            if let Some(clock) = clock {
                let mut seen = clock.state.lock().unwrap().0;
                while !shared.stop.load(Ordering::Acquire) {
                    let Some((count, at)) = clock.wait_after(seen) else { continue };
                    // Missed ticks (this thread ran late) are still processed,
                    // so every device sees every period, but they are counted.
                    let missed = count - seen - 1;
                    if missed > 0 {
                        shared.stats.virtual_late_ticks.fetch_add(missed, Ordering::Relaxed);
                    }
                    for k in (0..=missed).rev() {
                        process(at - period * k as u32);
                    }
                    seen = count;
                }
                return;
            }
            // Ideal device clock: timestamps come from `tick`, not from when
            // the thread actually woke up.
            let mut tick = Instant::now() + period;
            while !shared.stop.load(Ordering::Acquire) {
                sleep_until(tick);
                let late = Instant::now().saturating_duration_since(tick);
                if late > period {
                    // A real device would have glitched here; counted so a
                    // benchmark can tell an overloaded machine from the engine.
                    shared.stats.virtual_late_ticks.fetch_add(1, Ordering::Relaxed);
                    if late > period * 8 {
                        tick = Instant::now();
                    }
                }
                process(tick);
                tick += period;
            }
        })
        .map_err(|e| format!("spawn virtual device: {e}"))?;
    let report = || StreamReport {
        backend: "virtual".to_string(),
        device: "virtual".to_string(),
        period_ms: Some(period_frames as f32 / SAMPLES_PER_MS),
    };
    Ok((report(), report()))
}

/// Sleeps coarsely, then spins for the last stretch: OS sleeps overshoot by
/// up to a millisecond, more than a short device period tolerates.
fn sleep_until(deadline: Instant) {
    const SPIN: Duration = Duration::from_micros(1500);
    loop {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let left = deadline - now;
        if left > SPIN {
            std::thread::sleep(left - SPIN);
        } else {
            std::hint::spin_loop();
        }
    }
}

fn raise_virtual_thread_priority() {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

// ── Network receive thread ───────────────────────────────────────────────

fn run_network_rx(
    socket: UdpSocket,
    tx: SyncSender<RxPacket>,
    shared: Arc<Shared>,
    session_token: String,
    token_hash: u32,
    version: u8,
    level_sink: Option<LevelSink>,
) {
    let _ = socket.set_read_timeout(Some(RECV_TIMEOUT));
    // Packets wait in the socket until this thread runs; give it the same
    // scheduling class as the audio threads.
    #[cfg(target_os = "windows")]
    let _priority = crate::audio_wasapi::ProAudioPriority::enter();
    let mut last_levels = Instant::now();
    let mut register = vec![0u8; UDP_HEADER_LEN_V2 + session_token.len()];
    let register_len = write_header(&mut register, version, UDP_FLAG_REGISTER, 0, 0, token_hash);
    register[register_len..register_len + session_token.len()].copy_from_slice(session_token.as_bytes());
    let register = &register[..register_len + session_token.len()];
    let mut heartbeat = [0u8; UDP_HEADER_LEN_V2];
    let heartbeat_len = write_header(&mut heartbeat, version, UDP_FLAG_HEARTBEAT, 0, 0, token_hash);

    let _ = socket.send(register);
    let mut beats: u32 = 0;
    let mut last_beat = Instant::now();
    let mut last_stats = Instant::now();
    let mut logged_stats = NativeStatsSnapshot::default();
    let mut buf = [0u8; 1500];

    let mut last_rx: Option<Instant> = None;
    while !shared.stop.load(Ordering::Acquire) {
        if last_beat.elapsed() >= HEARTBEAT_INTERVAL {
            beats = beats.wrapping_add(1);
            if beats % REGISTER_EVERY_HEARTBEATS == 0 {
                let _ = socket.send(register);
            } else {
                let _ = socket.send(&heartbeat[..heartbeat_len]);
            }
            last_beat = Instant::now();
        }
        if last_stats.elapsed() >= STATS_LOG_INTERVAL {
            log_stats(&shared.stats, &mut logged_stats, last_stats.elapsed());
            last_stats = Instant::now();
        }
        if let Some(sink) = &level_sink {
            if last_levels.elapsed() >= LEVEL_EMIT_INTERVAL {
                sink(shared.levels.take_event());
                last_levels = Instant::now();
            }
        }
        let n = match socket.recv(&mut buf) {
            Ok(n) => n,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
            Err(e) => {
                // e.g. WSAECONNRESET after an ICMP port-unreachable while the
                // relay restarts; back off briefly instead of spinning.
                log::debug!("[native][udp] recv error: {e}");
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        let Some(pkt) = parse_header(&buf[..n]) else {
            continue;
        };
        if pkt.flags & UDP_FLAG_AUDIO == 0 || pkt.payload.is_empty() || pkt.payload.len() > MAX_OPUS_PACKET {
            continue;
        }
        shared.stats.rx_packets.fetch_add(1, Ordering::Relaxed);
        let gap = record_gap(&mut last_rx, Instant::now(), &shared.stats.rx_max_gap_us, &shared.stats.rx_gaps_over_20ms);
        if gap > Duration::from_millis(40) {
            log::warn!(
                "[native][udp] {:.1} ms without audio packets (at {:?})",
                gap.as_secs_f64() * 1000.0,
                std::time::SystemTime::now()
            );
        }
        let mut rx = RxPacket {
            source_id: pkt.source_id,
            sequence: pkt.sequence,
            len: pkt.payload.len() as u16,
            data: [0u8; MAX_OPUS_PACKET],
        };
        rx.data[..pkt.payload.len()].copy_from_slice(pkt.payload);
        if let Err(TrySendError::Full(_)) = tx.try_send(rx) {
            shared.stats.rx_queue_full.fetch_add(1, Ordering::Relaxed);
        }
    }
    log::info!("[native][udp] receive thread exit");
}

/// Cumulative engine counters since start (see `stats_snapshot`).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatsSnapshot {
    pub tx_packets: u64,
    pub tx_errors: u64,
    pub rx_packets: u64,
    pub rx_queue_full: u64,
    pub jitter_underruns: u64,
    /// PLC events: lost packets plus output underruns stretched by PLC.
    pub concealed: u64,
    pub fec_recovered: u64,
    pub late_packets: u64,
    pub latency_trims: u64,
    pub virtual_late_ticks: u64,
    pub tx_gaps_over_20ms: u64,
    pub rx_gaps_over_20ms: u64,
    pub tx_max_gap_ms: f32,
    pub rx_max_gap_ms: f32,
    pub tx_send_max_ms: f32,
    pub vad_suppressed: u64,
    pub clipped_samples: u64,
    pub mixed_samples: u64,
    pub render_calls: u64,
    pub render_total_us: u64,
    pub render_max_ms: f32,
    pub active_sources: u32,
    /// Current jitter-buffer target of the deepest source.
    pub target_ms: f32,
    pub capture_callback_ms: f32,
    pub output_callback_ms: f32,
}

impl Stats {
    fn snapshot(&self) -> NativeStatsSnapshot {
        let ms = |a: &AtomicU32| a.load(Ordering::Relaxed) as f32 / SAMPLES_PER_MS;
        NativeStatsSnapshot {
            tx_packets: self.tx_packets.load(Ordering::Relaxed),
            tx_errors: self.tx_errors.load(Ordering::Relaxed),
            rx_packets: self.rx_packets.load(Ordering::Relaxed),
            rx_queue_full: self.rx_queue_full.load(Ordering::Relaxed),
            jitter_underruns: self.jitter_underruns.load(Ordering::Relaxed),
            concealed: self.concealed.load(Ordering::Relaxed),
            fec_recovered: self.fec_recovered.load(Ordering::Relaxed),
            late_packets: self.late_packets.load(Ordering::Relaxed),
            latency_trims: self.latency_trims.load(Ordering::Relaxed),
            virtual_late_ticks: self.virtual_late_ticks.load(Ordering::Relaxed),
            tx_gaps_over_20ms: self.tx_gaps_over_20ms.load(Ordering::Relaxed),
            rx_gaps_over_20ms: self.rx_gaps_over_20ms.load(Ordering::Relaxed),
            tx_max_gap_ms: self.tx_max_gap_us.load(Ordering::Relaxed) as f32 / 1000.0,
            rx_max_gap_ms: self.rx_max_gap_us.load(Ordering::Relaxed) as f32 / 1000.0,
            tx_send_max_ms: self.tx_send_max_us.load(Ordering::Relaxed) as f32 / 1000.0,
            vad_suppressed: self.vad_suppressed.load(Ordering::Relaxed),
            clipped_samples: self.clipped_samples.load(Ordering::Relaxed),
            mixed_samples: self.mixed_samples.load(Ordering::Relaxed),
            render_calls: self.render_calls.load(Ordering::Relaxed),
            render_total_us: self.render_total_us.load(Ordering::Relaxed),
            render_max_ms: self.render_max_us.load(Ordering::Relaxed) as f32 / 1000.0,
            active_sources: self.active_sources.load(Ordering::Relaxed),
            target_ms: ms(&self.max_target_samples),
            capture_callback_ms: ms(&self.capture_callback_frames),
            output_callback_ms: ms(&self.output_callback_frames),
        }
    }
}

/// Counters are cumulative; the log prints the change since the last line.
fn log_stats(stats: &Stats, prev: &mut NativeStatsSnapshot, elapsed: Duration) {
    let now = stats.snapshot();
    let secs = elapsed.as_secs_f32().max(0.001);
    log::info!(
        "[native][stats] tx={:.0}/s rx={:.0}/s cb_in={:.2}ms cb_out={:.2}ms sources={} \
         target={:.1}ms queued_max={:.1}ms jitter_underruns={} concealed={} fec={} late={} trims={} \
         rxq_full={} tx_err={}",
        (now.tx_packets - prev.tx_packets) as f32 / secs,
        (now.rx_packets - prev.rx_packets) as f32 / secs,
        now.capture_callback_ms,
        now.output_callback_ms,
        now.active_sources,
        now.target_ms,
        stats.max_queued_samples.swap(0, Ordering::Relaxed) as f32 / SAMPLES_PER_MS,
        now.jitter_underruns - prev.jitter_underruns,
        now.concealed - prev.concealed,
        now.fec_recovered - prev.fec_recovered,
        now.late_packets - prev.late_packets,
        now.latency_trims - prev.latency_trims,
        now.rx_queue_full - prev.rx_queue_full,
        now.tx_errors - prev.tx_errors,
    );
    *prev = now;
}

/// Cumulative counters of the running engine, or None when it is stopped.
#[allow(dead_code)] // used by src/bin/kesher_audio_bench.rs
pub fn stats_snapshot(state: &NativeAudioState) -> Option<NativeStatsSnapshot> {
    state.engine.lock().unwrap().as_ref().map(|e| e.shared.stats.snapshot())
}

// ── Engine lifecycle (Tauri commands call into this) ─────────────────────

/// Start the native engine. Returns once the UDP socket is bound and both
/// audio streams are running, reporting which backends were opened.
pub async fn start_engine(
    params: StartNativeParams,
    state: &NativeAudioState,
    level_sink: Option<LevelSink>,
) -> Result<EngineStartInfo, String> {
    start_engine_with(params, state, level_sink, None)
}

/// Like `start_engine`, but with a `VirtualDevice` instead of sound cards
/// (benchmarks; see `src/bin/kesher_audio_bench.rs`).
#[allow(dead_code)] // used by src/bin/kesher_audio_bench.rs
pub fn start_engine_virtual(
    params: StartNativeParams,
    state: &NativeAudioState,
    device: VirtualDevice,
) -> Result<EngineStartInfo, String> {
    start_engine_with(params, state, None, Some(device))
}

fn start_engine_with(
    params: StartNativeParams,
    state: &NativeAudioState,
    level_sink: Option<LevelSink>,
    virtual_device: Option<VirtualDevice>,
) -> Result<EngineStartInfo, String> {
    if state.engine.lock().unwrap().is_some() {
        return Err("native engine already running".to_string());
    }
    #[cfg(target_os = "windows")]
    crate::audio_wasapi::tune_process_for_realtime();
    let server_addr: SocketAddr = (params.server_host.as_str(), params.server_port)
        .to_socket_addrs()
        .map_err(|e| format!("invalid server addr: {e}"))?
        .next()
        .ok_or_else(|| "server address did not resolve".to_string())?;
    let bind_addr = if server_addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let socket = UdpSocket::bind(bind_addr).map_err(|e| format!("bind udp: {e}"))?;
    socket.connect(server_addr).map_err(|e| format!("connect udp: {e}"))?;
    {
        let sock = socket2::SockRef::from(&socket);
        let _ = sock.set_recv_buffer_size(SOCKET_BUFFER_BYTES);
        let _ = sock.set_send_buffer_size(SOCKET_BUFFER_BYTES);
        log::info!(
            "[native] udp socket buffers: recv {:?} send {:?}",
            sock.recv_buffer_size().ok(),
            sock.send_buffer_size().ok()
        );
    }

    let version = match params.protocol_version {
        Some(v) if v >= UDP_VERSION_2 => UDP_VERSION_2,
        _ => UDP_VERSION_1,
    };
    let frame_samples = frame_samples_from_ms(params.frame_duration_ms);
    let shared = Arc::new(Shared {
        settings: Arc::clone(&state.settings),
        ..Shared::default()
    });
    // From here on, dropping `engine` stops every thread started below.
    let engine = RunningNativeEngine {
        shared: Arc::clone(&shared),
    };
    let preference = params.audio_backend.as_deref();

    let rx_socket = socket.try_clone().map_err(|e| format!("socket clone: {e}"))?;
    let make = {
        let socket = Arc::new(socket);
        let shared_cb = Arc::clone(&shared);
        let token_hash = params.token_hash;
        move |channels: usize| new_capture(&socket, version, token_hash, frame_samples, channels, &shared_cb)
    };

    let slot: QueueSlot = Arc::new(Mutex::new(None));
    let (output, virtual_input) = match virtual_device {
        Some(device) => {
            let (input, output) = open_virtual(device, &shared, &slot, make.clone())?;
            (output, Some(input))
        }
        None => (open_output(preference, params.output_device_id.clone(), &shared, &slot)?, None),
    };
    let packet_tx = slot
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "playback queue not available".to_string())?;
    {
        let shared = Arc::clone(&shared);
        let token = params.session_token.clone();
        let token_hash = params.token_hash;
        std::thread::Builder::new()
            .name("kesher-native-udp".into())
            .spawn(move || run_network_rx(rx_socket, packet_tx, shared, token, token_hash, version, level_sink))
            .map_err(|e| format!("spawn udp thread: {e}"))?;
    }
    let input = match virtual_input {
        Some(report) => report,
        None => open_input(preference, params.input_device_id.clone(), &shared, make)?,
    };

    let mut guard = state.engine.lock().unwrap();
    if guard.is_some() {
        return Err("native engine already running".to_string());
    }
    *guard = Some(engine);
    let info = EngineStartInfo {
        input,
        output,
        frame_ms: frame_samples as f32 / SAMPLES_PER_MS,
        protocol_version: version,
    };
    log::info!("[native] engine started: target={server_addr} {info:?}");
    Ok(info)
}

/// Sets the outgoing mic gain (linear, 0..16).
pub fn set_input_gain(state: &NativeAudioState, gain: f32) {
    let gain = if gain.is_finite() { gain.clamp(0.0, MAX_INPUT_GAIN) } else { 1.0 };
    state.settings.input_gain_bits.store(gain.to_bits(), Ordering::Relaxed);
}

/// Silence suppression for always-on mics (see Capture::flush_frame).
pub fn set_vad(state: &NativeAudioState, enabled: bool) {
    state.settings.vad_enabled.store(enabled, Ordering::Relaxed);
}

/// Configures the mic noise gate (threshold in dBFS, -72..-12).
pub fn set_audio_gate(state: &NativeAudioState, enabled: bool, threshold_db: f32) {
    let db = if threshold_db.is_finite() {
        threshold_db.clamp(MIN_GATE_THRESHOLD_DB, MAX_GATE_THRESHOLD_DB)
    } else {
        -52.0
    };
    state
        .settings
        .gate_threshold_bits
        .store(db_to_amplitude(db).to_bits(), Ordering::Relaxed);
    state.settings.gate_enabled.store(enabled, Ordering::Relaxed);
}

/// Replaces the per-source output gains. Keys are native source IDs as sent
/// in presence (`audioSourceId`); unknown sources play at unity gain.
pub fn set_output_gains(state: &NativeAudioState, gains: &std::collections::HashMap<String, f32>) {
    let parsed: Vec<(u32, f32)> = gains
        .iter()
        .filter_map(|(k, &g)| Some((k.parse::<u32>().ok()?, if g.is_finite() { g } else { 1.0 })))
        .collect();
    state.settings.set_output_gains(&parsed);
}

/// Stop the native engine. Idempotent.
pub async fn stop_engine(state: &NativeAudioState) {
    // Dropping the engine sets the stop flag; threads exit within ~200 ms.
    let _ = state.engine.lock().unwrap().take();
}

/// Toggle mic capture (mirrors the WebRTC engine's PTT).
pub fn set_mic_active(state: &NativeAudioState, active: bool) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.shared.mic_active.store(active, Ordering::Release);
    }
}

/// Measures mouth-to-ear latency: sends a click that the relay echoes back
/// to this client only, and times how long it takes to reappear at the
/// input via an acoustic or cable path from the output. Returns
/// milliseconds, or None if the click was not detected.
pub async fn run_latency_test(state: &NativeAudioState) -> Result<Option<f64>, String> {
    let shared = state
        .engine
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| Arc::clone(&e.shared))
        .ok_or_else(|| "native engine not running".to_string())?;
    shared.test_result_us.store(0, Ordering::Release);
    shared.test_state.store(TEST_ARMED, Ordering::Release);
    let deadline = Instant::now() + Duration::from_millis(2500);
    let result = loop {
        match shared.test_state.load(Ordering::Acquire) {
            TEST_DONE => break Some(shared.test_result_us.load(Ordering::Acquire) as f64 / 1000.0),
            TEST_FAILED => break None,
            _ if Instant::now() >= deadline => break None,
            _ => tokio::time::sleep(Duration::from_millis(10)).await,
        }
    };
    shared.test_state.store(TEST_IDLE, Ordering::Release);
    match result {
        Some(ms) => log::info!("[native][latency-test] mouth-to-ear {ms:.2} ms"),
        None => log::warn!("[native][latency-test] click not detected (needs output->input path)"),
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rx(source_id: u32, sequence: u16, payload: &[u8]) -> RxPacket {
        let mut pkt = RxPacket {
            source_id,
            sequence,
            len: payload.len() as u16,
            data: [0u8; MAX_OPUS_PACKET],
        };
        pkt.data[..payload.len()].copy_from_slice(payload);
        pkt
    }

    fn encode_frames(count: usize, frame: usize) -> Vec<Vec<u8>> {
        let mut enc = Encoder::new(NATIVE_SAMPLE_RATE, Channels::Mono, Application::LowDelay).unwrap();
        let mut out = Vec::new();
        for f in 0..count {
            let pcm: Vec<f32> = (0..frame)
                .map(|i| ((f * frame + i) as f32 * 0.05).sin() * 0.5)
                .collect();
            let mut buf = [0u8; MAX_OPUS_PACKET];
            let n = enc.encode_float(&pcm, &mut buf).unwrap();
            out.push(buf[..n].to_vec());
        }
        out
    }

    #[test]
    fn header_round_trip_v2() {
        let mut buf = [0u8; UDP_HEADER_LEN_V2 + 4];
        let len = write_header(&mut buf, UDP_VERSION_2, UDP_FLAG_AUDIO, 0xABCD, 0x12345678, 0xDEADBEEF);
        assert_eq!(len, UDP_HEADER_LEN_V2);
        buf[16..20].copy_from_slice(&0xCAFEF00Du32.to_be_bytes()); // as the relay would
        buf[len..].copy_from_slice(&[1, 2, 3, 4]);
        let parsed = parse_header(&buf).expect("decode");
        assert_eq!(parsed.flags, UDP_FLAG_AUDIO);
        assert_eq!(parsed.sequence, 0xABCD);
        assert_eq!(parsed.source_id, 0xCAFEF00D);
        assert_eq!(parsed.payload, &[1, 2, 3, 4]);
    }

    #[test]
    fn header_v1_still_parses() {
        let mut buf = [0u8; UDP_HEADER_LEN_V1 + 2];
        let len = write_header(&mut buf, UDP_VERSION_1, UDP_FLAG_AUDIO, 7, 0, 1);
        assert_eq!(len, UDP_HEADER_LEN_V1);
        let parsed = parse_header(&buf).expect("decode");
        assert_eq!(parsed.source_id, 0);
        assert_eq!(parsed.payload.len(), 2);
    }

    #[test]
    fn header_rejects_bad_magic_and_short() {
        let mut buf = [0u8; UDP_HEADER_LEN_V2];
        buf[0..4].copy_from_slice(b"XXXX");
        buf[4] = UDP_VERSION_2;
        assert!(parse_header(&buf).is_none());
        let mut short = [0u8; UDP_HEADER_LEN_V2 - 1];
        write_header(&mut short[..], UDP_VERSION_1, 0, 0, 0, 0);
        short[4] = UDP_VERSION_2;
        assert!(parse_header(&short).is_none());
    }

    #[test]
    fn seq_diff_wraps() {
        assert_eq!(seq_diff(1, 0), 1);
        assert_eq!(seq_diff(0, 65535), 1);
        assert_eq!(seq_diff(65535, 0), -1);
    }

    #[test]
    fn frame_size_selection() {
        assert_eq!(frame_samples_from_ms(Some(2.5)), 120);
        assert_eq!(frame_samples_from_ms(Some(5.0)), 240);
        assert_eq!(frame_samples_from_ms(Some(7.0)), DEFAULT_FRAME_SAMPLES);
        assert_eq!(frame_samples_from_ms(None), DEFAULT_FRAME_SAMPLES);
    }

    #[test]
    fn jitter_buffer_plays_in_order_and_starts_after_one_frame() {
        let stats = Stats::default();
        let settings = Settings::default();
        let mut src = Source::new().unwrap();
        src.activate(42);
        let frames = encode_frames(4, 240);
        let mut scratch = vec![0.0; MAX_DECODED_SAMPLES];
        let mut mix = vec![0.0; 128];

        // Nothing buffered: silence, still buffering.
        src.render(&mut mix, &mut scratch, &stats, &settings);
        assert!(src.buffering);

        // Out-of-order arrival before playback starts moves the start back.
        src.insert(&rx(42, 101, &frames[1]), &stats);
        src.insert(&rx(42, 100, &frames[0]), &stats);
        assert_eq!(src.next_seq, 100);

        // Two frames buffered >= one-frame target: playback starts in order.
        mix = vec![0.0; 480];
        src.render(&mut mix, &mut scratch, &stats, &settings);
        assert!(!src.buffering);
        assert_eq!(src.next_seq, 102);
        assert!(mix.iter().any(|v| v.abs() > 0.0));

        // A duplicate of an already played packet is late.
        src.insert(&rx(42, 100, &frames[0]), &stats);
        assert_eq!(stats.late_packets.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn jitter_buffer_recovers_loss_with_fec_and_conceals_underrun() {
        let stats = Stats::default();
        let settings = Settings::default();
        let mut src = Source::new().unwrap();
        src.activate(1);
        let frames = encode_frames(6, 240);
        let mut scratch = vec![0.0; MAX_DECODED_SAMPLES];
        let mut mix = vec![0.0; 240];

        src.insert(&rx(1, 0, &frames[0]), &stats);
        src.render(&mut mix, &mut scratch, &stats, &settings);
        assert!(!src.buffering, "one frame buffered reaches the default target");
        assert_eq!(src.next_seq, 1);

        // Packet 1 lost, 2 present: decoded via FEC from packet 2.
        src.insert(&rx(1, 2, &frames[2]), &stats);
        mix.fill(0.0);
        src.render(&mut mix, &mut scratch, &stats, &settings);
        assert_eq!(stats.fec_recovered.load(Ordering::Relaxed), 1);
        assert_eq!(src.next_seq, 2);

        // Packet 2 plays next; then nothing is buffered -> PLC expand.
        mix.fill(0.0);
        src.render(&mut mix, &mut scratch, &stats, &settings);
        mix.fill(0.0);
        src.render(&mut mix, &mut scratch, &stats, &settings);
        assert!(src.expand_run > 0);
        let concealed = stats.concealed.load(Ordering::Relaxed);
        assert!(concealed >= 1);

        // The concealed packet arrives late: counted as jitter, target grows.
        let target_before = src.target;
        src.insert(&rx(1, 3, &frames[3]), &stats);
        assert_eq!(stats.jitter_underruns.load(Ordering::Relaxed), 1);
        assert!(src.target > target_before);
    }

    #[test]
    fn burst_after_stall_starts_at_target_not_backlog() {
        let stats = Stats::default();
        let settings = Settings::default();
        let mut src = Source::new().unwrap();
        src.activate(1);
        let frames = encode_frames(30, 240);
        let mut scratch = vec![0.0; MAX_DECODED_SAMPLES];
        // 150 ms of backlog lands in one go while the source is buffering.
        for (i, f) in frames.iter().enumerate() {
            src.insert(&rx(1, i as u16, f), &stats);
        }
        let mut mix = vec![0.0; 128];
        src.render(&mut mix, &mut scratch, &stats, &settings);
        assert!(!src.buffering);
        assert!(
            src.queued() <= src.target + src.frame_samples,
            "queued {} target {}",
            src.queued(),
            src.target
        );
        assert_eq!(stats.latency_trims.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn persistent_excess_is_dropped_within_two_windows() {
        let stats = Stats::default();
        let settings = Settings::default();
        let mut src = Source::new().unwrap();
        src.activate(1);
        let frames = encode_frames(200, 240);
        let mut scratch = vec![0.0; MAX_DECODED_SAMPLES];
        let mut mix = vec![0.0; 240];
        src.insert(&rx(1, 0, &frames[0]), &stats);
        src.render(&mut mix, &mut scratch, &stats, &settings);
        // A 100 ms backlog builds up while playing, then packets keep
        // arriving at the playback rate, so the excess would never drain.
        let mut seq = 1u16;
        for _ in 0..20 {
            src.insert(&rx(1, seq, &frames[seq as usize]), &stats);
            seq += 1;
        }
        // The backlog appears mid-window, so the next full window drops it.
        let window_callbacks = 2 * LATENCY_WINDOW_SAMPLES as usize / 240 + 2;
        for _ in 0..window_callbacks {
            src.insert(&rx(1, seq, &frames[seq as usize % 200]), &stats);
            seq += 1;
            mix.fill(0.0);
            src.render(&mut mix, &mut scratch, &stats, &settings);
        }
        assert!(
            src.queued() <= src.target + src.frame_samples,
            "queued {} target {}",
            src.queued(),
            src.target
        );
    }

    #[test]
    fn crossfade_cut_is_continuous() {
        let mut ring = PcmRing::new(1024);
        let ramp: Vec<f32> = (0..400).map(|i| i as f32 / 400.0).collect();
        ring.push(&ramp);
        ring.discard_crossfade(100);
        let mut out = vec![0.0; 300];
        ring.mix_into(&mut out, 1.0);
        // The first sample after the cut stays close to the old head instead
        // of jumping 100 samples ahead.
        assert!(out[0] < 0.05, "{}", out[0]);
        assert!((out[299] - 399.0 / 400.0).abs() < 1e-6);
    }

    #[test]
    fn target_decays_below_one_frame() {
        let stats = Stats::default();
        let settings = Settings::default();
        let mut src = Source::new().unwrap();
        src.activate(1);
        let frames = encode_frames(1, 240);
        let mut scratch = vec![0.0; MAX_DECODED_SAMPLES];
        let mut mix = vec![0.0; 240];
        src.insert(&rx(1, 0, &frames[0]), &stats);
        for _ in 0..20 {
            src.since_jitter_underrun = TARGET_DECAY_SAMPLES;
            src.render(&mut mix, &mut scratch, &stats, &settings);
        }
        assert_eq!(src.target, TARGET_FLOOR_SAMPLES);
    }

    #[test]
    fn soft_limit_is_transparent_below_knee_and_bounded_above() {
        assert_eq!(soft_limit(0.5), 0.5);
        assert_eq!(soft_limit(-0.75), -0.75);
        assert!(soft_limit(1.0) < 1.0 && soft_limit(1.0) > 0.9);
        assert!(soft_limit(4.0) <= 1.0);
        assert!(soft_limit(-4.0) >= -1.0);
        // Monotonic, so loud stays louder than less loud.
        assert!(soft_limit(1.2) > soft_limit(1.1));
    }

    fn tone(freq: f32, amp: f32, n: usize, offset: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * (offset + i) as f32 / 48_000.0).sin() * amp)
            .collect()
    }

    #[test]
    fn vad_separates_speech_from_room_noise() {
        let mut vad = Vad::default();
        let mut noise = 12345u32;
        let mut hiss = |n: usize| -> Vec<f32> {
            (0..n)
                .map(|_| {
                    noise = noise.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    ((noise >> 16) as f32 / 32768.0 - 1.0) * 0.003 // about -55 dBFS
                })
                .collect()
        };
        // Steady room noise settles as silence.
        let mut silent = 0;
        for _ in 0..200 {
            if !vad.is_speech(&hiss(240), 5.0) {
                silent += 1;
            }
        }
        assert!(silent > 190, "noise judged speech {} times", 200 - silent);
        // Normal speech level is detected right away.
        assert!(vad.is_speech(&tone(300.0, 0.1, 240, 0), 5.0));
        // So is a soft onset ~15 dB above the noise.
        assert!(vad.is_speech(&tone(300.0, 0.02, 240, 0), 5.0));
    }

    #[test]
    fn silence_suppression_withholds_silence_and_sends_preroll_on_onset() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let sink = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.connect(sink.local_addr().unwrap()).unwrap();
        sink.set_nonblocking(true).unwrap();
        let shared = Arc::new(Shared::default());
        shared.mic_active.store(true, Ordering::Relaxed);
        shared.settings.vad_enabled.store(true, Ordering::Relaxed);
        let mut capture = new_capture(&socket, UDP_VERSION_2, 1, 240, 1, &shared).unwrap();
        let recv = || {
            let mut buf = [0u8; 1500];
            let mut seqs = Vec::new();
            while let Ok(n) = sink.recv(&mut buf) {
                seqs.push(parse_header(&buf[..n]).unwrap().sequence);
            }
            seqs
        };

        // 1 s of silence: only the initial hangover goes out.
        capture.on_input(&vec![0.0; 48_000]);
        let first = recv();
        let hangover = (VAD_HANGOVER_MS as usize * 48) / 240;
        assert!(first.len() <= hangover + 1, "sent {} silent frames", first.len());
        assert!(shared.stats.vad_suppressed.load(Ordering::Relaxed) > 100);

        // Speech starts: pre-roll + speech frames, sequence contiguous.
        capture.on_input(&tone(300.0, 0.1, 2_400, 0));
        let second = recv();
        let preroll = (VAD_PREROLL_MS as usize * 48) / 240;
        assert_eq!(second.len(), preroll + 10, "pre-roll + 10 speech frames");
        let all: Vec<u16> = first.iter().chain(second.iter()).copied().collect();
        assert!(all.windows(2).all(|w| w[1] == w[0].wrapping_add(1)), "sequence gap: {all:?}");

        // With suppression off (PTT), silence is sent as usual.
        shared.settings.vad_enabled.store(false, Ordering::Relaxed);
        capture.on_input(&vec![0.0; 2_400]);
        assert_eq!(recv().len(), 10);
    }

    #[test]
    fn jitter_buffer_rebuffers_after_talk_spurt() {
        let stats = Stats::default();
        let settings = Settings::default();
        let mut src = Source::new().unwrap();
        src.activate(1);
        let frames = encode_frames(1, 240);
        let mut scratch = vec![0.0; MAX_DECODED_SAMPLES];
        let mut mix = vec![0.0; 240];
        src.insert(&rx(1, 0, &frames[0]), &stats);
        for _ in 0..(MAX_EXPAND_RUN + 2) {
            mix.fill(0.0);
            src.render(&mut mix, &mut scratch, &stats, &settings);
        }
        assert!(src.buffering, "source goes quiet after the expand budget");
        assert_eq!(src.expand_run, 0);
    }

    #[test]
    fn playback_mixes_sources_independently() {
        let (tx, rxq) = sync_channel::<RxPacket>(8);
        let shared = Arc::new(Shared::default());
        let mut playback = Playback::new(rxq, 2, Arc::clone(&shared)).unwrap();
        let frames = encode_frames(1, 240);
        tx.send(rx(10, 0, &frames[0])).unwrap();
        tx.send(rx(20, 500, &frames[0])).unwrap();
        let mut out = vec![0.0f32; 240 * 2];
        playback.on_output(&mut out);
        let active: Vec<u32> = playback.sources.iter().filter(|s| s.in_use).map(|s| s.id).collect();
        assert_eq!(active.len(), 2);
        assert!(active.contains(&10) && active.contains(&20));
        assert!(out.chunks(2).all(|c| c[0] == c[1]), "mono copied to both channels");
        assert!(out.iter().all(|v| v.abs() <= 1.0));
    }

    #[test]
    fn pcm_ring_wraps_and_mixes() {
        let mut ring = PcmRing::new(4);
        ring.push(&[1.0, 2.0, 3.0]);
        let mut out = [0.0; 2];
        assert_eq!(ring.mix_into(&mut out, 1.0), 2.0);
        assert_eq!(out, [1.0, 2.0]);
        assert_eq!(ring.len, 1);
        ring.push(&[4.0, 5.0, 6.0, 7.0]); // overflow drops oldest
        let mut out = [0.0; 4];
        assert_eq!(ring.mix_into(&mut out, 0.5), 3.5);
        assert_eq!(out, [2.0, 2.5, 3.0, 3.5]);
    }

    #[test]
    fn output_gains_apply_per_source_and_reset() {
        let settings = Settings::default();
        assert_eq!(settings.output_gain(7), 1.0);
        settings.set_output_gains(&[(7, 0.25), (9, 5.0), (0, 0.5)]);
        assert_eq!(settings.output_gain(7), 0.25);
        assert_eq!(settings.output_gain(9), MAX_OUTPUT_GAIN, "clamped");
        assert_eq!(settings.output_gain(0), 1.0, "id 0 is never stored");
        settings.set_output_gains(&[(9, 0.5)]);
        assert_eq!(settings.output_gain(7), 1.0, "dropped entries reset to unity");
    }

    #[test]
    fn playback_applies_source_gain_and_reports_levels() {
        let (tx, rxq) = sync_channel::<RxPacket>(8);
        let shared = Arc::new(Shared::default());
        shared.settings.set_output_gains(&[(10, 0.0)]);
        let mut playback = Playback::new(rxq, 1, Arc::clone(&shared)).unwrap();
        let frames = encode_frames(1, 240);
        tx.send(rx(10, 0, &frames[0])).unwrap();
        tx.send(rx(20, 0, &frames[0])).unwrap();
        let mut out = vec![0.0f32; 240];
        playback.on_output(&mut out);
        let event = shared.levels.take_event();
        let level = |id| event.sources.iter().find(|s| s.source_id == id).map(|s| s.peak);
        assert_eq!(level(10), None, "muted source reports no level");
        assert!(level(20).unwrap() > 0.0);
        assert!(event.output_peak > 0.0);
        assert_eq!(shared.levels.take_event().output_peak, 0.0, "drained");
    }

    #[test]
    fn capture_applies_gain_and_gate() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.connect(socket.local_addr().unwrap()).unwrap();
        let shared = Arc::new(Shared::default());
        shared.mic_active.store(true, Ordering::Relaxed);
        let mut capture = new_capture(&socket, UDP_VERSION_2, 1, 240, 2, &shared).unwrap();

        shared.settings.input_gain_bits.store(2.0f32.to_bits(), Ordering::Relaxed);
        capture.on_input(&[0.25, 0.0, -0.25, 0.0]);
        assert!((shared.levels.take_event().input_peak - 0.5).abs() < 1e-6);

        // Gate closed for a quiet signal: nothing passes.
        shared.settings.gate_enabled.store(true, Ordering::Relaxed);
        capture.gate_envelope = 0.0;
        let quiet = vec![0.001f32; 480];
        capture.on_input(&quiet);
        assert!(shared.levels.take_event().input_peak < 1e-4);
    }

    /// End-to-end on real hardware: starts the engine against a local fake
    /// relay that echoes loopback frames, then runs the latency test. Needs
    /// an acoustic or cable path from the default output to the default
    /// input. Plays audible clicks. Run manually:
    /// `cargo test -- --ignored --nocapture engine_hardware_latency`
    /// (set KESHER_NATIVE_AUDIO_BACKEND=exclusive|shared|system to compare).
    #[tokio::test]
    #[ignore]
    async fn engine_hardware_latency() {
        let relay = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = relay.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            while let Ok((n, from)) = relay.recv_from(&mut buf) {
                let Some(pkt) = parse_header(&buf[..n]) else { continue };
                if pkt.flags & UDP_FLAG_LOOPBACK == 0 {
                    continue;
                }
                let mut out = vec![0u8; UDP_HEADER_LEN_V2 + pkt.payload.len()];
                out[..UDP_HEADER_LEN_V2].copy_from_slice(&buf[..UDP_HEADER_LEN_V2]);
                out[5] = UDP_FLAG_AUDIO;
                out[16..20].copy_from_slice(&1234u32.to_be_bytes());
                out[UDP_HEADER_LEN_V2..].copy_from_slice(pkt.payload);
                let _ = relay.send_to(&out, from);
            }
        });
        let state = NativeAudioState::default();
        let peaks = Arc::new(Mutex::new((0.0f32, 0.0f32)));
        let sink_peaks = Arc::clone(&peaks);
        let sink: LevelSink = Box::new(move |e| {
            let mut p = sink_peaks.lock().unwrap();
            p.0 = p.0.max(e.input_peak);
            p.1 = p.1.max(e.output_peak);
        });
        let info = start_engine(
            StartNativeParams {
                server_host: "127.0.0.1".into(),
                server_port: port,
                session_token: "test".into(),
                token_hash: 1,
                input_device_id: None,
                output_device_id: None,
                protocol_version: Some(UDP_VERSION_2),
                frame_duration_ms: Some(5.0),
                audio_backend: None,
            },
            &state,
            Some(sink),
        )
        .await
        .expect("engine start");
        println!("engine: {info:?}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        for _ in 0..3 {
            *peaks.lock().unwrap() = (0.0, 0.0);
            let ms = run_latency_test(&state).await.unwrap();
            let (input_peak, output_peak) = *peaks.lock().unwrap();
            println!("mouth-to-ear: {ms:?} ms (output peak {output_peak:.3}, mic peak {input_peak:.3})");
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        stop_engine(&state).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
