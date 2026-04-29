/// Native audio engine for the Kesher desktop app.
///
/// Architecture:
///   Capture:  CPAL input → raw PCM f32 mono 48 kHz
///             → Opus encode (10 ms frames, CBR 48 kbps, in-band FEC)
///             → webrtc-rs RTP → UDP to Go SFU
///
///   Playback: UDP from Go SFU → webrtc-rs RTP
///             → Opus decode → raw PCM f32 mono 48 kHz
///             → CPAL output (per-source with gain)
///
/// The JS side (WebView) keeps signaling (WebSocket) and PTT state.
/// This module receives commands via Tauri IPC and emits events back.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus::{Application, Channels, Decoder, Encoder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex, RwLock,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors,
        media_engine::{MediaEngine, MIME_TYPE_OPUS},
        APIBuilder,
    },
    ice_transport::ice_server::RTCIceServer,
    interceptor::registry::Registry,
    media::Sample,
    peer_connection::{
        configuration::RTCConfiguration,
        sdp::session_description::RTCSessionDescription,
        RTCPeerConnection,
    },
    rtp_transceiver::{
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
        rtp_transceiver_direction::RTCRtpTransceiverDirection,
        RTCRtpTransceiverInit,
    },
    stats::{StatsReport, StatsReportType},
    track::{
        track_local::{track_local_static_sample::TrackLocalStaticSample, TrackLocal},
        track_remote::TrackRemote,
    },
};

// ── Constants ────────────────────────────────────────────────────────────────

/// 48 kHz mono – same as the SFU
const SAMPLE_RATE: u32 = 48_000;
/// 10 ms frames at 48 kHz = 480 samples
const OPUS_FRAME_SIZE: usize = 480;
/// Maximum encoded Opus packet size (bytes)
const MAX_OPUS_PACKET: usize = 256;
/// Default target bitrate in bits/s
const OPUS_BITRATE: i32 = 48_000;
/// Adaptive bitrate bounds and steps in bits/s.
const OPUS_BITRATE_MIN: i32 = 32_000;
const OPUS_BITRATE_MAX: i32 = 56_000;
const OPUS_BITRATE_STEP_DOWN: i32 = 8_000;
const OPUS_BITRATE_STEP_UP: i32 = 4_000;
const OPUS_ADAPT_GOOD_INTERVALS_FOR_STEP_UP: u32 = 2;
const STATS_POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy)]
struct AudioAdaptConfig {
    name: &'static str,
    initial_bitrate: i32,
    bitrate_min: i32,
    bitrate_max: i32,
    step_down: i32,
    step_up: i32,
    stable_intervals_for_step_up: u32,
    congested_raw_max_ms: f64,
    congested_raw_avg_ms: f64,
    stable_raw_max_ms: f64,
    stable_raw_avg_ms: f64,
    stats_loss_warn: f64,
    stats_loss_bad: f64,
    stats_loss_severe: f64,
    stats_rtt_warn_s: f64,
    stats_rtt_bad_s: f64,
    stats_rtt_severe_s: f64,
}

const AUDIO_ADAPT_BALANCED: AudioAdaptConfig = AudioAdaptConfig {
    name: "balanced",
    initial_bitrate: OPUS_BITRATE,
    bitrate_min: OPUS_BITRATE_MIN,
    bitrate_max: OPUS_BITRATE_MAX,
    step_down: OPUS_BITRATE_STEP_DOWN,
    step_up: OPUS_BITRATE_STEP_UP,
    stable_intervals_for_step_up: OPUS_ADAPT_GOOD_INTERVALS_FOR_STEP_UP,
    congested_raw_max_ms: 20.0,
    congested_raw_avg_ms: 8.0,
    stable_raw_max_ms: 8.0,
    stable_raw_avg_ms: 3.0,
    stats_loss_warn: 0.01,
    stats_loss_bad: 0.03,
    stats_loss_severe: 0.08,
    stats_rtt_warn_s: 0.12,
    stats_rtt_bad_s: 0.20,
    stats_rtt_severe_s: 0.35,
};

const AUDIO_ADAPT_ULTRA_LOW_LATENCY: AudioAdaptConfig = AudioAdaptConfig {
    name: "ultra-low-latency",
    initial_bitrate: 44_000,
    bitrate_min: 28_000,
    bitrate_max: 52_000,
    step_down: 8_000,
    step_up: 4_000,
    stable_intervals_for_step_up: 3,
    congested_raw_max_ms: 14.0,
    congested_raw_avg_ms: 6.0,
    stable_raw_max_ms: 6.0,
    stable_raw_avg_ms: 2.5,
    stats_loss_warn: 0.015,
    stats_loss_bad: 0.04,
    stats_loss_severe: 0.10,
    stats_rtt_warn_s: 0.10,
    stats_rtt_bad_s: 0.16,
    stats_rtt_severe_s: 0.30,
};

const AUDIO_ADAPT_ROBUST_WLAN: AudioAdaptConfig = AudioAdaptConfig {
    name: "robust-wlan",
    initial_bitrate: 40_000,
    bitrate_min: 24_000,
    bitrate_max: 52_000,
    step_down: 6_000,
    step_up: 3_000,
    stable_intervals_for_step_up: 4,
    congested_raw_max_ms: 24.0,
    congested_raw_avg_ms: 10.0,
    stable_raw_max_ms: 10.0,
    stable_raw_avg_ms: 4.0,
    stats_loss_warn: 0.008,
    stats_loss_bad: 0.025,
    stats_loss_severe: 0.06,
    stats_rtt_warn_s: 0.14,
    stats_rtt_bad_s: 0.24,
    stats_rtt_severe_s: 0.45,
};
/// Input mic gain range: 1.0 = unity, 2.0 = +6 dB, 8.0 = +18 dB,
/// 16.0 = +24 dB (global +6 dB base boost plus +18 dB slider).
const MIN_INPUT_GAIN: f32 = 0.0;
const MAX_INPUT_GAIN: f32 = 16.0;
const DEFAULT_INPUT_GAIN: f32 = 1.0;
const MIN_OUTPUT_GAIN: f32 = 0.0;
const MAX_OUTPUT_GAIN: f32 = 2.0;
const DEFAULT_OUTPUT_GAIN: f32 = 1.0;
const DEFAULT_AUDIO_GATE_ENABLED: bool = false;
const MIN_AUDIO_GATE_THRESHOLD_DB: f32 = -72.0;
const MAX_AUDIO_GATE_THRESHOLD_DB: f32 = -12.0;
const DEFAULT_AUDIO_GATE_THRESHOLD_DB: f32 = -52.0;
/// Gate attack time in milliseconds (how fast the gate opens on signal)
const GATE_ATTACK_TIME_MS: f32 = 10.0;
/// Gate release time in milliseconds (how fast the gate closes after signal stops)
const GATE_RELEASE_TIME_MS: f32 = 150.0;
/// Queue depth between CPAL capture callback and Opus encoder thread.
const CAPTURE_RAW_QUEUE_CAPACITY: usize = 4;
/// Queue depth between Opus encoder thread and async WebRTC sender.
const CAPTURE_ENCODED_QUEUE_CAPACITY: usize = 16;
/// Queue depth between async RTP reader and Opus decoder thread.
/// Increased from 8 to 16 (80 ms → 160 ms) to tolerate network jitter better.
const PLAYBACK_OPUS_QUEUE_CAPACITY: usize = 16;
/// Queue depth between Opus decoder thread and CPAL output callback.
/// Increased from 8 to 16 (80 ms → 160 ms) to reduce underruns on timing jitter.
const PLAYBACK_PCM_QUEUE_CAPACITY: usize = 16;
/// Throttled log interval to avoid spamming on sustained frame drops.
const DROP_LOG_EVERY: u32 = 200;
/// Periodic interval for latency telemetry logs.
const LATENCY_LOG_INTERVAL: Duration = Duration::from_secs(5);

