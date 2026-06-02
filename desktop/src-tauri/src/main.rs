#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod audio_engine;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod audio_native;
mod config;

#[cfg(target_os = "windows")]
use audio_engine::{
    AudioDeviceInfo, AudioEngineState, EngineAnswerPayload, StartEngineParams,
};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use audio_native::{NativeAudioState, StartNativeParams};
use config::{get_server_url, set_server_url};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::State;

// ── IPC: device enumeration ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
#[tauri::command]
fn list_audio_devices() -> Vec<AudioDeviceInfo> {
    audio_engine::enumerate_devices()
}

// ── IPC: engine lifecycle ─────────────────────────────────────────────────────

/// Start the native audio engine.
/// Called by JS after receiving a WebRTC offer from the Go SFU.
/// Returns the answer SDP + gathered ICE candidates so JS can relay them.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_audio_engine(
    app: tauri::AppHandle,
    params: StartEngineParams,
    state: State<'_, AudioEngineState>,
) -> Result<EngineAnswerPayload, String> {
    audio_engine::start_engine(app, params, state).await
}

/// Stop the native audio engine (called on logout / disconnect).
#[cfg(target_os = "windows")]
#[tauri::command]
async fn stop_audio_engine(state: State<'_, AudioEngineState>) -> Result<(), String> {
    audio_engine::stop_engine(&state).await;
    Ok(())
}

// ── IPC: PTT control ──────────────────────────────────────────────────────────

/// Set PTT state from the WebView.  `active=true` opens the send gate.
#[cfg(target_os = "windows")]
#[tauri::command]
fn set_ptt(active: bool, state: State<'_, AudioEngineState>) {
    audio_engine::set_ptt(&state, active);
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_input_gain(gain: f32, state: State<'_, AudioEngineState>) {
    audio_engine::set_input_gain(&state, gain);
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_audio_gate(enabled: bool, threshold_db: f32, state: State<'_, AudioEngineState>) {
    audio_engine::set_audio_gate(&state, enabled, threshold_db);
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_output_gains(gains_by_user_id: std::collections::HashMap<String, f32>, state: State<'_, AudioEngineState>) {
    audio_engine::set_output_gains(&state, gains_by_user_id);
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_output_device(output_device_id: Option<String>, state: State<'_, AudioEngineState>) {
    audio_engine::set_output_device(&state, output_device_id);
}

// ── IPC: native (UDP) audio engine for the Performance Mode ──────────────────

/// Start the native low-latency audio pipeline. Called by the WebView after
/// it received the `native_audio_endpoint` message over the WebSocket.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
async fn start_native_audio(
    params: StartNativeParams,
    state: State<'_, NativeAudioState>,
) -> Result<(), String> {
    audio_native::start_engine(params, state).await
}

/// Stop the native engine (called on logout / disconnect or fallback to
/// WebRTC).
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
async fn stop_native_audio(state: State<'_, NativeAudioState>) -> Result<(), String> {
    audio_native::stop_engine(&state).await;
    Ok(())
}

/// PTT-style mic gate for the native pipeline. Mirrors the WebRTC engine's
/// `set_ptt`.
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command]
fn set_native_mic(active: bool, state: State<'_, NativeAudioState>) {
    audio_native::set_mic_active(&state, active);
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    #[cfg(target_os = "windows")]
    {
        tauri::Builder::default()
            .manage(audio_engine::AudioEngineState::default())
            .manage(audio_native::NativeAudioState::default())
            .invoke_handler(tauri::generate_handler![
                get_server_url,
                set_server_url,
                list_audio_devices,
                start_audio_engine,
                stop_audio_engine,
                set_ptt,
                set_input_gain,
                set_audio_gate,
                set_output_gains,
                set_output_device,
                start_native_audio,
                stop_native_audio,
                set_native_mic,
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }

    #[cfg(target_os = "macos")]
    {
        tauri::Builder::default()
            .manage(audio_native::NativeAudioState::default())
            .invoke_handler(tauri::generate_handler![
                get_server_url,
                set_server_url,
                start_native_audio,
                stop_native_audio,
                set_native_mic,
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
                get_server_url,
                set_server_url,
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

fn main() {
    run();
}

