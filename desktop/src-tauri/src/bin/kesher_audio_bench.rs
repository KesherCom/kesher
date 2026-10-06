//! Headless latency / audio-quality benchmark for the native audio engine.
//!
//! Built only on request (`cargo build --release --features bench --bin
//! kesher_audio_bench`), never bundled with the app. Driven by
//! `testlab/desktop.mjs` (`make lab-desktop`), which logs the sessions in and
//! passes the relay endpoints in a JSON config:
//!
//!   kesher_audio_bench virtual  <config.json>
//!       Two engines in this process, talker -> relay -> listener, on virtual
//!       devices with a shared clock. Measures one-way latency of the app's
//!       real audio path (framing, Opus, network, jitter buffer, PLC/FEC,
//!       mixing) to the sample, plus audible dropouts. Excludes the sound
//!       card/driver buffers (see the hardware mode for those).
//!
//!   kesher_audio_bench hardware <config.json>
//!       One engine on real devices; repeats the app's built-in loopback
//!       click test (relay echoes the click, it must reach the input via a
//!       cable or speaker -> mic). True mouth-to-ear latency incl. drivers.
//!
//! Prints one JSON object on stdout; logs go to stderr (RUST_LOG=info).

#![cfg(any(target_os = "windows", target_os = "macos"))]

#[allow(dead_code)]
#[path = "../audio_native.rs"]
mod audio_native;
#[cfg(target_os = "windows")]
#[allow(dead_code)]
#[path = "../audio_wasapi.rs"]
mod audio_wasapi;

use audio_native::{NativeAudioState, NativeStatsSnapshot, StartNativeParams, VirtualDevice};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const RATE: f64 = 48_000.0;
/// Continuous test signal between markers: 440 Hz sine at this amplitude
/// (RMS ≈ 0.18). Markers are short loud bursts the listener can time.
const TONE_AMPLITUDE: f32 = 0.25;
const MARKER_AMPLITUDE: f32 = 0.9;
const MARKER_SAMPLES: usize = 96; // 2 ms, 1 kHz square
const DETECT_THRESHOLD: f32 = 0.5;
/// Listener-side analysis window for dropouts (5 ms).
const WINDOW: usize = 240;
/// RMS below this is silence (dropout), below DEGRADED audibly attenuated.
const DROPOUT_RMS: f32 = 0.03;
const DEGRADED_RMS: f32 = 0.10;
/// Windows whose tone-fit SNR is below this count as distorted (PLC
/// artifacts, clicks, partial gaps). Clean Opus at 48 kbit/s stays well above.
const DISTORTED_SNR_DB: f64 = 20.0;
const TONE_HZ: f64 = 440.0;