struct EncodedFrame {
    data: bytes::Bytes,
    encoded_at: Instant,
}

struct OpusFrame {
    payload: Vec<u8>,
    received_at: Instant,
}

struct PcmFrame {
    samples: Vec<f32>,
    decoded_at: Instant,
}

#[derive(Default)]
struct AtomicLatencyStats {
    sum_us: AtomicU64,
    count: AtomicU64,
    max_us: AtomicU64,
}

impl AtomicLatencyStats {
    fn record(&self, d: Duration) {
        let us = d.as_micros() as u64;
        self.sum_us.fetch_add(us, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
    }

    fn snapshot_and_reset(&self) -> Option<(f64, f64, u64)> {
        let count = self.count.swap(0, Ordering::Relaxed);
        if count == 0 {
            let _ = self.sum_us.swap(0, Ordering::Relaxed);
            let _ = self.max_us.swap(0, Ordering::Relaxed);
            return None;
        }
        let sum_us = self.sum_us.swap(0, Ordering::Relaxed);
        let max_us = self.max_us.swap(0, Ordering::Relaxed);
        let avg_ms = (sum_us as f64 / count as f64) / 1000.0;
        let max_ms = max_us as f64 / 1000.0;
        Some((avg_ms, max_ms, count))
    }
}

// ── Public serialisable types (IPC) ─────────────────────────────────────────

/// One audio device entry returned to JavaScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub kind: String, // "audioinput" | "audiooutput"
}

/// sdpOffer + gathered ICE candidates from the server, passed to start_audio_engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartEngineParams {
    pub offer_sdp: String,
    pub output_device_id: Option<String>,
    pub input_device_id: Option<String>,
    pub input_gain: Option<f32>,
    pub audio_gate_enabled: Option<bool>,
    pub audio_gate_threshold_db: Option<f32>,
    pub adaptation_profile: Option<String>,
}

/// Answer SDP + ICE candidates emitted back to JavaScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineAnswerPayload {
    pub answer_sdp: String,
    pub ice_candidates: Vec<String>, // JSON-encoded RTCIceCandidateInit objects
}

/// Level meters emitted every ~50 ms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelMeterEvent {
    pub input_peak: f32,
    pub output_peak: f32,
}

// ── Shared state ─────────────────────────────────────────────────────────────

/// State managed by the Tauri app state system so IPC commands can reach it.
pub struct AudioEngineState {
    pub engine: Mutex<Option<RunningEngine>>,
}

impl Default for AudioEngineState {
    fn default() -> Self {
        Self {
            engine: Mutex::new(None),
        }
    }
}

/// A running engine instance — kept alive as long as the session is active.
pub struct RunningEngine {
    pub peer_connection: Arc<RTCPeerConnection>,
    pub ptt_active: Arc<AtomicBool>,
    pub audio_processing: Arc<AudioProcessingState>,
    pub output_routing: Arc<OutputRoutingState>,
    pub output_device_id: Arc<RwLock<Option<String>>>,
    /// Dropping this sender shuts down the capture/encode/send loop.
    _shutdown: mpsc::Sender<()>,
}

pub struct AudioProcessingState {
    input_gain_bits: AtomicU32,
    audio_gate_enabled: AtomicBool,
    audio_gate_threshold_bits: AtomicU32,
}

pub struct OutputRoutingState {
    output_gain_by_user_id: RwLock<HashMap<String, f32>>,
}

impl OutputRoutingState {
    fn new() -> Self {
        Self {
            output_gain_by_user_id: RwLock::new(HashMap::new()),
        }
    }

    fn set_output_gains(&self, gains_by_user_id: HashMap<String, f32>) {
        let mut next = HashMap::with_capacity(gains_by_user_id.len());
        for (user_id, gain) in gains_by_user_id {
            if user_id.trim().is_empty() {
                continue;
            }
            next.insert(user_id, clamp_output_gain(gain));
        }
        if let Ok(mut map) = self.output_gain_by_user_id.write() {
            *map = next;
        }
    }

    fn gain_for_user(&self, user_id: &str) -> f32 {
        if user_id.is_empty() {
            return DEFAULT_OUTPUT_GAIN;
        }
        if let Ok(map) = self.output_gain_by_user_id.read() {
            return map
                .get(user_id)
                .copied()
                .unwrap_or(DEFAULT_OUTPUT_GAIN);
        }
        DEFAULT_OUTPUT_GAIN
    }
}

impl AudioProcessingState {
    fn new(input_gain: f32, audio_gate_enabled: bool, audio_gate_threshold_db: f32) -> Self {
        Self {
            input_gain_bits: AtomicU32::new(input_gain.to_bits()),
            audio_gate_enabled: AtomicBool::new(audio_gate_enabled),
            audio_gate_threshold_bits: AtomicU32::new(audio_gate_threshold_db.to_bits()),
        }
    }

    fn input_gain(&self) -> f32 {
        f32::from_bits(self.input_gain_bits.load(Ordering::Relaxed))
    }

    fn set_input_gain(&self, gain: f32) {
        self.input_gain_bits
            .store(clamp_input_gain(gain).to_bits(), Ordering::Relaxed);
    }

    fn audio_gate_enabled(&self) -> bool {
        self.audio_gate_enabled.load(Ordering::Relaxed)
    }

    fn set_audio_gate_enabled(&self, enabled: bool) {
        self.audio_gate_enabled.store(enabled, Ordering::Relaxed);
    }

    fn audio_gate_threshold_db(&self) -> f32 {
        f32::from_bits(self.audio_gate_threshold_bits.load(Ordering::Relaxed))
    }

    fn set_audio_gate_threshold_db(&self, threshold_db: f32) {
        self.audio_gate_threshold_bits.store(
            clamp_audio_gate_threshold_db(threshold_db).to_bits(),
            Ordering::Relaxed,
        );
    }
}

fn clamp_input_gain(gain: f32) -> f32 {
    if !gain.is_finite() {
        return DEFAULT_INPUT_GAIN;
    }
    gain.max(MIN_INPUT_GAIN).min(MAX_INPUT_GAIN)
}

