//! Native low-latency audio engine for the Kesher Performance Mode.
//!
//! This module is the desktop counterpart to the Go `UDPAudioRelay`
//! (see `backend/internal/app/udp_audio.go`). It runs alongside the
//! existing WebRTC-based engine in `audio_engine.rs` (Windows only) and is
//! always available on Windows + macOS. Browser clients keep using WebRTC.
//!
//! Pipeline summary:
//!
//!   Capture:   Default input via CPAL (BufferSize::Fixed(128) requested,
//!              actual size depends on driver) → mono f32 48 kHz →
//!              5 ms accumulator (240 samples) → Opus encoder (LowDelay,
//!              48 kbps CBR, in-band FEC) → UDP packet with KSHR header →
//!              tokio::net::UdpSocket → server's relay address.
//!
//!   Playback:  UDP recv → KSHR header parse → Opus decode → 1-frame jitter
//!              buffer → CPAL default output (BufferSize::Fixed(128)).
//!
//!   Heartbeat: every 1 s while the engine is running, to keep the relay's
//!              source-address binding fresh.
//!
//! WASAPI Exclusive on Windows is *not yet* enabled here; cpal 0.15 only
//! supports Shared mode. Stage 2 will add a `wasapi-exclusive` Cargo feature
//! that swaps in a direct WASAPI bindings path.

#![allow(clippy::too_many_arguments)]

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use opus::{Application, Channels, Decoder, Encoder};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

// ── Constants ────────────────────────────────────────────────────────────

/// 48 kHz mono — matches the relay/codec contract.
pub const NATIVE_SAMPLE_RATE: u32 = 48_000;
/// 5 ms @ 48 kHz = 240 samples.
pub const NATIVE_FRAME_SAMPLES: usize = 240;
/// Hardware-buffer wish size; the driver may round up.
pub const NATIVE_HW_BUFFER_SAMPLES: u32 = 128;
/// Opus 5 ms encoded payloads at 48 kbps stay well below this.
pub const NATIVE_MAX_OPUS_PACKET: usize = 256;
/// Default Opus bitrate for the performance profile.
pub const NATIVE_OPUS_BITRATE: i32 = 48_000;

/// UDP wire-format constants — mirror the Go side `udp_audio.go`.
const UDP_MAGIC: &[u8; 4] = b"KSHR";
const UDP_VERSION: u8 = 0x01;
const UDP_HEADER_LEN: usize = 16;
const UDP_FLAG_AUDIO: u8 = 1 << 0;
const UDP_FLAG_REGISTER: u8 = 1 << 1;
const UDP_FLAG_HEARTBEAT: u8 = 1 << 2;

/// Channel depths (small to keep latency low; drops are preferred over delay).
const CAPTURE_QUEUE_DEPTH: usize = 4;
const PLAYBACK_QUEUE_DEPTH: usize = 4;

/// Heartbeat cadence (relay expires peers after 8 s without any packet).
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(1000);

// ── Public IPC types ─────────────────────────────────────────────────────

/// Parameters required to start the native engine. Sent by the WebView once
/// it received `native_audio_endpoint` over the WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartNativeParams {
    pub server_host: String,
    pub server_port: u16,
    pub session_token: String,
    pub token_hash: u32,
    /// Optional CPAL input device name; default if None.
    pub input_device_id: Option<String>,
    /// Optional CPAL output device name; default if None.
    pub output_device_id: Option<String>,
}

/// Tauri-managed runtime state.
pub struct NativeAudioState {
    pub engine: Mutex<Option<RunningNativeEngine>>,
}

impl Default for NativeAudioState {
    fn default() -> Self {
        Self {
            engine: Mutex::new(None),
        }
    }
}

/// A live native engine. Dropping it stops both capture and playback.
pub struct RunningNativeEngine {
    pub mic_active: Arc<AtomicBool>,
    /// Dropping the sender ends the async send/heartbeat loop.
    _shutdown_tx: mpsc::Sender<()>,
    /// Stops the background capture/playback threads when set.
    stop_flag: Arc<AtomicBool>,
}

// ── Wire-format helpers ──────────────────────────────────────────────────

fn write_header(buf: &mut [u8], flags: u8, sequence: u16, timestamp: u32, token_hash: u32) {
    buf[0..4].copy_from_slice(UDP_MAGIC);
    buf[4] = UDP_VERSION;
    buf[5] = flags;
    buf[6..8].copy_from_slice(&sequence.to_be_bytes());
    buf[8..12].copy_from_slice(&timestamp.to_be_bytes());
    buf[12..16].copy_from_slice(&token_hash.to_be_bytes());
}

/// Decoded view of a server-origin packet. Payload aliases the recv buffer.
struct ParsedPacket<'a> {
    flags: u8,
    payload: &'a [u8],
}

