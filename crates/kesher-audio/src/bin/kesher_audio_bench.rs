//! Headless latency / audio-quality benchmark for the native audio engine.
//!
//! Built only on request (`cargo build --release -p kesher-audio --features
//! bench --bin kesher_audio_bench`), never bundled with the app. Driven by
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
//!       With `speechWav` + `recordDir` in the config the talker plays that
//!       clip instead of the tone, and the bench writes what was sent
//!       (reference.wav) and what the listener heard (degraded.wav) for
//!       speech-quality scoring (testlab/lib/pesq_score.py).
//!
//!   kesher_audio_bench multi <config.json>
//!       N engines that all talk and listen at once (a full intercom
//!       party line), on one shared virtual clock. Phase 1: each talker
//!       sends a quiet tone plus loud markers staggered in time, so every
//!       listener can attribute a marker in its mix to its talker -> one
//!       latency distribution per talker/listener pair. Phase 2 (with
//!       `speechWav`): everyone speaks at once at normal level -> clipping
//!       in the mix and output-callback time under load.
//!
//!   kesher_audio_bench hardware <config.json>
//!       One engine on real devices; repeats the app's built-in loopback
//!       click test (relay echoes the click, it must reach the input via a
//!       cable or speaker -> mic). True mouth-to-ear latency incl. drivers.
//!
//! Prints one JSON object on stdout; logs go to stderr (RUST_LOG=info).

use kesher_audio::native as audio_native;
use audio_native::{NativeAudioState, NativeStatsSnapshot, StartNativeParams, VirtualClock, VirtualDevice};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
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
    /// Speech mode: 48 kHz 16-bit mono WAV the talker plays in a loop.
    #[serde(default)]
    speech_wav: Option<String>,
    /// Speech mode: directory for reference.wav / degraded.wav.
    #[serde(default)]
    record_dir: Option<String>,
    /// Talker uses silence suppression (as in always-on mode).
    #[serde(default)]
    vad: bool,
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
        "vadSuppressed": b.vad_suppressed - a.vad_suppressed,
        "clippedSamples": b.clipped_samples - a.clipped_samples,
        "mixedSamples": b.mixed_samples - a.mixed_samples,
        "renderAvgUs": if b.render_calls > a.render_calls {
            (b.render_total_us - a.render_total_us) / (b.render_calls - a.render_calls)
        } else {
            0
        },
        "renderMaxMs": b.render_max_ms,
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

// ── WAV helpers (16-bit PCM mono, 48 kHz) ──────────────────────────────

fn read_wav_mono16(path: &str) -> Result<Vec<f32>, String> {
    let data = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(format!("{path}: not a WAV file"));
    }
    let u16_at = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    let (mut channels, mut rate, mut bits) = (0u16, 0u32, 0u16);
    let mut pos = 12;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let len = u32_at(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && len >= 16 {
            if u16_at(body) != 1 {
                return Err(format!("{path}: only PCM WAV is supported"));
            }
            channels = u16_at(body + 2);
            rate = u32_at(body + 4);
            bits = u16_at(body + 14);
        } else if id == b"data" {
            if rate != RATE as u32 || bits != 16 || channels == 0 {
                return Err(format!("{path}: need 48 kHz 16-bit PCM (got {rate} Hz, {bits} bit, {channels} ch)"));
            }
            let end = (body + len).min(data.len());
            let stride = 2 * channels as usize;
            return Ok(data[body..end]
                .chunks_exact(stride)
                .map(|f| i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0)
                .collect());
        }
        pos = body + len + (len & 1);
    }
    Err(format!("{path}: no data chunk"))
}

fn write_wav_mono16(path: &std::path::Path, samples: &[f32]) -> Result<(), String> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&(RATE as u32).to_le_bytes());
    out.extend_from_slice(&(RATE as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("write {}: {e}", path.display()))
}

// ── Speech mode ──────────────────────────────────────────────────────────

