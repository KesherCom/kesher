//! Stream Deck plugged into this PC (decision 0008), via crates/kesher-deck.
//!
//! Events to the web UI:
//! - `stream_deck_status` ([`DeckStatus`]) when a deck connects, goes away
//!   or is a model this app does not drive yet;
//! - `stream_deck_key` ([`KeyEvent`]) for every key press and release.
//!
//! The web UI talks to the server (same endpoints as Companion with
//! `?deck=<serial>`) and sends the key images back with
//! `stream_deck_set_image`.

use std::sync::{Arc, Mutex};

use kesher_deck::{DeckEvent, DeckHandle, DeckInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatus {
    pub connected: bool,
    pub serial: String,
    pub model: String,
    pub keys: usize,
    pub columns: usize,
    pub image_size: u32,
    pub image_rotated: bool,
    /// An Elgato deck is plugged in that this app does not drive yet.
    pub unsupported_model: Option<String>,
    /// Why the last deck went away, if it did not just get unplugged.
    pub error: Option<String>,
}

impl DeckStatus {
    fn connected(info: &DeckInfo) -> Self {
        Self {
            connected: true,
            serial: info.serial.clone(),
            model: info.model.to_string(),
            keys: info.keys,
            columns: info.columns,
            image_size: info.image_size,
            image_rotated: info.image_rotated,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEvent {
    pub index: usize,
    pub pressed: bool,
}

pub struct StreamDeckState {
    handle: DeckHandle,
    status: Arc<Mutex<DeckStatus>>,
}

pub fn start(app: AppHandle) -> StreamDeckState {
    let status = Arc::new(Mutex::new(DeckStatus::default()));
    let shared = Arc::clone(&status);
    let handle = DeckHandle::start(move |event| {
        let next = match event {
            DeckEvent::Key { index, pressed } => {
                let _ = app.emit("stream_deck_key", KeyEvent { index, pressed });
                return;
            }
            DeckEvent::Connected(info) => DeckStatus::connected(&info),
            DeckEvent::Disconnected { reason } => DeckStatus { error: reason, ..DeckStatus::default() },
            DeckEvent::Unsupported { model } => {
                DeckStatus { unsupported_model: Some(model.to_string()), ..DeckStatus::default() }
            }
        };
        if let Ok(mut s) = shared.lock() {
            *s = next.clone();
        }
        let _ = app.emit("stream_deck_status", next);
    });
    StreamDeckState { handle, status }
}

#[tauri::command]
pub fn stream_deck_status(state: State<'_, StreamDeckState>) -> DeckStatus {
    match state.handle.current() {
        Some(info) => DeckStatus::connected(&info),
        None => state.status.lock().map(|s| s.clone()).unwrap_or_default(),
    }
}

/// `jpeg`: the key image, already sized and rotated for the model.
#[tauri::command]
pub fn stream_deck_set_image(state: State<'_, StreamDeckState>, index: u8, jpeg: Vec<u8>) {
    state.handle.set_image(index, jpeg);
}

#[tauri::command]
pub fn stream_deck_set_brightness(state: State<'_, StreamDeckState>, percent: u8) {
    state.handle.set_brightness(percent);
}