fn parse_header(buf: &[u8]) -> Option<ParsedPacket<'_>> {
    if buf.len() < UDP_HEADER_LEN {
        return None;
    }
    if &buf[0..4] != UDP_MAGIC {
        return None;
    }
    if buf[4] != UDP_VERSION {
        return None;
    }
    Some(ParsedPacket {
        flags: buf[5],
        payload: &buf[UDP_HEADER_LEN..],
    })
}

// ── Capture path ─────────────────────────────────────────────────────────

/// Frame ready to be sent over UDP. Owns the encoded Opus bytes.
struct EncodedFrame {
    bytes: Vec<u8>,
    captured_at: Instant,
}

fn build_input_stream(
    device_name: Option<&str>,
    sample_tx: std::sync::mpsc::SyncSender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .input_devices()
            .map_err(|e| format!("input_devices: {e}"))?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("input device {name} not found"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| "no default input device".to_string())?,
    };
    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(NATIVE_SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Fixed(NATIVE_HW_BUFFER_SAMPLES),
    };
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                // Best-effort send; drop on backpressure to preserve latency.
                let _ = sample_tx.try_send(data.to_vec());
            },
            |err| log::warn!("[native][capture] stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build_input_stream: {e}"))?;
    stream.play().map_err(|e| format!("input stream play: {e}"))?;
    Ok(stream)
}

