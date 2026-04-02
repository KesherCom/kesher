/// Native audio engine for the Kesher desktop app.
///
/// Architecture:
///   Capture:  CPAL input → raw PCM f32 mono 48 kHz
///             → Opus encode (2.5 ms frames, CBR 24 kbps)
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
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
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
    track::{
        track_local::{track_local_static_sample::TrackLocalStaticSample, TrackLocal},
        track_remote::TrackRemote,
    },
};

// ── Constants ────────────────────────────────────────────────────────────────

/// 48 kHz mono – same as the SFU
const SAMPLE_RATE: u32 = 48_000;
/// 2.5 ms frames at 48 kHz = 120 samples
const OPUS_FRAME_SIZE: usize = 120;
/// Maximum encoded Opus packet size (bytes)
const MAX_OPUS_PACKET: usize = 256;
/// Default target bitrate in bits/s
const OPUS_BITRATE: i32 = 24_000;
/// Input mic gain range: 1.0 = unity, 2.0 = +6 dB, 8.0 = +18 dB,
/// 16.0 = +24 dB (global +6 dB base boost plus +18 dB slider).
const MIN_INPUT_GAIN: f32 = 0.0;
const MAX_INPUT_GAIN: f32 = 16.0;
const DEFAULT_INPUT_GAIN: f32 = 1.0;
/// Queue depth between CPAL capture callback and Opus encoder thread.
const CAPTURE_RAW_QUEUE_CAPACITY: usize = 4;
/// Queue depth between Opus encoder thread and async WebRTC sender.
const CAPTURE_ENCODED_QUEUE_CAPACITY: usize = 16;
/// Queue depth between async RTP reader and Opus decoder thread.
const PLAYBACK_OPUS_QUEUE_CAPACITY: usize = 8;
/// Queue depth between Opus decoder thread and CPAL output callback.
const PLAYBACK_PCM_QUEUE_CAPACITY: usize = 8;
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
    /// Dropping this sender shuts down the capture/encode/send loop.
    _shutdown: mpsc::Sender<()>,
}

fn clamp_input_gain(gain: f32) -> f32 {
    if !gain.is_finite() {
        return DEFAULT_INPUT_GAIN;
    }
    gain.max(MIN_INPUT_GAIN).min(MAX_INPUT_GAIN)
}

#[cfg(test)]
mod tests {
    use super::{clamp_input_gain, DEFAULT_INPUT_GAIN, MAX_INPUT_GAIN, MIN_INPUT_GAIN};

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
                    "minptime=2;useinbandfec=0;usedtx=0;stereo=0;cbr=1;maxaveragebitrate=24000"
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

    // ── 7. Wire up incoming tracks for playback ───────────────────────────
    let output_device_id = params.output_device_id.clone();
    let app_clone = app.clone();
    pc.on_track(Box::new(move |track, _receiver, _transceiver| {
        let output_device_id = output_device_id.clone();
        let app_clone = app_clone.clone();
        Box::pin(async move {
            tokio::spawn(playback_loop(track, output_device_id, app_clone));
        })
    }));