fn clamp_audio_gate_threshold_db(threshold_db: f32) -> f32 {
    if !threshold_db.is_finite() {
        return DEFAULT_AUDIO_GATE_THRESHOLD_DB;
    }
    threshold_db
        .max(MIN_AUDIO_GATE_THRESHOLD_DB)
        .min(MAX_AUDIO_GATE_THRESHOLD_DB)
}

fn clamp_output_gain(gain: f32) -> f32 {
    if !gain.is_finite() {
        return DEFAULT_OUTPUT_GAIN;
    }
    gain.max(MIN_OUTPUT_GAIN).min(MAX_OUTPUT_GAIN)
}

fn source_user_id_from_track_id(track_id: &str) -> Option<String> {
    const PREFIX: &str = "audio-user-";
    track_id
        .strip_prefix(PREFIX)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn packet_loss_hint_for_bitrate(bitrate: i32) -> i32 {
    if bitrate <= 36_000 {
        15
    } else if bitrate <= 44_000 {
        10
    } else {
        5
    }
}

fn adapt_config_from_name(name: &str) -> AudioAdaptConfig {
    match name.trim().to_ascii_lowercase().as_str() {
        "ultra" | "ultralowlatency" | "ultra-low-latency" | "low-latency" => {
            AUDIO_ADAPT_ULTRA_LOW_LATENCY
        }
        "robust" | "robust-wlan" | "wlan" | "wifi" => AUDIO_ADAPT_ROBUST_WLAN,
        _ => AUDIO_ADAPT_BALANCED,
    }
}

#[derive(Debug, Deserialize)]
struct DesktopAudioYamlConfig {
    desktop_audio_adaptation_profile: Option<String>,
}

fn parse_audio_profile_from_yaml(raw: &str) -> Option<String> {
    let parsed: DesktopAudioYamlConfig = serde_yaml::from_str(raw).ok()?;
    parsed
        .desktop_audio_adaptation_profile
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_yaml_config_path() -> Option<String> {
    let from_env = std::env::var("APP_CONFIG_FILE")
        .ok()
        .or_else(|| std::env::var("CONFIG_FILE").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if from_env.is_some() {
        return from_env;
    }

    for candidate in ["config.yaml", "config.yml"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }

    None
}

fn resolve_audio_profile_from_yaml() -> Option<String> {
    let path = resolve_yaml_config_path()?;
    let raw = fs::read_to_string(path).ok()?;
    parse_audio_profile_from_yaml(&raw)
}

fn resolve_adapt_config(requested_profile: Option<&str>) -> AudioAdaptConfig {
    if let Some(value) = requested_profile {
        return adapt_config_from_name(value);
    }
    if let Ok(value) = std::env::var("KESHER_AUDIO_PROFILE") {
        return adapt_config_from_name(&value);
    }
    if let Some(value) = resolve_audio_profile_from_yaml() {
        return adapt_config_from_name(&value);
    }
    AUDIO_ADAPT_BALANCED
}

fn normalize_fraction_lost(raw_fraction_lost: f64) -> f64 {
    if raw_fraction_lost > 1.0 {
        (raw_fraction_lost / 256.0).clamp(0.0, 1.0)
    } else {
        raw_fraction_lost.clamp(0.0, 1.0)
    }
}

fn pressure_from_remote_inbound_stats(stats: &StatsReport, cfg: AudioAdaptConfig) -> u8 {
    let mut max_loss = 0.0_f64;
    let mut max_rtt_s = 0.0_f64;
    let mut seen_audio = false;

    for report in stats.reports.values() {
        if let StatsReportType::RemoteInboundRTP(remote) = report {
            if remote.kind != "audio" {
                continue;
            }
            seen_audio = true;
            max_loss = max_loss.max(normalize_fraction_lost(remote.fraction_lost));
            if let Some(rtt) = remote.round_trip_time {
                max_rtt_s = max_rtt_s.max(rtt.max(0.0));
            }
        }
    }

    if !seen_audio {
        return 0;
    }

    if max_loss >= cfg.stats_loss_severe || max_rtt_s >= cfg.stats_rtt_severe_s {
        3
    } else if max_loss >= cfg.stats_loss_bad || max_rtt_s >= cfg.stats_rtt_bad_s {
        2
    } else if max_loss >= cfg.stats_loss_warn || max_rtt_s >= cfg.stats_rtt_warn_s {
        1
    } else {
        0
    }
}

fn dbfs_to_linear_amplitude(dbfs: f32) -> f32 {
    10.0f32.powf(clamp_audio_gate_threshold_db(dbfs) / 20.0)
}

/// Computes one-pole lowpass coefficient for gate attack/release smoothing.
/// Uses formula: coeff = 1.0 - exp(-2π * fc * dt)
/// where fc is cutoff frequency (1/time_constant_ms) and dt is 1/sample_rate
fn compute_gate_coefficient(sample_rate: f32, time_ms: f32) -> f32 {
    let time_s = time_ms / 1000.0;
    let freq_hz = 1.0 / time_s;
    1.0 - (-2.0 * std::f32::consts::PI * freq_hz / sample_rate).exp()
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_audio_gate_threshold_db, clamp_input_gain, clamp_output_gain,
        dbfs_to_linear_amplitude, parse_audio_profile_from_yaml,
        DEFAULT_AUDIO_GATE_THRESHOLD_DB, DEFAULT_INPUT_GAIN, MAX_AUDIO_GATE_THRESHOLD_DB,
        MAX_INPUT_GAIN, MAX_OUTPUT_GAIN, MIN_AUDIO_GATE_THRESHOLD_DB, MIN_INPUT_GAIN,
        MIN_OUTPUT_GAIN,
    };

    #[test]
    fn clamp_input_gain_bounds() {
        assert_eq!(clamp_input_gain(-1.0), MIN_INPUT_GAIN);
        assert_eq!(clamp_input_gain(0.5), 0.5);
        assert_eq!(clamp_input_gain(8.0), 8.0);
        assert_eq!(clamp_input_gain(64.0), MAX_INPUT_GAIN);
    }

    #[test]
    fn clamp_input_gain_non_finite_defaults() {
        assert_eq!(clamp_input_gain(f32::NAN), DEFAULT_INPUT_GAIN);
        assert_eq!(clamp_input_gain(f32::INFINITY), DEFAULT_INPUT_GAIN);
        assert_eq!(clamp_input_gain(f32::NEG_INFINITY), DEFAULT_INPUT_GAIN);
    }

    #[test]
    fn clamp_audio_gate_threshold_bounds() {
        assert_eq!(
            clamp_audio_gate_threshold_db(-100.0),
            MIN_AUDIO_GATE_THRESHOLD_DB
        );
        assert_eq!(clamp_audio_gate_threshold_db(-42.0), -42.0);
        assert_eq!(
            clamp_audio_gate_threshold_db(0.0),
            MAX_AUDIO_GATE_THRESHOLD_DB
        );
    }

    #[test]
    fn clamp_audio_gate_threshold_non_finite_defaults() {
        assert_eq!(
            clamp_audio_gate_threshold_db(f32::NAN),
            DEFAULT_AUDIO_GATE_THRESHOLD_DB
        );
    }

    #[test]
    fn converts_dbfs_threshold_to_linear_amplitude() {
        let amplitude = dbfs_to_linear_amplitude(-40.0);
        assert!(amplitude > 0.009 && amplitude < 0.011);
    }

    #[test]
    fn gate_coefficients_are_reasonable() {
        // Attack should be faster than release (higher coefficient)
        let attack = super::compute_gate_coefficient(48000.0, super::GATE_ATTACK_TIME_MS);
        let release = super::compute_gate_coefficient(48000.0, super::GATE_RELEASE_TIME_MS);
        
        assert!(attack > 0.0 && attack <= 1.0, "Attack coefficient should be in [0,1]");
        assert!(release > 0.0 && release <= 1.0, "Release coefficient should be in [0,1]");
        assert!(attack > release, "Attack should be faster (higher coeff) than release");
    }

    #[test]
    fn clamp_output_gain_bounds() {
        assert_eq!(clamp_output_gain(-1.0), MIN_OUTPUT_GAIN);
        assert_eq!(clamp_output_gain(0.5), 0.5);
        assert_eq!(clamp_output_gain(1.0), 1.0);
        assert_eq!(clamp_output_gain(99.0), MAX_OUTPUT_GAIN);
    }

    #[test]
    fn parses_audio_profile_from_yaml() {
        let yaml = "desktop_audio_adaptation_profile: robust-wlan\n";
        assert_eq!(parse_audio_profile_from_yaml(yaml).as_deref(), Some("robust-wlan"));
    }

    #[test]
    fn parses_audio_profile_from_yaml_returns_none_when_missing() {
        let yaml = "app_addr: \":8080\"\n";
        assert!(parse_audio_profile_from_yaml(yaml).is_none());
    }
}

// ── Device enumeration ────────────────────────────────────────────────────────

/// List all available audio input and output devices.
pub fn enumerate_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    if let Ok(inputs) = host.input_devices() {
        for device in inputs {
            let name = device.name().unwrap_or_default();
            devices.push(AudioDeviceInfo {
                id: name.clone(),
                name,
                kind: "audioinput".to_string(),
            });
        }
    }

    if let Ok(outputs) = host.output_devices() {
        for device in outputs {
            let name = device.name().unwrap_or_default();
            devices.push(AudioDeviceInfo {
                id: name.clone(),
                name,
                kind: "audiooutput".to_string(),
            });
        }
    }

    devices
}

// ── Engine lifecycle ──────────────────────────────────────────────────────────

/// Build an `RTCPeerConnection`, set the server's offer as remote description,
/// collect ICE candidates, create an answer, and return both.
///
/// Called from the `start_audio_engine` Tauri command inside a Tokio task.
pub async fn start_engine(
    app: AppHandle,
    params: StartEngineParams,
    state: tauri::State<'_, AudioEngineState>,
) -> Result<EngineAnswerPayload, String> {
    // ── 1. Build MediaEngine with Opus only ───────────────────────────────
    let mut me = MediaEngine::default();
    me.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48_000,
                channels: 1,
                sdp_fmtp_line:
                    "minptime=10;useinbandfec=1;usedtx=0;stereo=0;cbr=1;maxaveragebitrate=48000"
                        .to_owned(),
                ..Default::default()
            },
            payload_type: 111,
            ..Default::default()
        },
        RTPCodecType::Audio,
    )
    .map_err(|e| format!("register codec: {e}"))?;

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut me)
        .map_err(|e| format!("interceptors: {e}"))?;

    let api = APIBuilder::new()
        .with_media_engine(me)
        .with_interceptor_registry(registry)
        .build();

    // ── 2. Create PeerConnection ──────────────────────────────────────────
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec![], // LAN only – no STUN required
            ..Default::default()
        }],
        ..Default::default()
    };

    let pc = Arc::new(
        api.new_peer_connection(config)
            .await
            .map_err(|e| format!("new peer connection: {e}"))?,
    );

    // ── 3. Add send track (our microphone → SFU) ──────────────────────────
    let audio_track = Arc::new(
        TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48_000,
                channels: 1,
                ..Default::default()
            },
            "audio".to_owned(),
            "kesher-desktop".to_owned(),
        ),
    );

    let _rtp_sender = pc
        .add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add track: {e}"))?;

    // ── 4. Add receive transceiver (SFU → us) ────────────────────────────
    pc.add_transceiver_from_kind(
        RTPCodecType::Audio,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Recvonly,
            send_encodings: vec![],
        }),
    )
    .await
    .map_err(|e| format!("add recv transceiver: {e}"))?;

    // ── 5. Collect ICE candidates ─────────────────────────────────────────
    let ice_candidates: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let ice_candidates_clone = Arc::clone(&ice_candidates);
    let ice_done = Arc::new(AtomicBool::new(false));
    let ice_done_clone = Arc::clone(&ice_done);

    pc.on_ice_candidate(Box::new(move |c| {
        let ice_candidates_clone = Arc::clone(&ice_candidates_clone);
        let ice_done_clone = Arc::clone(&ice_done_clone);
        Box::pin(async move {
            if let Some(candidate) = c {
                if let Ok(init) = candidate.to_json() {
                    if let Ok(json) = serde_json::to_string(&init) {
                        ice_candidates_clone.lock().unwrap().push(json);
                    }
                }
            } else {
                // nil candidate = gathering complete
                ice_done_clone.store(true, Ordering::SeqCst);
            }
        })
    }));

    // ── 6. Set remote offer, create answer ────────────────────────────────
    let offer = RTCSessionDescription::offer(params.offer_sdp)
        .map_err(|e| format!("parse offer: {e}"))?;

    pc.set_remote_description(offer)
        .await
        .map_err(|e| format!("set remote description: {e}"))?;

    let answer = pc
        .create_answer(None)
        .await
        .map_err(|e| format!("create answer: {e}"))?;

    let mut gather_complete = pc.gathering_complete_promise().await;

    pc.set_local_description(answer)
        .await
        .map_err(|e| format!("set local description: {e}"))?;

    // Wait until ICE gathering is complete
    let _ = gather_complete.recv().await;

    let local_desc = pc
        .local_description()
        .await
        .ok_or("no local description after gathering")?;

    let collected_candidates = ice_candidates.lock().unwrap().clone();

    // ── 8. Wire up capture → encode → send ───────────────────────────────
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);
    let ptt_active = Arc::new(AtomicBool::new(false));

    let input_gain = clamp_input_gain(params.input_gain.unwrap_or(DEFAULT_INPUT_GAIN));
    let audio_gate_enabled = params
        .audio_gate_enabled
        .unwrap_or(DEFAULT_AUDIO_GATE_ENABLED);
    let audio_gate_threshold_db = clamp_audio_gate_threshold_db(
        params
            .audio_gate_threshold_db
            .unwrap_or(DEFAULT_AUDIO_GATE_THRESHOLD_DB),
    );
    let audio_processing = Arc::new(AudioProcessingState::new(
        input_gain,
        audio_gate_enabled,
        audio_gate_threshold_db,
    ));
    let output_routing = Arc::new(OutputRoutingState::new());
    let output_device_id = Arc::new(RwLock::new(params.output_device_id.clone()));
    let adapt_config = resolve_adapt_config(params.adaptation_profile.as_deref());
    log::info!("[audio][adapt] profile={}", adapt_config.name);
    let network_stress_playback = Arc::new(AtomicU8::new(0));
    let network_stress_stats = Arc::new(AtomicU8::new(0));

    // ── 7. Wire up incoming tracks for playback ───────────────────────────
    let app_clone = app.clone();
    let output_routing_for_track = Arc::clone(&output_routing);
    let output_device_id_for_track = Arc::clone(&output_device_id);
    let network_stress_for_track = Arc::clone(&network_stress_playback);
    pc.on_track(Box::new(move |track, _receiver, _transceiver| {
        let app_clone = app_clone.clone();
        let output_routing_for_track = Arc::clone(&output_routing_for_track);
        let output_device_id_for_track = Arc::clone(&output_device_id_for_track);
        let network_stress_for_track = Arc::clone(&network_stress_for_track);
        Box::pin(async move {
            let track_id = track.id();
            let source_user_id = source_user_id_from_track_id(&track_id);
            tokio::spawn(playback_loop(
                track,
                source_user_id,
                output_routing_for_track,
                output_device_id_for_track,
                network_stress_for_track,
                app_clone,
            ));
        })
    }));

    tokio::spawn(capture_loop(
        Arc::clone(&pc),
        audio_track,
        Arc::clone(&ptt_active),
        params.input_device_id,
        Arc::clone(&audio_processing),
        Arc::clone(&network_stress_playback),
        Arc::clone(&network_stress_stats),
        adapt_config,
        app.clone(),
        shutdown_rx,
    ));

    // ── 9. Persist engine state ───────────────────────────────────────────
    {
        let engine = RunningEngine {
            peer_connection: Arc::clone(&pc),
            ptt_active: Arc::clone(&ptt_active),
            audio_processing: Arc::clone(&audio_processing),
            output_routing: Arc::clone(&output_routing),
            output_device_id: Arc::clone(&output_device_id),
            _shutdown: shutdown_tx,
        };
        *state.engine.lock().unwrap() = Some(engine);
    }

    Ok(EngineAnswerPayload {
        answer_sdp: local_desc.sdp,
        ice_candidates: collected_candidates,
    })
}