/// Spawns the OS-thread that owns the !Send CPAL input stream and the
/// Opus encoder. Encoded 5 ms frames flow back over `encoded_tx`.
fn spawn_capture_thread(
    device_name: Option<String>,
    mic_active: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    encoded_tx: mpsc::Sender<EncodedFrame>,
) {
    std::thread::spawn(move || {
        let (raw_tx, raw_rx) =
            std::sync::mpsc::sync_channel::<Vec<f32>>(CAPTURE_QUEUE_DEPTH);
        let stream = match build_input_stream(device_name.as_deref(), raw_tx) {
            Ok(s) => s,
            Err(e) => {
                log::error!("[native][capture] init failed: {e}");
                return;
            }
        };
        let mut encoder = match Encoder::new(NATIVE_SAMPLE_RATE, Channels::Mono, Application::LowDelay) {
            Ok(e) => e,
            Err(e) => {
                log::error!("[native][capture] opus encoder init: {e}");
                drop(stream);
                return;
            }
        };
        let _ = encoder.set_bitrate(opus::Bitrate::Bits(NATIVE_OPUS_BITRATE));
        let _ = encoder.set_inband_fec(true);

        let silence = vec![0.0f32; NATIVE_FRAME_SAMPLES];
        let mut accum: Vec<f32> = Vec::with_capacity(NATIVE_FRAME_SAMPLES * 4);
        let mut buf = [0u8; NATIVE_MAX_OPUS_PACKET];

        while !stop_flag.load(Ordering::Relaxed) {
            match raw_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(chunk) => {
                    accum.extend_from_slice(&chunk);
                    while accum.len() >= NATIVE_FRAME_SAMPLES {
                        let frame: &[f32] = if mic_active.load(Ordering::Acquire) {
                            &accum[..NATIVE_FRAME_SAMPLES]
                        } else {
                            &silence
                        };
                        match encoder.encode_float(frame, &mut buf) {
                            Ok(n) => {
                                if encoded_tx
                                    .try_send(EncodedFrame {
                                        bytes: buf[..n].to_vec(),
                                        captured_at: Instant::now(),
                                    })
                                    .is_err()
                                {
                                    // Async sender backed up; drop frame.
                                }
                            }
                            Err(e) => log::debug!("[native][capture] opus encode: {e}"),
                        }
                        accum.drain(..NATIVE_FRAME_SAMPLES);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        drop(stream);
        log::info!("[native][capture] thread exit");
    });
}

// ── Playback path ────────────────────────────────────────────────────────

fn build_output_stream(
    device_name: Option<&str>,
    pcm_rx: std::sync::mpsc::Receiver<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .output_devices()
            .map_err(|e| format!("output_devices: {e}"))?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("output device {name} not found"))?,
        None => host
            .default_output_device()
            .ok_or_else(|| "no default output device".to_string())?,
    };
    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(NATIVE_SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Fixed(NATIVE_HW_BUFFER_SAMPLES),
    };
    let pcm_rx = std::sync::Mutex::new(pcm_rx);
    let mut tail: Vec<f32> = Vec::with_capacity(NATIVE_FRAME_SAMPLES);
    let stream = device
        .build_output_stream(
            &config,
            move |output: &mut [f32], _| {
                let mut written = 0usize;
                // Drain any leftover samples from a previous decoded frame.
                if !tail.is_empty() {
                    let n = tail.len().min(output.len());
                    output[..n].copy_from_slice(&tail[..n]);
                    written += n;
                    tail.drain(..n);
                }
                while written < output.len() {
                    let next = pcm_rx.lock().ok().and_then(|rx| rx.try_recv().ok());
                    match next {
                        Some(frame) => {
                            let need = output.len() - written;
                            if frame.len() <= need {
                                output[written..written + frame.len()]
                                    .copy_from_slice(&frame);
                                written += frame.len();
                            } else {
                                output[written..].copy_from_slice(&frame[..need]);
                                tail.extend_from_slice(&frame[need..]);
                                written = output.len();
                            }
                        }
                        None => {
                            // Underrun: fill with silence rather than block.
                            for s in &mut output[written..] {
                                *s = 0.0;
                            }
                            return;
                        }
                    }
                }
            },
            |err| log::warn!("[native][playback] stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build_output_stream: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("output stream play: {e}"))?;
    Ok(stream)
}

/// Spawns the OS-thread that owns the !Send CPAL output stream and the
/// Opus decoder. Encoded payloads come in over `opus_rx`.
fn spawn_playback_thread(
    device_name: Option<String>,
    stop_flag: Arc<AtomicBool>,
    opus_rx: std::sync::mpsc::Receiver<Vec<u8>>,
) {
    std::thread::spawn(move || {
        let (pcm_tx, pcm_rx) =
            std::sync::mpsc::sync_channel::<Vec<f32>>(PLAYBACK_QUEUE_DEPTH);
        // Forward decoded samples to the audio callback's bounded queue.
        let _stream = match build_output_stream(device_name.as_deref(), pcm_rx) {
            Ok(s) => s,
            Err(e) => {
                log::error!("[native][playback] init failed: {e}");
                return;
            }
        };
        let mut decoder = match Decoder::new(NATIVE_SAMPLE_RATE, Channels::Mono) {
            Ok(d) => d,
            Err(e) => {
                log::error!("[native][playback] opus decoder init: {e}");
                return;
            }
        };
        let mut decode_buf = [0.0f32; NATIVE_FRAME_SAMPLES * 4];
        while !stop_flag.load(Ordering::Relaxed) {
            match opus_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(payload) => match decoder.decode_float(&payload, &mut decode_buf, false) {
                    Ok(n) => {
                        let frame = decode_buf[..n].to_vec();
                        if pcm_tx.try_send(frame).is_err() {
                            // Audio device backed up; drop.
                        }
                    }
                    Err(e) => log::debug!("[native][playback] opus decode: {e}"),
                },
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        log::info!("[native][playback] thread exit");
    });
}

// ── Async UDP send/recv loop ─────────────────────────────────────────────

async fn run_udp_loop(
    socket: UdpSocket,
    server_addr: SocketAddr,
    session_token: String,
    token_hash: u32,
    mut shutdown_rx: mpsc::Receiver<()>,
    mut encoded_rx: mpsc::Receiver<EncodedFrame>,
    opus_tx: std::sync::mpsc::SyncSender<Vec<u8>>,
) {
    // 1. REGISTER once so the relay learns our source address.
    let mut register = vec![0u8; UDP_HEADER_LEN + session_token.len()];
    write_header(&mut register, UDP_FLAG_REGISTER, 0, 0, token_hash);
    register[UDP_HEADER_LEN..].copy_from_slice(session_token.as_bytes());
    if let Err(e) = socket.send_to(&register, server_addr).await {
        log::warn!("[native][udp] register send: {e}");
    }

    // 2. Send-heartbeat-recv loop.
    let mut tx_seq: u16 = 0;
    let mut tx_timestamp: u32 = 0;
    let mut hb = tokio::time::interval(HEARTBEAT_INTERVAL);
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut recv_buf = vec![0u8; 1500];

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                log::info!("[native][udp] shutdown received");
                break;
            }
            _ = hb.tick() => {
                let mut beat = [0u8; UDP_HEADER_LEN];
                write_header(&mut beat, UDP_FLAG_HEARTBEAT, tx_seq, tx_timestamp, token_hash);
                let _ = socket.send_to(&beat, server_addr).await;
            }
            maybe = encoded_rx.recv() => {
                let Some(frame) = maybe else { break };
                let mut pkt = vec![0u8; UDP_HEADER_LEN + frame.bytes.len()];
                tx_seq = tx_seq.wrapping_add(1);
                tx_timestamp = tx_timestamp.wrapping_add(NATIVE_FRAME_SAMPLES as u32);
                write_header(&mut pkt, UDP_FLAG_AUDIO, tx_seq, tx_timestamp, token_hash);
                pkt[UDP_HEADER_LEN..].copy_from_slice(&frame.bytes);
                if let Err(e) = socket.send_to(&pkt, server_addr).await {
                    log::debug!("[native][udp] send_to error: {e}");
                }
                // Latency telemetry (cheap, ~once per 5 ms).
                let queue_ms = frame.captured_at.elapsed().as_secs_f64() * 1000.0;
                if queue_ms > 25.0 {
                    log::warn!("[native][udp] capture->send queue {:.2} ms", queue_ms);
                }
            }
            recv_res = socket.recv_from(&mut recv_buf) => {
                let (n, _src) = match recv_res {
                    Ok(t) => t,
                    Err(e) => {
                        log::debug!("[native][udp] recv error: {e}");
                        continue;
                    }
                };
                let pkt = match parse_header(&recv_buf[..n]) {
                    Some(p) => p,
                    None => continue,
                };
                if pkt.flags & UDP_FLAG_AUDIO != 0 && !pkt.payload.is_empty() {
                    let _ = opus_tx.try_send(pkt.payload.to_vec());
                }
            }
        }
    }
}

// ── Engine lifecycle (Tauri commands call into this) ─────────────────────

/// Start the native engine. Returns Ok(()) once the UDP socket is bound and
/// the background loops are running.
pub async fn start_engine(
    params: StartNativeParams,
    state: tauri::State<'_, NativeAudioState>,
) -> Result<(), String> {
    {
        let guard = state.engine.lock().unwrap();
        if guard.is_some() {
            return Err("native engine already running".to_string());
        }
    }
    let server_addr: SocketAddr = format!("{}:{}", params.server_host, params.server_port)
        .parse()
        .map_err(|e| format!("invalid server addr: {e}"))?;
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("bind udp: {e}"))?;
    socket
        .connect(server_addr)
        .await
        .map_err(|e| format!("connect udp: {e}"))?;

    let mic_active = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);
    let (encoded_tx, encoded_rx) = mpsc::channel::<EncodedFrame>(8);
    let (opus_to_decoder_tx, opus_to_decoder_rx) =
        std::sync::mpsc::sync_channel::<Vec<u8>>(8);

    spawn_capture_thread(
        params.input_device_id.clone(),
        Arc::clone(&mic_active),
        Arc::clone(&stop_flag),
        encoded_tx,
    );
    spawn_playback_thread(
        params.output_device_id.clone(),
        Arc::clone(&stop_flag),
        opus_to_decoder_rx,
    );

    let session_token = params.session_token.clone();
    let token_hash = params.token_hash;
    tokio::spawn(async move {
        run_udp_loop(
            socket,
            server_addr,
            session_token,
            token_hash,
            shutdown_rx,
            encoded_rx,
            opus_to_decoder_tx,
        )
        .await;
    });

    let engine = RunningNativeEngine {
        mic_active,
        _shutdown_tx: shutdown_tx,
        stop_flag,
    };
    *state.engine.lock().unwrap() = Some(engine);
    log::info!(
        "[native] engine started: target={} session_hash={}",
        server_addr,
        params.token_hash
    );
    Ok(())
}