/// Plays a speech clip through talker -> relay -> listener and records both
/// ends over the same wall-clock window. The listener keeps recording a
/// little longer so the delayed tail is included; the scorer aligns them.
fn run_speech(cfg: VirtualConfig, wav: &str) -> Result<serde_json::Value, String> {
    let clip = Arc::new(read_wav_mono16(wav)?);
    if clip.is_empty() {
        return Err(format!("{wav}: empty clip"));
    }
    let dir = std::path::PathBuf::from(cfg.record_dir.clone().ok_or("speech mode needs recordDir")?);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let capacity = ((cfg.duration_seconds + 3.0) * RATE) as usize;
    let reference: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(capacity)));
    let degraded: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(capacity)));
    let record_in = Arc::new(AtomicBool::new(false));
    let record_out = Arc::new(AtomicBool::new(false));

    let talker_input = {
        let clip = Arc::clone(&clip);
        let reference = Arc::clone(&reference);
        let record_in = Arc::clone(&record_in);
        let mut pos = 0usize;
        Box::new(move |buf: &mut [f32], _: Instant| {
            for s in buf.iter_mut() {
                *s = clip[pos];
                pos = (pos + 1) % clip.len();
            }
            if record_in.load(Ordering::Relaxed) {
                reference.lock().unwrap().extend_from_slice(buf);
            }
        }) as audio_native::VirtualInput
    };
    let listener_output = {
        let degraded = Arc::clone(&degraded);
        let record_out = Arc::clone(&record_out);
        Box::new(move |buf: &[f32], _: Instant| {
            if record_out.load(Ordering::Relaxed) {
                degraded.lock().unwrap().extend_from_slice(buf);
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
            clock: None,
        },
    )?;
    let talker_info = audio_native::start_engine_virtual(
        params(&cfg.talker, cfg.frame_ms),
        &talker,
        VirtualDevice {
            period_frames: cfg.period_frames,
            input: talker_input,
            output: Box::new(|_: &[f32], _| {}),
            clock: None,
        },
    )?;
    audio_native::set_mic_active(&talker, true);
    audio_native::set_vad(&talker, cfg.vad);

    std::thread::sleep(Duration::from_secs_f64(cfg.warmup_seconds));
    let t0 = audio_native::stats_snapshot(&talker).unwrap_or_default();
    let l0 = audio_native::stats_snapshot(&listener).unwrap_or_default();
    record_out.store(true, Ordering::Relaxed);
    record_in.store(true, Ordering::Relaxed);
    std::thread::sleep(Duration::from_secs_f64(cfg.duration_seconds));
    record_in.store(false, Ordering::Relaxed);
    // Worst-case one-way latency in the lab is ~0.5 s.
    std::thread::sleep(Duration::from_millis(1000));
    record_out.store(false, Ordering::Relaxed);
    let t1 = audio_native::stats_snapshot(&talker).unwrap_or_default();
    let l1 = audio_native::stats_snapshot(&listener).unwrap_or_default();
    talker.engine.lock().unwrap().take();
    listener.engine.lock().unwrap().take();
    std::thread::sleep(Duration::from_millis(300));

    let ref_path = dir.join("reference.wav");
    let deg_path = dir.join("degraded.wav");
    write_wav_mono16(&ref_path, &reference.lock().unwrap())?;
    write_wav_mono16(&deg_path, &degraded.lock().unwrap())?;
    Ok(serde_json::json!({
        "mode": "speech",
        "vad": cfg.vad,
        "frameMs": talker_info.frame_ms,
        "periodMs": listener_info.output.period_ms,
        "seconds": cfg.duration_seconds,
        "referenceWav": ref_path.to_string_lossy(),
        "degradedWav": deg_path.to_string_lossy(),
        "talker": diff(&t0, &t1),
        "listener": diff(&l0, &l1),
    }))
}

fn run_virtual(cfg: VirtualConfig) -> Result<serde_json::Value, String> {
    if let Some(wav) = cfg.speech_wav.clone() {
        return run_speech(cfg, &wav);
    }
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
            clock: None,
        },
    )?;
    let talker_info = audio_native::start_engine_virtual(
        params(&cfg.talker, cfg.frame_ms),
        &talker,
        VirtualDevice {
            period_frames: cfg.period_frames,
            input: talker_input,
            output: Box::new(|_: &[f32], _| {}),
            clock: None,
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

// ── Multi-talker mode ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultiConfig {
    endpoints: Vec<Endpoint>,
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
    #[serde(default)]
    speech_wav: Option<String>,
    #[serde(default = "default_speech_load")]
    speech_seconds: f64,
}

fn default_speech_load() -> f64 {
    15.0
}

/// Quiet enough that the summed tones of 15 talkers stay below the marker
/// threshold.
const MULTI_TONE_AMPLITUDE: f32 = 0.03;
const MULTI_DETECT_THRESHOLD: f32 = 0.6;

const PHASE_WARMUP: u8 = 0;
const PHASE_LATENCY: u8 = 1;
const PHASE_SPEECH: u8 = 2;
const PHASE_DONE: u8 = 3;

#[derive(Default)]
struct MultiHeard {
    /// latencies[talker][listener]
    latencies: Vec<Vec<Vec<f64>>>,
    unmatched: usize,
}

fn sum_diff(a: &[NativeStatsSnapshot], b: &[NativeStatsSnapshot], f: impl Fn(&NativeStatsSnapshot) -> u64) -> u64 {
    a.iter().zip(b).map(|(x, y)| f(y).saturating_sub(f(x))).sum()
}

fn run_multi(cfg: MultiConfig) -> Result<serde_json::Value, String> {
    let n = cfg.endpoints.len();
    if n < 2 {
        return Err("multi mode needs at least two endpoints".into());
    }
    let clip: Option<Arc<Vec<f32>>> = match &cfg.speech_wav {
        Some(path) => Some(Arc::new(read_wav_mono16(path)?)),
        None => None,
    };
    let interval = (cfg.marker_interval_ms / 1000.0 * RATE) as u64;
    // Talkers' markers are spread evenly over the interval; a listener
    // attributes a marker to the newest one sent before it heard it, which
    // is unambiguous while latency < slot.
    let slot = interval / n as u64;
    let slot_ms = slot as f64 / RATE * 1000.0;
    let phase = Arc::new(AtomicU8::new(PHASE_WARMUP));
    let emitted: Arc<Mutex<Vec<(usize, Instant)>>> = Arc::default();
    let heard = Arc::new(Mutex::new(MultiHeard {
        latencies: vec![vec![Vec::new(); n]; n],
        unmatched: 0,
    }));

    let clock = VirtualClock::start(cfg.period_frames);
    let mut engines = Vec::with_capacity(n);
    let mut infos = Vec::with_capacity(n);
    for (i, ep) in cfg.endpoints.iter().enumerate() {
        let input = {
            let phase = Arc::clone(&phase);
            let emitted = Arc::clone(&emitted);
            let clip = clip.clone();
            let freq = 200.0 + 97.0 * i as f64;
            let offset = i as u64 * slot;
            let mut k: u64 = 0;
            let mut marker_left = 0usize;
            let mut speech_pos = clip.as_ref().map_or(0, |c| i * c.len() / n);
            Box::new(move |buf: &mut [f32], first: Instant| {
                let ph = phase.load(Ordering::Relaxed);
                for (j, s) in buf.iter_mut().enumerate() {
                    if ph == PHASE_SPEECH {
                        if let Some(c) = &clip {
                            *s = c[speech_pos];
                            speech_pos = (speech_pos + 1) % c.len();
                            k += 1;
                            continue;
                        }
                    }
                    if ph == PHASE_LATENCY && (k + offset) % interval == 0 {
                        marker_left = MARKER_SAMPLES;
                        emitted.lock().unwrap().push((i, first + Duration::from_secs_f64(j as f64 / RATE)));
                    }
                    *s = if marker_left > 0 {
                        let m = MARKER_SAMPLES - marker_left;
                        marker_left -= 1;
                        if (m / 24) % 2 == 0 {
                            MARKER_AMPLITUDE
                        } else {
                            -MARKER_AMPLITUDE
                        }
                    } else {
                        (2.0 * std::f64::consts::PI * freq * k as f64 / RATE).sin() as f32 * MULTI_TONE_AMPLITUDE
                    };
                    k += 1;
                }
            }) as audio_native::VirtualInput
        };
        let output = {
            let phase = Arc::clone(&phase);
            let emitted = Arc::clone(&emitted);
            let heard = Arc::clone(&heard);
            let refractory = Duration::from_millis(30);
            let mut last: Option<Instant> = None;
            Box::new(move |buf: &[f32], first: Instant| {
                if phase.load(Ordering::Relaxed) != PHASE_LATENCY {
                    return;
                }
                for (j, &x) in buf.iter().enumerate() {
                    if x.abs() < MULTI_DETECT_THRESHOLD {
                        continue;
                    }
                    let t = first + Duration::from_secs_f64(j as f64 / RATE);
                    if last.is_some_and(|d| t.duration_since(d) <= refractory) {
                        continue;
                    }
                    last = Some(t);
                    let sent = emitted
                        .lock()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|&&(talker, e)| talker != i && e <= t)
                        .copied();
                    let mut h = heard.lock().unwrap();
                    match sent {
                        Some((talker, e)) if t.duration_since(e).as_secs_f64() * 1000.0 < 0.9 * slot_ms => {
                            h.latencies[talker][i].push(t.duration_since(e).as_secs_f64() * 1000.0);
                        }
                        _ => h.unmatched += 1,
                    }
                }
            }) as audio_native::VirtualOutput
        };
        let state = NativeAudioState::default();
        let info = audio_native::start_engine_virtual(
            params(ep, cfg.frame_ms),
            &state,
            VirtualDevice {
                period_frames: cfg.period_frames,
                input,
                output,
                clock: Some(Arc::clone(&clock)),
            },
        );
        match info {
            Ok(info) => infos.push(info),
            Err(e) => {
                clock.stop();
                return Err(format!("engine {i}: {e}"));
            }
        }
        audio_native::set_mic_active(&state, true);
        engines.push(state);
    }

    let snap = |engines: &[NativeAudioState]| -> Vec<NativeStatsSnapshot> {
        engines.iter().map(|e| audio_native::stats_snapshot(e).unwrap_or_default()).collect()
    };
    std::thread::sleep(Duration::from_secs_f64(cfg.warmup_seconds));
    let s0 = snap(&engines);
    phase.store(PHASE_LATENCY, Ordering::Relaxed);
    std::thread::sleep(Duration::from_secs_f64(cfg.duration_seconds));
    // Let markers in flight arrive before switching the signal.
    phase.store(PHASE_WARMUP, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(500));
    let s1 = snap(&engines);
    let mut s2 = s1.clone();
    if clip.is_some() {
        phase.store(PHASE_SPEECH, Ordering::Relaxed);
        std::thread::sleep(Duration::from_secs_f64(cfg.speech_seconds));
        s2 = snap(&engines);
    }
    phase.store(PHASE_DONE, Ordering::Relaxed);
    for e in &engines {
        e.engine.lock().unwrap().take();
    }
    clock.stop();
    std::thread::sleep(Duration::from_millis(300));

    let markers_per_talker = (cfg.duration_seconds * 1000.0 / cfg.marker_interval_ms).floor() as usize;
    let h = heard.lock().unwrap();
    let mut all = Vec::new();
    let mut worst_pair_p95 = 0.0f64;
    let mut pairs_silent = 0usize;
    let mut heard_count = 0usize;
    for (talker, row) in h.latencies.iter().enumerate() {
        for (listener, v) in row.iter().enumerate() {
            if talker == listener {
                continue;
            }
            if v.is_empty() {
                pairs_silent += 1;
                continue;
            }
            heard_count += v.len();
            all.extend_from_slice(v);
            worst_pair_p95 = worst_pair_p95.max(dist(v.clone()).p95);
        }
    }
    let clipped = sum_diff(&s1, &s2, |x| x.clipped_samples);
    let mixed = sum_diff(&s1, &s2, |x| x.mixed_samples);
    let render_calls = sum_diff(&s1, &s2, |x| x.render_calls);
    let render_total = sum_diff(&s1, &s2, |x| x.render_total_us);
    Ok(serde_json::json!({
        "mode": "multi",
        "talkers": n,
        "frameMs": infos[0].frame_ms,
        "periodMs": infos[0].output.period_ms,
        "latencyMs": dist(all),
        "worstPairP95Ms": (worst_pair_p95 * 100.0).round() / 100.0,
        "pairs": n * (n - 1),
        "pairsSilent": pairs_silent,
        "markersExpected": markers_per_talker * n * (n - 1),
        "markersHeard": heard_count,
        "markersUnmatched": h.unmatched,
        "speechSeconds": if clip.is_some() { cfg.speech_seconds } else { 0.0 },
        "clippedPct": if mixed > 0 { (100_000.0 * clipped as f64 / mixed as f64).round() / 1000.0 } else { 0.0 },
        "renderAvgUs": if render_calls > 0 { render_total / render_calls } else { 0 },
        "renderMaxMs": s2.iter().map(|x| x.render_max_ms).fold(0.0f32, f32::max),
        "txPackets": sum_diff(&s0, &s1, |x| x.tx_packets),
        "rxPackets": sum_diff(&s0, &s1, |x| x.rx_packets),
        "concealed": sum_diff(&s0, &s1, |x| x.concealed),
        "fecRecovered": sum_diff(&s0, &s1, |x| x.fec_recovered),
        "latePackets": sum_diff(&s0, &s1, |x| x.late_packets),
        "jitterUnderruns": sum_diff(&s0, &s1, |x| x.jitter_underruns),
        "latencyTrims": sum_diff(&s0, &s1, |x| x.latency_trims),
        "rxGapsOver20ms": sum_diff(&s0, &s2, |x| x.rx_gaps_over_20ms),
        "rxQueueFull": sum_diff(&s0, &s2, |x| x.rx_queue_full),
        "virtualLateTicks": sum_diff(&s0, &s2, |x| x.virtual_late_ticks),
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
        (Some("multi"), Some(path)) => match read_config::<MultiConfig>(path) {
            Ok(cfg) => tokio::task::spawn_blocking(move || run_multi(cfg)).await.map_err(|e| e.to_string()).and_then(|r| r),
            Err(e) => Err(e),
        },
        (Some("hardware"), Some(path)) => match read_config::<HardwareConfig>(path) {
            Ok(cfg) => run_hardware(cfg).await,
            Err(e) => Err(e),
        },
        _ => Err("usage: kesher_audio_bench <virtual|multi|hardware> <config.json>".to_string()),
    };
    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            println!("{}", serde_json::json!({ "error": e }));
            std::process::exit(1);
        }
    }
}