// ── Capture loop ──────────────────────────────────────────────────────────────

/// Reads PCM from the CPAL input device, Opus-encodes it, and writes
/// samples to the WebRTC send track.  Respects the PTT gate.
async fn capture_loop(
    peer_connection: Arc<RTCPeerConnection>,
    track: Arc<TrackLocalStaticSample>,
    ptt_active: Arc<AtomicBool>,
    device_id: Option<String>,
    audio_processing: Arc<AudioProcessingState>,
    network_stress_playback: Arc<AtomicU8>,
    network_stress_stats: Arc<AtomicU8>,
    adapt_config: AudioAdaptConfig,
    app: AppHandle,
    mut shutdown: mpsc::Receiver<()>,
) {
    // ── Sync thread: owns !Send cpal::Stream + Opus encoder ─────────────
    // encoded bytes flow: sync thread → tokio channel → async WebRTC sender
    let (encoded_tx, mut encoded_rx) = mpsc::channel::<EncodedFrame>(CAPTURE_ENCODED_QUEUE_CAPACITY);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop_flag);
    let ptt_clone = Arc::clone(&ptt_active);
    let app_clone = app.clone();
    let network_stress_playback_for_thread = Arc::clone(&network_stress_playback);
    let network_stress_stats_for_thread = Arc::clone(&network_stress_stats);

    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match find_input_device(&host, device_id.as_deref()) {
            Some(d) => d,
            None => { log::error!("[audio] capture: no input device"); return; }
        };
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(SAMPLE_RATE),
            buffer_size: cpal::BufferSize::Fixed(OPUS_FRAME_SIZE as u32),
        };
        let (raw_tx, raw_rx) =
            std::sync::mpsc::sync_channel::<(Vec<f32>, Instant)>(CAPTURE_RAW_QUEUE_CAPACITY);
        let mut dropped_capture_frames: u32 = 0;
        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                if raw_tx.try_send((data.to_vec(), Instant::now())).is_err() {
                    dropped_capture_frames = dropped_capture_frames.saturating_add(1);
                    if dropped_capture_frames % DROP_LOG_EVERY == 0 {
                        log::warn!(
                            "[audio] capture queue full, dropped frames={} (queue={})",
                            dropped_capture_frames,
                            CAPTURE_RAW_QUEUE_CAPACITY
                        );
                    }
                }
            },
            |err| log::error!("[audio] capture stream error: {err}"),
            None,
        ) {
            Ok(s) => s,
            Err(e) => { log::error!("[audio] build input stream: {e}"); return; }
        };
        if let Err(e) = stream.play() {
            log::error!("[audio] start capture stream: {e}"); return;
        }
        let mut encoder = match Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip) {
            Ok(e) => e,
            Err(e) => { log::error!("[audio] create encoder: {e}"); return; }
        };
        let _ = encoder.set_bitrate(opus::Bitrate::Bits(adapt_config.initial_bitrate));
        let _ = encoder.set_vbr(false);
        let _ = encoder.set_inband_fec(true);
        let _ = encoder.set_packet_loss_perc(packet_loss_hint_for_bitrate(adapt_config.initial_bitrate));
        let _ = encoder.set_dtx(false);
        let mut current_bitrate = adapt_config.initial_bitrate;
        let mut stable_intervals: u32 = 0;
        let mut last_dropped_encoded_frames: u32 = 0;

        let mut pcm_accum: Vec<f32> = Vec::with_capacity(OPUS_FRAME_SIZE * 4);
        let mut buf = [0u8; MAX_OPUS_PACKET];
        let silence = vec![0.0f32; OPUS_FRAME_SIZE];
        let mut input_peak = 0.0f32;
        let mut meter_frames: u32 = 0;
        let mut dropped_encoded_frames: u32 = 0;
        let mut raw_queue_count: u64 = 0;
        let mut raw_queue_sum_ms: f64 = 0.0;
        let mut raw_queue_max_ms: f64 = 0.0;
        let mut next_latency_log = Instant::now() + LATENCY_LOG_INTERVAL;
        
        // Gate envelope for smooth attack/release (0.0 = fully muted, 1.0 = fully open)
        let mut gate_envelope: f32 = 0.0;
        // Precompute coefficients (attack and release)
        let attack_coeff = compute_gate_coefficient(SAMPLE_RATE as f32, GATE_ATTACK_TIME_MS);
        let release_coeff = compute_gate_coefficient(SAMPLE_RATE as f32, GATE_RELEASE_TIME_MS);

        loop {
            if stop_clone.load(Ordering::Relaxed) { break; }
            match raw_rx.recv_timeout(std::time::Duration::from_millis(20)) {
                Ok((chunk, captured_at)) => {
                    let raw_queue_ms = captured_at.elapsed().as_secs_f64() * 1000.0;
                    raw_queue_count += 1;
                    raw_queue_sum_ms += raw_queue_ms;
                    if raw_queue_ms > raw_queue_max_ms {
                        raw_queue_max_ms = raw_queue_ms;
                    }

                    let input_gain = audio_processing.input_gain();
                    let audio_gate_enabled = audio_processing.audio_gate_enabled();
                    let audio_gate_threshold =
                        dbfs_to_linear_amplitude(audio_processing.audio_gate_threshold_db());

                    for &s in &chunk {
                        let is_above_threshold = s.abs() >= audio_gate_threshold;
                        
                        // Smooth gate envelope: attack on signal, release when no signal
                        let target_envelope = if is_above_threshold { 1.0 } else { 0.0 };
                        let coeff = if is_above_threshold { attack_coeff } else { release_coeff };
                        gate_envelope = target_envelope * coeff + gate_envelope * (1.0 - coeff);
                        
                        // Apply soft gate (multiply by envelope instead of hard mute)
                        let gated = if audio_gate_enabled {
                            s * gate_envelope
                        } else {
                            s
                        };
                        let gained = gated * input_gain;
                        if gained.abs() > input_peak {
                            input_peak = gained.abs();
                        }
                        pcm_accum.push(gained.clamp(-1.0, 1.0));
                    }
                    meter_frames += chunk.len() as u32;
                    if meter_frames >= 2400 {
                        let _ = app_clone.emit("audio_level_meter", LevelMeterEvent {
                            input_peak, output_peak: 0.0,
                        });
                        input_peak = 0.0;
                        meter_frames = 0;
                    }
                    while pcm_accum.len() >= OPUS_FRAME_SIZE {
                        let active = ptt_clone.load(Ordering::Acquire);
                        let src: &[f32] = if active {
                            &pcm_accum[..OPUS_FRAME_SIZE]
                        } else {
                            &silence
                        };
                        if let Ok(n) = encoder.encode_float(src, &mut buf) {
                            if encoded_tx
                                .try_send(EncodedFrame {
                                    data: bytes::Bytes::copy_from_slice(&buf[..n]),
                                    encoded_at: Instant::now(),
                                })
                                .is_err()
                            {
                                dropped_encoded_frames = dropped_encoded_frames.saturating_add(1);
                                if dropped_encoded_frames % DROP_LOG_EVERY == 0 {
                                    log::warn!(
                                        "[audio] encoded queue full, dropped frames={} (queue={})",
                                        dropped_encoded_frames,
                                        CAPTURE_ENCODED_QUEUE_CAPACITY
                                    );
                                }
                            }
                        }
                        pcm_accum.drain(..OPUS_FRAME_SIZE);
                    }

                    if Instant::now() >= next_latency_log {
                        let raw_avg_ms = if raw_queue_count > 0 {
                            raw_queue_sum_ms / raw_queue_count as f64
                        } else {
                            0.0
                        };
                        let dropped_encoded_delta = dropped_encoded_frames
                            .saturating_sub(last_dropped_encoded_frames);
                        last_dropped_encoded_frames = dropped_encoded_frames;
                        let network_pressure = network_stress_playback_for_thread
                            .load(Ordering::Relaxed)
                            .max(network_stress_stats_for_thread.load(Ordering::Relaxed));

                        let congested = dropped_encoded_delta > 0
                            || raw_queue_max_ms > adapt_config.congested_raw_max_ms
                            || raw_avg_ms > adapt_config.congested_raw_avg_ms
                            || network_pressure >= 2;
                        let very_stable = dropped_encoded_delta == 0
                            && raw_avg_ms < adapt_config.stable_raw_avg_ms
                            && raw_queue_max_ms < adapt_config.stable_raw_max_ms
                            && network_pressure == 0;

                        let mut next_bitrate = current_bitrate;
                        if congested {
                            stable_intervals = 0;
                            next_bitrate = (current_bitrate - adapt_config.step_down)
                                .max(adapt_config.bitrate_min);
                        } else if very_stable {
                            stable_intervals = stable_intervals.saturating_add(1);
                            if stable_intervals >= adapt_config.stable_intervals_for_step_up {
                                next_bitrate = (current_bitrate + adapt_config.step_up)
                                    .min(adapt_config.bitrate_max);
                                stable_intervals = 0;
                            }
                        } else {
                            stable_intervals = 0;
                        }

                        if next_bitrate != current_bitrate {
                            let loss_hint = packet_loss_hint_for_bitrate(next_bitrate);
                            if encoder
                                .set_bitrate(opus::Bitrate::Bits(next_bitrate))
                                .is_ok()
                            {
                                current_bitrate = next_bitrate;
                                let _ = encoder.set_packet_loss_perc(loss_hint);
                                log::info!(
                                    "[audio][adapt] bitrate={} loss_hint={} net_pressure={} dropped_encoded_delta={} raw_avg_ms={:.2} raw_max_ms={:.2}",
                                    current_bitrate,
                                    loss_hint,
                                    network_pressure,
                                    dropped_encoded_delta,
                                    raw_avg_ms,
                                    raw_queue_max_ms
                                );
                            }
                        }

                        log::info!(
                            "[audio][latency] capture_raw_queue avg_ms={:.2} max_ms={:.2} samples={} dropped_raw={} dropped_encoded={}",
                            raw_avg_ms,
                            raw_queue_max_ms,
                            raw_queue_count,
                            dropped_capture_frames,
                            dropped_encoded_frames
                        );
                        raw_queue_count = 0;
                        raw_queue_sum_ms = 0.0;
                        raw_queue_max_ms = 0.0;
                        next_latency_log = Instant::now() + LATENCY_LOG_INTERVAL;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        drop(stream);
        drop(silence);
        log::info!("[audio] capture thread terminated");
    });

    // ── Async half: forward encoded frames to WebRTC track ───────────────
    let mut encoded_queue_count: u64 = 0;
    let mut encoded_queue_sum_ms: f64 = 0.0;
    let mut encoded_queue_max_ms: f64 = 0.0;
    let mut next_encoded_log = Instant::now() + LATENCY_LOG_INTERVAL;
    let mut stats_tick = tokio::time::interval(STATS_POLL_INTERVAL);
    stats_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                stop_flag.store(true, Ordering::Relaxed);
                break;
            }
            _ = stats_tick.tick() => {
                let stats = peer_connection.get_stats().await;
                let stats_pressure = pressure_from_remote_inbound_stats(&stats, adapt_config);
                network_stress_stats.store(stats_pressure, Ordering::Relaxed);
            }
            maybe = encoded_rx.recv() => {
                match maybe {
                    Some(frame) => {
                        let encoded_queue_ms = frame.encoded_at.elapsed().as_secs_f64() * 1000.0;
                        encoded_queue_count += 1;
                        encoded_queue_sum_ms += encoded_queue_ms;
                        if encoded_queue_ms > encoded_queue_max_ms {
                            encoded_queue_max_ms = encoded_queue_ms;
                        }

                        let sample = Sample {
                            data: frame.data,
                            duration: std::time::Duration::from_millis(10),
                            ..Default::default()
                        };
                        if let Err(e) = track.write_sample(&sample).await {
                            log::warn!("[audio] track write: {e}");
                        }

                        if Instant::now() >= next_encoded_log {
                            let encoded_avg_ms = if encoded_queue_count > 0 {
                                encoded_queue_sum_ms / encoded_queue_count as f64
                            } else {
                                0.0
                            };
                            log::info!(
                                "[audio][latency] capture_encoded_queue avg_ms={:.2} max_ms={:.2} samples={}",
                                encoded_avg_ms,
                                encoded_queue_max_ms,
                                encoded_queue_count
                            );
                            encoded_queue_count = 0;
                            encoded_queue_sum_ms = 0.0;
                            encoded_queue_max_ms = 0.0;
                            next_encoded_log = Instant::now() + LATENCY_LOG_INTERVAL;
                        }
                    }
                    None => break,
                }
            }
        }
    }
    log::info!("[audio] capture loop terminated");
}