/// Stop the native engine. Idempotent.
pub async fn stop_engine(state: &NativeAudioState) {
    let engine = state.engine.lock().unwrap().take();
    if let Some(e) = engine {
        e.stop_flag.store(true, Ordering::Relaxed);
        // Dropping shutdown_tx ends the async loop; threads pick up stop_flag.
    }
}

/// Toggle mic capture (mirrors the WebRTC engine's PTT).
pub fn set_mic_active(state: &NativeAudioState, active: bool) {
    if let Some(engine) = state.engine.lock().unwrap().as_ref() {
        engine.mic_active.store(active, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_size_matches_5ms_at_48k() {
        // 5 ms * 48000 Hz = 240 samples
        assert_eq!(NATIVE_FRAME_SAMPLES, 240);
    }

    #[test]
    fn header_round_trip() {
        let mut buf = [0u8; UDP_HEADER_LEN + 4];
        write_header(&mut buf, UDP_FLAG_AUDIO, 0xABCD, 0x12345678, 0xDEADBEEF);
        buf[UDP_HEADER_LEN..].copy_from_slice(&[1, 2, 3, 4]);
        let parsed = parse_header(&buf).expect("decode");
        assert_eq!(parsed.flags, UDP_FLAG_AUDIO);
        assert_eq!(parsed.payload, &[1, 2, 3, 4]);
    }

    #[test]
    fn header_rejects_bad_magic() {
        let mut buf = [0u8; UDP_HEADER_LEN];
        buf[0..4].copy_from_slice(b"XXXX");
        buf[4] = UDP_VERSION;
        assert!(parse_header(&buf).is_none());
    }
}
