mod audio_engine;
mod config;

use audio_engine::{
    AudioDeviceInfo, AudioEngineState, EngineAnswerPayload, StartEngineParams,
};
use config::{get_server_url, set_server_url};
use tauri::State;

// ── IPC: device enumeration ───────────────────────────────────────────────────

#[tauri::command]
fn list_audio_devices() -> Vec<AudioDeviceInfo> {
    audio_engine::enumerate_devices()
}

// ── IPC: engine lifecycle ─────────────────────────────────────────────────────

/// Start the native audio engine.
/// Called by JS after receiving a WebRTC offer from the Go SFU.
/// Returns the answer SDP + gathered ICE candidates so JS can relay them.
#[tauri::command]
async fn start_audio_engine(
    app: tauri::AppHandle,
    params: StartEngineParams,
    state: State<'_, AudioEngineState>,
) -> Result<EngineAnswerPayload, String> {
    audio_engine::start_engine(app, params, state).await
}

/// Stop the native audio engine (called on logout / disconnect).
#[tauri::command]
async fn stop_audio_engine(state: State<'_, AudioEngineState>) -> Result<(), String> {
    audio_engine::stop_engine(&state).await;
    Ok(())
}

// ── IPC: PTT control ──────────────────────────────────────────────────────────

/// Set PTT state from the WebView.  `active=true` opens the send gate.
#[tauri::command]
fn set_ptt(active: bool, state: State<'_, AudioEngineState>) {
    audio_engine::set_ptt(&state, active);
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .manage(AudioEngineState::default())
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            set_server_url,
            list_audio_devices,
            start_audio_engine,
            stop_audio_engine,
            set_ptt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}