    // ── 8. Wire up capture → encode → send ───────────────────────────────
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);
    let ptt_active = Arc::new(AtomicBool::new(false));

    let input_gain = clamp_input_gain(params.input_gain.unwrap_or(DEFAULT_INPUT_GAIN));

    tokio::spawn(capture_loop(
        audio_track,
        Arc::clone(&ptt_active),
        params.input_device_id,
        input_gain,
        app.clone(),
        shutdown_rx,
    ));

    // ── 9. Persist engine state ───────────────────────────────────────────
    {
        let engine = RunningEngine {
            peer_connection: Arc::clone(&pc),
            ptt_active: Arc::clone(&ptt_active),
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
    track: Arc<TrackLocalStaticSample>,
    ptt_active: Arc<AtomicBool>,
    device_id: Option<String>,
    input_gain: f32,
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
        let _ = encoder.set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE));
        let _ = encoder.set_inband_fec(false);
        let _ = encoder.set_dtx(false);

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

                    for &s in &chunk {
                        let gained = s * input_gain;
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
    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                stop_flag.store(true, Ordering::Relaxed);
                break;
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
                            duration: std::time::Duration::from_millis(3),
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
    device_id: Option<String>,
    app: AppHandle,
) {
    // opus payload bytes: async WebRTC reader → sync decoder thread
    let (opus_tx, opus_rx) =
        std::sync::mpsc::sync_channel::<OpusFrame>(PLAYBACK_OPUS_QUEUE_CAPACITY);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop_flag);
    let app_clone = app.clone();

    // ── Sync thread: owns !Send cpal::Stream + Opus decoder ─────────────
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match find_output_device(&host, device_id.as_deref()) {
            Some(d) => d,
            None => { log::error!("[audio] playback: no output device"); return; }
        };
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(SAMPLE_RATE),
            buffer_size: cpal::BufferSize::Fixed(OPUS_FRAME_SIZE as u32),
        };
        // PCM ring: decoder → CPAL output callback
        let (pcm_tx, pcm_rx) =
            std::sync::mpsc::sync_channel::<PcmFrame>(PLAYBACK_PCM_QUEUE_CAPACITY);
        let pcm_queue_latency = Arc::new(AtomicLatencyStats::default());
        let pcm_queue_latency_cb = Arc::clone(&pcm_queue_latency);
        let output_drop_counter = Arc::new(AtomicU64::new(0));
        let output_drop_counter_cb = Arc::clone(&output_drop_counter);
        let stream = match device.build_output_stream(
            &config,
            move |output: &mut [f32], _| {
                if let Ok(frame) = pcm_rx.try_recv() {
                    pcm_queue_latency_cb.record(frame.decoded_at.elapsed());
                    let n = output.len().min(frame.samples.len());
                    output[..n].copy_from_slice(&frame.samples[..n]);
                    if n < output.len() { output[n..].fill(0.0); }
                } else {
                    output_drop_counter_cb.fetch_add(1, Ordering::Relaxed);
                    output.fill(0.0);
                }
            },
            |err| log::error!("[audio] output stream error: {err}"),
            None,
        ) {
            Ok(s) => s,
            Err(e) => { log::error!("[audio] build output stream: {e}"); return; }
        };
        if let Err(e) = stream.play() {
            log::error!("[audio] start output stream: {e}"); return;
        }
        let mut decoder = match Decoder::new(SAMPLE_RATE, Channels::Mono) {
            Ok(d) => d,
            Err(e) => { log::error!("[audio] create decoder: {e}"); return; }
        };
        let mut decode_buf = [0.0f32; OPUS_FRAME_SIZE * 4];
        let mut output_peak = 0.0f32;
        let mut meter_frames: u32 = 0;
        let mut dropped_pcm_frames: u32 = 0;
        let mut rtp_queue_count: u64 = 0;
        let mut rtp_queue_sum_ms: f64 = 0.0;
        let mut rtp_queue_max_ms: f64 = 0.0;
        let mut next_latency_log = Instant::now() + LATENCY_LOG_INTERVAL;

        loop {
            if stop_clone.load(Ordering::Relaxed) { break; }
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
                            let pcm = decode_buf[..n].to_vec();
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
                        Err(e) => log::warn!("[audio] opus decode: {e}"),
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
                        log::info!(
                            "[audio][latency] playback_rtp_queue avg_ms={:.2} max_ms={:.2} samples={} | playback_pcm_queue avg_ms={:.2} max_ms={:.2} samples={} | pcm_drops={} underruns={}",
                            rtp_avg_ms,
                            rtp_queue_max_ms,
                            rtp_queue_count,
                            pcm_avg_ms,
                            pcm_max_ms,
                            pcm_samples,
                            dropped_pcm_frames,
                            output_underruns
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
        drop(stream);
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

/// Tear down the current engine (called on disconnect).
pub async fn stop_engine(state: &AudioEngineState) {
    let engine = state.engine.lock().unwrap().take();
    if let Some(e) = engine {
        let _ = e.peer_connection.close().await;
    }
}