// ── Playback loop ─────────────────────────────────────────────────────────────

/// Reads RTP from an incoming track, Opus-decodes it, and pushes PCM to CPAL output.
async fn playback_loop(
    track: Arc<TrackRemote>,
    source_user_id: Option<String>,
    output_routing: Arc<OutputRoutingState>,
    output_device_id: Arc<RwLock<Option<String>>>,
    network_stress: Arc<AtomicU8>,
    app: AppHandle,
) {
    // opus payload bytes: async WebRTC reader → sync decoder thread
    let (opus_tx, opus_rx) =
        std::sync::mpsc::sync_channel::<OpusFrame>(PLAYBACK_OPUS_QUEUE_CAPACITY);
    let dropped_opus_counter = Arc::new(AtomicU64::new(0));
    let decode_error_counter = Arc::new(AtomicU64::new(0));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop_flag);
    let app_clone = app.clone();
    let dropped_opus_counter_for_thread = Arc::clone(&dropped_opus_counter);
    let decode_error_counter_for_thread = Arc::clone(&decode_error_counter);
    let network_stress_for_thread = Arc::clone(&network_stress);

    // ── Sync thread: owns !Send cpal::Stream + Opus decoder ─────────────
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(SAMPLE_RATE),
            buffer_size: cpal::BufferSize::Fixed(OPUS_FRAME_SIZE as u32),
        };
        // PCM ring: decoder → CPAL output callback
        let (pcm_tx, pcm_rx) =
            std::sync::mpsc::sync_channel::<PcmFrame>(PLAYBACK_PCM_QUEUE_CAPACITY);
        let pcm_rx = Arc::new(Mutex::new(pcm_rx));
        let pcm_queue_latency = Arc::new(AtomicLatencyStats::default());
        let output_drop_counter = Arc::new(AtomicU64::new(0));

        let build_output_stream = |selected_device: Option<&str>| -> Option<cpal::Stream> {
            let device = match find_output_device(&host, selected_device) {
                Some(d) => d,
                None => {
                    log::error!(
                        "[audio] playback: no output device for selection={}",
                        selected_device.unwrap_or("default")
                    );
                    return None;
                }
            };

            let pcm_rx_cb = Arc::clone(&pcm_rx);
            let pcm_queue_latency_cb = Arc::clone(&pcm_queue_latency);
            let output_drop_counter_cb = Arc::clone(&output_drop_counter);
            let stream = match device.build_output_stream(
                &config,
                move |output: &mut [f32], _| {
                    let next_frame = pcm_rx_cb.lock().ok().and_then(|rx| rx.try_recv().ok());
                    if let Some(frame) = next_frame {
                        pcm_queue_latency_cb.record(frame.decoded_at.elapsed());
                        let n = output.len().min(frame.samples.len());
                        output[..n].copy_from_slice(&frame.samples[..n]);
                        if n < output.len() {
                            output[n..].fill(0.0);
                        }
                    } else {
                        output_drop_counter_cb.fetch_add(1, Ordering::Relaxed);
                        output.fill(0.0);
                    }
                },
                |err| log::error!("[audio] output stream error: {err}"),
                None,
            ) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[audio] build output stream: {e}");
                    return None;
                }
            };

            if let Err(e) = stream.play() {
                log::error!("[audio] start output stream: {e}");
                return None;
            }

            Some(stream)
        };

        let mut active_device_id = output_device_id
            .read()
            .ok()
            .and_then(|v| v.clone());
        let mut output_stream = build_output_stream(active_device_id.as_deref());
        if output_stream.is_none() {
            log::warn!("[audio] playback: stream unavailable until output device becomes valid");
        }
        let mut decoder = match Decoder::new(SAMPLE_RATE, Channels::Mono) {
            Ok(d) => d,
            Err(e) => { log::error!("[audio] create decoder: {e}"); return; }
        };
        let mut decode_buf = [0.0f32; OPUS_FRAME_SIZE * 4];
        let mut output_peak = 0.0f32;
        let mut meter_frames: u32 = 0;
        let mut dropped_pcm_frames: u32 = 0;
        let mut last_dropped_opus: u64 = 0;
        let mut last_decode_errors: u64 = 0;
        let mut rtp_queue_count: u64 = 0;
        let mut rtp_queue_sum_ms: f64 = 0.0;
        let mut rtp_queue_max_ms: f64 = 0.0;
        let mut next_latency_log = Instant::now() + LATENCY_LOG_INTERVAL;

        loop {
            if stop_clone.load(Ordering::Relaxed) { break; }

            let desired_device_id = output_device_id
                .read()
                .ok()
                .and_then(|v| v.clone());
            if desired_device_id != active_device_id {
                // Drop first to guarantee no audio leaks on the previous device.
                drop(output_stream.take());
                active_device_id = desired_device_id;
                output_stream = build_output_stream(active_device_id.as_deref());
                if output_stream.is_some() {
                    log::info!(
                        "[audio] playback output switched to {}",
                        active_device_id.as_deref().unwrap_or("default")
                    );
                } else {
                    log::warn!(
                        "[audio] playback output switch failed for {}",
                        active_device_id.as_deref().unwrap_or("default")
                    );
                }
            }

            match opus_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(frame) => {
                    let rtp_queue_ms = frame.received_at.elapsed().as_secs_f64() * 1000.0;
                    rtp_queue_count += 1;
                    rtp_queue_sum_ms += rtp_queue_ms;
                    if rtp_queue_ms > rtp_queue_max_ms {
                        rtp_queue_max_ms = rtp_queue_ms;
                    }

                    match decoder.decode_float(&frame.payload, &mut decode_buf, false) {
                        Ok(n) => {
                            let user_gain = source_user_id
                                .as_deref()
                                .map(|user_id| output_routing.gain_for_user(user_id))
                                .unwrap_or(DEFAULT_OUTPUT_GAIN);
                            let mut pcm = decode_buf[..n].to_vec();
                            if user_gain != DEFAULT_OUTPUT_GAIN {
                                for sample in &mut pcm {
                                    *sample = (*sample * user_gain).clamp(-1.0, 1.0);
                                }
                            }
                            for &s in &pcm {
                                if s.abs() > output_peak { output_peak = s.abs(); }
                            }
                            meter_frames += n as u32;
                            if meter_frames >= 2400 {
                                let _ = app_clone.emit("audio_output_level", output_peak);
                                output_peak = 0.0;
                                meter_frames = 0;
                            }
                            if pcm_tx
                                .try_send(PcmFrame {
                                    samples: pcm,
                                    decoded_at: Instant::now(),
                                })
                                .is_err()
                            {
                                dropped_pcm_frames = dropped_pcm_frames.saturating_add(1);
                                if dropped_pcm_frames % DROP_LOG_EVERY == 0 {
                                    log::warn!(
                                        "[audio] playback pcm queue full, dropped frames={} (queue={})",
                                        dropped_pcm_frames,
                                        PLAYBACK_PCM_QUEUE_CAPACITY
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            decode_error_counter_for_thread.fetch_add(1, Ordering::Relaxed);
                            log::warn!("[audio] opus decode: {e}");
                        }
                    }

                    if Instant::now() >= next_latency_log {
                        let rtp_avg_ms = if rtp_queue_count > 0 {
                            rtp_queue_sum_ms / rtp_queue_count as f64
                        } else {
                            0.0
                        };
                        let (pcm_avg_ms, pcm_max_ms, pcm_samples) =
                            pcm_queue_latency.snapshot_and_reset().unwrap_or((0.0, 0.0, 0));
                        let output_underruns = output_drop_counter.swap(0, Ordering::Relaxed);
                        let dropped_opus_total =
                            dropped_opus_counter_for_thread.load(Ordering::Relaxed);
                        let dropped_opus_delta =
                            dropped_opus_total.saturating_sub(last_dropped_opus);
                        last_dropped_opus = dropped_opus_total;
                        let decode_errors_total =
                            decode_error_counter_for_thread.load(Ordering::Relaxed);
                        let decode_errors_delta =
                            decode_errors_total.saturating_sub(last_decode_errors);
                        last_decode_errors = decode_errors_total;

                        let net_pressure: u8 = if dropped_opus_delta > 4
                            || decode_errors_delta > 2
                            || rtp_queue_max_ms > 120.0
                        {
                            3
                        } else if dropped_opus_delta > 0
                            || decode_errors_delta > 0
                            || rtp_queue_max_ms > 60.0
                        {
                            2
                        } else if rtp_queue_max_ms > 30.0 || output_underruns > 50 {
                            1
                        } else {
                            0
                        };
                        network_stress_for_thread.store(net_pressure, Ordering::Relaxed);

                        log::info!(
                            "[audio][latency] playback_rtp_queue avg_ms={:.2} max_ms={:.2} samples={} | playback_pcm_queue avg_ms={:.2} max_ms={:.2} samples={} | pcm_drops={} underruns={} | net_pressure={} dropped_opus_delta={} decode_errors_delta={}",
                            rtp_avg_ms,
                            rtp_queue_max_ms,
                            rtp_queue_count,
                            pcm_avg_ms,
                            pcm_max_ms,
                            pcm_samples,
                            dropped_pcm_frames,
                            output_underruns,
                            net_pressure,
                            dropped_opus_delta,
                            decode_errors_delta
                        );
                        rtp_queue_count = 0;
                        rtp_queue_sum_ms = 0.0;
                        rtp_queue_max_ms = 0.0;
                        next_latency_log = Instant::now() + LATENCY_LOG_INTERVAL;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        drop(output_stream);
        log::info!("[audio] playback thread terminated");
    });

    // ── Async half: read RTP packets and forward Opus payload to decoder ─
    let mut rtp_buf = [0u8; 1500];
    let mut dropped_opus_frames: u32 = 0;
    loop {
        match track.read(&mut rtp_buf).await {
            Ok((packet, _attr)) => {
                let payload = packet.payload.to_vec();
                if opus_tx
                    .try_send(OpusFrame {
                        payload,
                        received_at: Instant::now(),
                    })
                    .is_err()
                {
                    dropped_opus_frames = dropped_opus_frames.saturating_add(1);
                    dropped_opus_counter.fetch_add(1, Ordering::Relaxed);
                    if dropped_opus_frames % DROP_LOG_EVERY == 0 {
                        log::warn!(
                            "[audio] playback opus queue full, dropped frames={} (queue={})",
                            dropped_opus_frames,
                            PLAYBACK_OPUS_QUEUE_CAPACITY
                        );
                    }
                }
            }
            Err(e) => {
                log::warn!("[audio] remote track read: {e}");
                break;
            }
        }
    }
    stop_flag.store(true, Ordering::Relaxed);
    log::info!("[audio] playback loop terminated");
}

// ── Device helpers ────────────────────────────────────────────────────────────

fn find_input_device(host: &cpal::Host, id: Option<&str>) -> Option<cpal::Device> {
    match id {
        Some(name) => host
            .input_devices()
            .ok()?
            .find(|d| d.name().ok().as_deref() == Some(name)),
        None => host.default_input_device(),
    }
}

fn find_output_device(host: &cpal::Host, id: Option<&str>) -> Option<cpal::Device> {
    match id {
        Some(name) => host
            .output_devices()
            .ok()?
            .find(|d| d.name().ok().as_deref() == Some(name)),
        None => host.default_output_device(),
    }
}

// ── PTT control ───────────────────────────────────────────────────────────────

/// Set the PTT gate.  Called from the `set_ptt` Tauri command.
pub fn set_ptt(state: &AudioEngineState, active: bool) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.ptt_active.store(active, Ordering::Release);
    }
}

pub fn set_input_gain(state: &AudioEngineState, gain: f32) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.audio_processing.set_input_gain(gain);
    }
}

pub fn set_audio_gate(state: &AudioEngineState, enabled: bool, threshold_db: f32) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.audio_processing.set_audio_gate_enabled(enabled);
        engine
            .audio_processing
            .set_audio_gate_threshold_db(threshold_db);
    }
}

pub fn set_output_gains(state: &AudioEngineState, gains_by_user_id: HashMap<String, f32>) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.output_routing.set_output_gains(gains_by_user_id);
    }
}

pub fn set_output_device(state: &AudioEngineState, output_device_id: Option<String>) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        if let Ok(mut selected) = engine.output_device_id.write() {
            *selected = output_device_id;
        }
    }
}

/// Tear down the current engine (called on disconnect).
pub async fn stop_engine(state: &AudioEngineState) {
    let engine = state.engine.lock().unwrap().take();
    if let Some(e) = engine {
        let _ = e.peer_connection.close().await;
    }
}
