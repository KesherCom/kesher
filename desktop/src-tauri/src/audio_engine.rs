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
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
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

    tokio::spawn(capture_loop(
        audio_track,
        Arc::clone(&ptt_active),
        params.input_device_id,
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
    app: AppHandle,
    mut shutdown: mpsc::Receiver<()>,
) {
    // ── Sync thread: owns !Send cpal::Stream + Opus encoder ─────────────
    // encoded bytes flow: sync thread → tokio channel → async WebRTC sender
    let (encoded_tx, mut encoded_rx) = mpsc::channel::<bytes::Bytes>(32);
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
        let (raw_tx, raw_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(8);
        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _| { let _ = raw_tx.try_send(data.to_vec()); },
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

        loop {
            if stop_clone.load(Ordering::Relaxed) { break; }
            match raw_rx.recv_timeout(std::time::Duration::from_millis(20)) {
                Ok(chunk) => {
                    for &s in &chunk { if s.abs() > input_peak { input_peak = s.abs(); } }
                    pcm_accum.extend_from_slice(&chunk);
                    meter_frames += chunk.len() as u32;
                    if meter_frames >= 2400 {
                        let _ = app_clone.emit("audio_level_meter", LevelMeterEvent {
                            input_peak, output_peak: 0.0,
                        });
                        input_peak = 0.0;
                        meter_frames = 0;
                    }
                    while pcm_accum.len() >= OPUS_FRAME_SIZE {
                        let frame: Vec<f32> = pcm_accum.drain(..OPUS_FRAME_SIZE).collect();
                        let active = ptt_clone.load(Ordering::Acquire);
                        let src: &[f32] = if active { &frame } else { &silence };
                        if let Ok(n) = encoder.encode_float(src, &mut buf) {
                            let _ = encoded_tx.blocking_send(
                                bytes::Bytes::copy_from_slice(&buf[..n])
                            );
                        }
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
    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                stop_flag.store(true, Ordering::Relaxed);
                break;
            }
            maybe = encoded_rx.recv() => {
                match maybe {
                    Some(data) => {
                        let sample = Sample {
                            data,
                            duration: std::time::Duration::from_millis(3),
                            ..Default::default()
                        };
                        if let Err(e) = track.write_sample(&sample).await {
                            log::warn!("[audio] track write: {e}");
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
    let (opus_tx, opus_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(16);
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
        let (pcm_tx, pcm_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(16);
        let stream = match device.build_output_stream(
            &config,
            move |output: &mut [f32], _| {
                if let Ok(chunk) = pcm_rx.try_recv() {
                    let n = output.len().min(chunk.len());
                    output[..n].copy_from_slice(&chunk[..n]);
                    if n < output.len() { output[n..].fill(0.0); }
                } else {
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

        loop {
            if stop_clone.load(Ordering::Relaxed) { break; }
            match opus_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(payload) => {
                    match decoder.decode_float(&payload, &mut decode_buf, false) {
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
                            let _ = pcm_tx.try_send(pcm);
                        }
                        Err(e) => log::warn!("[audio] opus decode: {e}"),
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
    loop {
        match track.read(&mut rtp_buf).await {
            Ok((packet, _attr)) => {
                let payload = packet.payload.to_vec();
                if opus_tx.try_send(payload).is_err() {
                    log::warn!("[audio] playback channel full, dropping frame");
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
