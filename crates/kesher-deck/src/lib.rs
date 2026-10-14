//! Elgato Stream Deck over USB HID (decision 0008): the desktop app drives a
//! deck plugged into its own PC directly, without Companion.
//!
//! [`DeckHandle::start`] runs one worker thread that finds a supported deck
//! (and finds it again after it was unplugged), reports key presses and
//! connection changes through a callback, and writes key images and the
//! backlight. Images arrive ready for the model (JPEG, sized and rotated, see
//! [`protocol::Model`]); this crate does not touch pixels.

pub mod protocol;

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use hidapi::{HidApi, HidDevice};
use protocol::{Model, ELGATO_VENDOR_ID, INPUT_REPORT_LEN};

/// A connected deck, as the app shows and addresses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckInfo {
    pub serial: String,
    pub model: &'static str,
    pub keys: usize,
    pub columns: usize,
    pub image_size: u32,
    pub image_rotated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeckEvent {
    Connected(DeckInfo),
    /// The deck was unplugged or could not be used (`reason` says why).
    Disconnected { reason: Option<String> },
    /// An Elgato deck is plugged in that this app does not drive yet.
    Unsupported { model: &'static str },
    Key { index: usize, pressed: bool },
}

enum Command {
    SetImage { key: u8, jpeg: Vec<u8> },
    SetBrightness(u8),
}

/// How often to look for a deck while none is connected.
const SEARCH_INTERVAL: Duration = Duration::from_millis(1500);
/// Read timeout while connected: also the longest a queued image waits.
const READ_TIMEOUT_MS: i32 = 10;
const DEFAULT_BRIGHTNESS: u8 = 70;

pub struct DeckHandle {
    commands: Sender<Command>,
    current: Arc<Mutex<Option<DeckInfo>>>,
}

impl DeckHandle {
    /// Starts the worker. `on_event` is called from the worker thread.
    pub fn start(on_event: impl Fn(DeckEvent) + Send + 'static) -> Self {
        let (commands, rx) = mpsc::channel();
        let current = Arc::new(Mutex::new(None));
        let worker_current = Arc::clone(&current);
        thread::Builder::new()
            .name("kesher-deck".into())
            .spawn(move || run(rx, worker_current, on_event))
            .expect("spawn stream deck thread");
        Self { commands, current }
    }

    /// The connected deck, if any.
    pub fn current(&self) -> Option<DeckInfo> {
        self.current.lock().ok().and_then(|c| c.clone())
    }

    pub fn set_image(&self, key: u8, jpeg: Vec<u8>) {
        let _ = self.commands.send(Command::SetImage { key, jpeg });
    }

    pub fn set_brightness(&self, percent: u8) {
        let _ = self.commands.send(Command::SetBrightness(percent));
    }
}

struct Open {
    device: HidDevice,
    info: DeckInfo,
    keys: Vec<bool>,
}

fn run(rx: Receiver<Command>, current: Arc<Mutex<Option<DeckInfo>>>, on_event: impl Fn(DeckEvent)) {
    let mut api = match HidApi::new() {
        Ok(api) => api,
        Err(err) => {
            log::warn!("stream deck: USB HID unavailable: {err}");
            return;
        }
    };
    let mut open: Option<Open> = None;
    let mut reported_unsupported: Option<u16> = None;
    let mut last_search: Option<Instant> = None;
    let mut buf = vec![0u8; INPUT_REPORT_LEN];

    loop {
        let Some(deck) = open.as_mut() else {
            // Not connected: drop queued work, look for a deck now and then.
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if last_search.is_some_and(|t| t.elapsed() < SEARCH_INTERVAL) {
                continue;
            }
            last_search = Some(Instant::now());
            match find(&mut api) {
                Found::Supported(found) => {
                    log::info!("stream deck: {} {} connected", found.info.model, found.info.serial);
                    reported_unsupported = None;
                    set_current(&current, Some(found.info.clone()));
                    on_event(DeckEvent::Connected(found.info.clone()));
                    open = Some(found);
                }
                Found::Unsupported(pid) if reported_unsupported != Some(pid) => {
                    reported_unsupported = Some(pid);
                    on_event(DeckEvent::Unsupported { model: protocol::elgato_model_name(pid) });
                }
                Found::Unsupported(_) | Found::Nothing => {}
            }
            continue;
        };

        let mut failure: Option<String> = None;
        loop {
            match rx.try_recv() {
                Ok(command) => {
                    if let Err(err) = apply(&deck.device, command) {
                        failure = Some(err.to_string());
                        break;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }
        if failure.is_none() {
            match deck.device.read_timeout(&mut buf, READ_TIMEOUT_MS) {
                Ok(0) => {}
                Ok(n) => {
                    if let Some(states) = protocol::parse_key_states(&buf[..n], deck.info.keys) {
                        for (index, (&now, was)) in states.iter().zip(deck.keys.iter_mut()).enumerate() {
                            if now != *was {
                                *was = now;
                                on_event(DeckEvent::Key { index, pressed: now });
                            }
                        }
                    }
                }
                Err(err) => failure = Some(err.to_string()),
            }
        }
        if let Some(reason) = failure {
            log::info!("stream deck: disconnected ({reason})");
            // Release keys that were held when it went away.
            for (index, held) in deck.keys.iter().enumerate() {
                if *held {
                    on_event(DeckEvent::Key { index, pressed: false });
                }
            }
            open = None;
            last_search = Some(Instant::now());
            set_current(&current, None);
            on_event(DeckEvent::Disconnected { reason: Some(reason) });
        }
    }
}

fn apply(device: &HidDevice, command: Command) -> hidapi::HidResult<()> {
    match command {
        Command::SetImage { key, jpeg } => {
            for report in protocol::image_reports(key, &jpeg) {
                device.write(&report)?;
            }
        }
        Command::SetBrightness(percent) => device.send_feature_report(&protocol::brightness_report(percent))?,
    }
    Ok(())
}

enum Found {
    Supported(Open),
    Unsupported(u16),
    Nothing,
}

fn find(api: &mut HidApi) -> Found {
    if let Err(err) = api.refresh_devices() {
        log::debug!("stream deck: device list failed: {err}");
        return Found::Nothing;
    }
    let mut unsupported = None;
    for info in api.device_list().filter(|d| d.vendor_id() == ELGATO_VENDOR_ID) {
        let Some(model) = protocol::supported_model(info.product_id()) else {
            unsupported = Some(info.product_id());
            continue;
        };
        match info.open_device(api) {
            Ok(device) => {
                let serial = info.serial_number().unwrap_or_default().trim().to_string();
                return Found::Supported(prepare(device, model, serial));
            }
            Err(err) => log::warn!("stream deck: cannot open {}: {err}", model.name),
        }
    }
    unsupported.map_or(Found::Nothing, Found::Unsupported)
}

fn prepare(device: HidDevice, model: Model, serial: String) -> Open {
    let _ = device.send_feature_report(&protocol::reset_report());
    let _ = device.send_feature_report(&protocol::brightness_report(DEFAULT_BRIGHTNESS));
    let info = DeckInfo {
        serial: if serial.is_empty() { format!("{:04x}", model.product_id) } else { serial },
        model: model.name,
        keys: model.keys,
        columns: model.columns,
        image_size: model.image_size,
        image_rotated: model.image_rotated,
    };
    Open { device, keys: vec![false; model.keys], info }
}

fn set_current(current: &Mutex<Option<DeckInfo>>, info: Option<DeckInfo>) {
    if let Ok(mut c) = current.lock() {
        *c = info;
    }
}