/// Signal-to-noise ratio of one window against the best-fitting 440 Hz
/// sinusoid (least squares over sin/cos, so no alignment is needed).
fn tone_snr_db(x: &[f32], first_index: u64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * TONE_HZ / RATE;
    let (mut ss, mut cc, mut sc, mut xs, mut xc) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (k, &v) in x.iter().enumerate() {
        let ph = w * (first_index + k as u64) as f64;
        let (s, c) = ph.sin_cos();
        let v = v as f64;
        ss += s * s;
        cc += c * c;
        sc += s * c;
        xs += v * s;
        xc += v * c;
    }
    let det = ss * cc - sc * sc;
    if det.abs() < 1e-9 {
        return 0.0;
    }
    let a = (xs * cc - xc * sc) / det;
    let b = (xc * ss - xs * sc) / det;
    let (mut sig, mut err) = (0.0, 0.0);
    for (k, &v) in x.iter().enumerate() {
        let ph = w * (first_index + k as u64) as f64;
        let fit = a * ph.sin() + b * ph.cos();
        sig += fit * fit;
        err += (v as f64 - fit).powi(2);
    }
    if err <= 1e-12 {
        return 99.0;
    }
    (10.0 * (sig / err).log10()).clamp(-20.0, 99.0)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    host: String,
    port: u16,
    token: String,
    token_hash: u32,
    #[serde(default)]
    protocol_version: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VirtualConfig {
    talker: Endpoint,
    listener: Endpoint,
    #[serde(default = "default_duration")]
    duration_seconds: f64,
    #[serde(default = "default_warmup")]
    warmup_seconds: f64,
    #[serde(default = "default_period")]
    period_frames: usize,
    #[serde(default = "default_marker_interval")]
    marker_interval_ms: f64,
    #[serde(default)]
    frame_ms: Option<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HardwareConfig {
    endpoint: Endpoint,
    #[serde(default = "default_runs")]
    runs: usize,
    #[serde(default)]
    frame_ms: Option<f32>,
    #[serde(default)]
    input_device: Option<String>,
    #[serde(default)]
    output_device: Option<String>,
    #[serde(default)]
    audio_backend: Option<String>,
}

fn default_duration() -> f64 {
    20.0
}
fn default_warmup() -> f64 {
    2.0
}
fn default_period() -> usize {
    128
}
fn default_marker_interval() -> f64 {
    600.0
}
fn default_runs() -> usize {
    10
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Dist {
    count: usize,
    min: f64,
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
    mean: f64,
    stddev: f64,
}

fn dist(mut v: Vec<f64>) -> Dist {
    if v.is_empty() {
        return Dist::default();
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    let q = |p: f64| v[((p * (n - 1) as f64).round() as usize).min(n - 1)];
    let mean = v.iter().sum::<f64>() / n as f64;
    let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
    let r = |x: f64| (x * 100.0).round() / 100.0;
    Dist {
        count: n,
        min: r(v[0]),
        p50: r(q(0.5)),
        p95: r(q(0.95)),
        p99: r(q(0.99)),
        max: r(v[n - 1]),
        mean: r(mean),
        stddev: r(var.sqrt()),
    }
}

fn params(ep: &Endpoint, frame_ms: Option<f32>) -> StartNativeParams {
    StartNativeParams {
        server_host: ep.host.clone(),
        server_port: ep.port,
        session_token: ep.token.clone(),
        token_hash: ep.token_hash,
        input_device_id: None,
        output_device_id: None,
        protocol_version: ep.protocol_version.or(Some(2)),
        frame_duration_ms: frame_ms,
        audio_backend: None,
    }
}

fn diff(a: &NativeStatsSnapshot, b: &NativeStatsSnapshot) -> serde_json::Value {
    serde_json::json!({
        "txPackets": b.tx_packets - a.tx_packets,
        "rxPackets": b.rx_packets - a.rx_packets,
        "concealed": b.concealed - a.concealed,
        "fecRecovered": b.fec_recovered - a.fec_recovered,
        "jitterUnderruns": b.jitter_underruns - a.jitter_underruns,
        "latePackets": b.late_packets - a.late_packets,
        "latencyTrims": b.latency_trims - a.latency_trims,
        "rxQueueFull": b.rx_queue_full - a.rx_queue_full,
        "txErrors": b.tx_errors - a.tx_errors,
        "virtualLateTicks": b.virtual_late_ticks - a.virtual_late_ticks,
        "txGapsOver20ms": b.tx_gaps_over_20ms - a.tx_gaps_over_20ms,
        "rxGapsOver20ms": b.rx_gaps_over_20ms - a.rx_gaps_over_20ms,
        "txMaxGapMs": b.tx_max_gap_ms,
        "rxMaxGapMs": b.rx_max_gap_ms,
        "txSendMaxMs": b.tx_send_max_ms,
    })
}

// ── Virtual mode ─────────────────────────────────────────────────────────

/// What the listener heard, filled by its output callback.
#[derive(Default)]
struct Heard {
    latencies_ms: Vec<f64>,
    late_markers: usize,
    dropout_windows: usize,
    degraded_windows: usize,
    distorted_windows: usize,
    analysed_windows: usize,
    tone_windows: usize,
    snr_db: Vec<f64>,
}

fn run_virtual(cfg: VirtualConfig) -> Result<serde_json::Value, String> {
    let marker_interval = (cfg.marker_interval_ms / 1000.0 * RATE) as u64;
    // Markers emitted by the talker during the measurement window.
    let emitted: Arc<Mutex<Vec<Instant>>> = Arc::default();
    let heard: Arc<Mutex<Heard>> = Arc::default();
    let measuring = Arc::new(AtomicBool::new(false));

    // Talker: tone + periodic markers.
    let talker_input = {
        let emitted = Arc::clone(&emitted);
        let measuring = Arc::clone(&measuring);
        let mut n: u64 = 0;
        let mut marker_left = 0usize;
        Box::new(move |buf: &mut [f32], first: Instant| {
            for (i, s) in buf.iter_mut().enumerate() {
                if n % marker_interval == 0 && measuring.load(Ordering::Relaxed) {
                    marker_left = MARKER_SAMPLES;
                    let at = first + Duration::from_secs_f64(i as f64 / RATE);
                    emitted.lock().unwrap().push(at);
                }
                *s = if marker_left > 0 {
                    let k = MARKER_SAMPLES - marker_left;
                    marker_left -= 1;
                    if (k / 24) % 2 == 0 {
                        MARKER_AMPLITUDE
                    } else {
                        -MARKER_AMPLITUDE
                    }
                } else {
                    (2.0 * std::f64::consts::PI * 440.0 * n as f64 / RATE).sin() as f32 * TONE_AMPLITUDE
                };
                n += 1;
            }
        }) as audio_native::VirtualInput
    };

    // Listener: time markers, classify 5 ms windows.
    let listener_output = {
        let emitted = Arc::clone(&emitted);
        let heard = Arc::clone(&heard);
        let measuring = Arc::clone(&measuring);
        let refractory = Duration::from_millis(150);
        let mut last_detect: Option<Instant> = None;
        let mut window = Vec::with_capacity(WINDOW);
        let mut played: u64 = 0;
        Box::new(move |buf: &[f32], first: Instant| {
            let active = measuring.load(Ordering::Relaxed);
            for (j, &x) in buf.iter().enumerate() {
                played += 1;
                if x.abs() >= DETECT_THRESHOLD {
                    let t = first + Duration::from_secs_f64(j as f64 / RATE);
                    if last_detect.is_none_or(|d| t.duration_since(d) > refractory) {
                        last_detect = Some(t);
                        // Match the newest marker sent before we heard it.
                        let sent = emitted.lock().unwrap().iter().rev().find(|&&e| e <= t).copied();
                        if let Some(sent) = sent {
                            let ms = t.duration_since(sent).as_secs_f64() * 1000.0;
                            let mut h = heard.lock().unwrap();
                            if ms < 0.95 * marker_interval as f64 / RATE * 1000.0 {
                                h.latencies_ms.push(ms);
                            } else {
                                h.late_markers += 1;
                            }
                        }
                    }
                }
                window.push(x);
                if window.len() == WINDOW {
                    if active {
                        let rms = (window.iter().map(|v| v * v).sum::<f32>() / WINDOW as f32).sqrt();
                        let marker = window.iter().any(|v| v.abs() > 0.4);
                        let mut h = heard.lock().unwrap();
                        h.analysed_windows += 1;
                        if rms < DROPOUT_RMS {
                            h.dropout_windows += 1;
                        } else if rms < DEGRADED_RMS {
                            h.degraded_windows += 1;
                        }
                        // Tone quality, skipping the marker bursts.
                        if !marker {
                            let snr = tone_snr_db(&window, played - WINDOW as u64);
                            h.tone_windows += 1;
                            h.snr_db.push(snr);
                            if snr < DISTORTED_SNR_DB {
                                h.distorted_windows += 1;
                            }
                        }
                    }
                    window.clear();
                }
            }
        }) as audio_native::VirtualOutput
    };

    let talker = NativeAudioState::default();
    let listener = NativeAudioState::default();
    let listener_info = audio_native::start_engine_virtual(
        params(&cfg.listener, cfg.frame_ms),
        &listener,
        VirtualDevice {
            period_frames: cfg.period_frames,
            input: Box::new(|buf: &mut [f32], _| buf.fill(0.0)),
            output: listener_output,
        },
    )?;
    let talker_info = audio_native::start_engine_virtual(
        params(&cfg.talker, cfg.frame_ms),
        &talker,
        VirtualDevice {
            period_frames: cfg.period_frames,
            input: talker_input,
            output: Box::new(|_: &[f32], _| {}),
        },
    )?;
    audio_native::set_mic_active(&talker, true);

    // Warm-up: relay registration, first packets, jitter buffer settles.
    std::thread::sleep(Duration::from_secs_f64(cfg.warmup_seconds));
    let t0 = audio_native::stats_snapshot(&talker).unwrap_or_default();
    let l0 = audio_native::stats_snapshot(&listener).unwrap_or_default();
    measuring.store(true, Ordering::Relaxed);
    let start = Instant::now();
    let mut targets = Vec::new();
    while start.elapsed().as_secs_f64() < cfg.duration_seconds {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(s) = audio_native::stats_snapshot(&listener) {
            targets.push(s.target_ms as f64);
        }
    }
    measuring.store(false, Ordering::Relaxed);
    let measured = start.elapsed().as_secs_f64();
    // Let markers that are still in flight arrive.
    std::thread::sleep(Duration::from_millis(1500));
    let t1 = audio_native::stats_snapshot(&talker).unwrap_or_default();
    let l1 = audio_native::stats_snapshot(&listener).unwrap_or_default();
    talker.engine.lock().unwrap().take();
    listener.engine.lock().unwrap().take();
    std::thread::sleep(Duration::from_millis(300));

    let sent = emitted.lock().unwrap().len();
    let h = heard.lock().unwrap();
    let window_ms = WINDOW as f64 / RATE * 1000.0;
    let concealed = l1.concealed - l0.concealed;
    Ok(serde_json::json!({
        "mode": "virtual",
        "frameMs": talker_info.frame_ms,
        "periodMs": listener_info.output.period_ms,
        "measuredSeconds": (measured * 10.0).round() / 10.0,
        "latencyMs": dist(h.latencies_ms.clone()),
        "markersSent": sent,
        "markersHeard": h.latencies_ms.len(),
        "markersLate": h.late_markers,
        "dropoutMs": h.dropout_windows as f64 * window_ms,
        "degradedMs": h.degraded_windows as f64 * window_ms,
        "dropoutPct": if h.analysed_windows > 0 { (1000.0 * h.dropout_windows as f64 / h.analysed_windows as f64).round() / 10.0 } else { 0.0 },
        "distortedPct": if h.tone_windows > 0 { (1000.0 * h.distorted_windows as f64 / h.tone_windows as f64).round() / 10.0 } else { 0.0 },
        "toneSnrDb": dist(h.snr_db.clone()),
        "concealedPerMin": (concealed as f64 / measured * 60.0).round(),
        "jitterBufferTargetMs": dist(targets),
        "talker": diff(&t0, &t1),
        "listener": diff(&l0, &l1),
    }))
}

// ── Hardware mode ────────────────────────────────────────────────────────

async fn run_hardware(cfg: HardwareConfig) -> Result<serde_json::Value, String> {
    let state = NativeAudioState::default();
    let mut p = params(&cfg.endpoint, cfg.frame_ms);
    p.input_device_id = cfg.input_device.clone();
    p.output_device_id = cfg.output_device.clone();
    p.audio_backend = cfg.audio_backend.clone();
    let info = audio_native::start_engine(p, &state, None).await?;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let s0 = audio_native::stats_snapshot(&state).unwrap_or_default();
    let mut results = Vec::new();
    let mut failed = 0usize;
    for i in 0..cfg.runs {
        match audio_native::run_latency_test(&state).await? {
            Some(ms) => results.push(ms),
            None => failed += 1,
        }
        eprintln!("bench: hardware run {}/{}: {:?}", i + 1, cfg.runs, results.last());
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let s1 = audio_native::stats_snapshot(&state).unwrap_or_default();
    audio_native::stop_engine(&state).await;
    Ok(serde_json::json!({
        "mode": "hardware",
        "frameMs": info.frame_ms,
        "input": info.input,
        "output": info.output,
        "latencyMs": dist(results),
        "runs": cfg.runs,
        "notDetected": failed,
        "engine": diff(&s0, &s1),
    }))
}

fn read_config<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .target(env_logger::Target::Stderr)
        .init();
    let args: Vec<String> = std::env::args().collect();
    let result = match (args.get(1).map(String::as_str), args.get(2)) {
        (Some("virtual"), Some(path)) => match read_config::<VirtualConfig>(path) {
            Ok(cfg) => tokio::task::spawn_blocking(move || run_virtual(cfg)).await.map_err(|e| e.to_string()).and_then(|r| r),
            Err(e) => Err(e),
        },
        (Some("hardware"), Some(path)) => match read_config::<HardwareConfig>(path) {
            Ok(cfg) => run_hardware(cfg).await,
            Err(e) => Err(e),
        },
        _ => Err("usage: kesher_audio_bench <virtual|hardware> <config.json>".to_string()),
    };
    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            println!("{}", serde_json::json!({ "error": e }));
            std::process::exit(1);
        }
    }
}
