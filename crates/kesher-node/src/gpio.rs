//! Talk button and LED on the Raspberry Pi header.
//!
//! Uses the GPIO character device (/dev/gpiochipN) and looks lines up by
//! name ("GPIO17"), so the same binary works on Pi 3, 4 and 5 even though
//! the Pi 5 has its header on a different chip (RP1). Off-Pi (or without
//! configured pins) everything here is a no-op.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LedState {
    Off = 0,
    On = 1,
    /// Not connected to the server: slow blink.
    Offline = 2,
    /// Waiting for approval in the admin area: double blink.
    Pending = 3,
}

/// Cheap handle; the blink thread reads the state.
#[derive(Clone, Default)]
pub struct Led {
    state: Option<Arc<AtomicU8>>,
}

impl Led {
    pub fn set(&self, state: LedState) {
        if let Some(s) = &self.state {
            s.store(state as u8, Ordering::Relaxed);
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use gpiocdev::line::{Bias, EdgeKind, Value};
    use gpiocdev::Request;
    use std::time::Duration;
    use tokio::sync::mpsc::UnboundedSender;

    const DEBOUNCE: Duration = Duration::from_millis(10);

    fn find(pin: u32) -> Result<gpiocdev::FoundLine, String> {
        let name = format!("GPIO{pin}");
        gpiocdev::find_named_line(&name).ok_or_else(|| format!("{name} not found (is this a Raspberry Pi?)"))
    }

    /// Talk button between `pin` and GND. Sends true on press, false on
    /// release.
    pub fn spawn_button(pin: u32, tx: UnboundedSender<bool>) -> Result<(), String> {
        let line = find(pin)?;
        let req = Request::builder()
            .with_found_line(&line)
            .with_consumer("kesher-node talk")
            .as_input()
            .with_bias(Bias::PullUp)
            .with_edge_detection(gpiocdev::line::EdgeDetection::BothEdges)
            .with_debounce_period(DEBOUNCE)
            .request()
            .map_err(|e| format!("GPIO{pin}: {e}"))?;
        // Pressed = pulled to GND.
        let pressed = matches!(req.value(line.info.offset), Ok(Value::Inactive));
        if pressed {
            let _ = tx.send(true);
        }
        std::thread::Builder::new()
            .name("kesher-gpio-button".into())
            .spawn(move || {
                for event in req.edge_events() {
                    match event {
                        Ok(e) => {
                            if tx.send(e.kind == EdgeKind::Falling).is_err() {
                                return;
                            }
                        }
                        Err(e) => {
                            log::error!("GPIO{pin}: {e}");
                            return;
                        }
                    }
                }
            })
            .map_err(|e| format!("spawn gpio thread: {e}"))?;
        log::info!("talk button on GPIO{pin}");
        Ok(())
    }

    pub fn spawn_led(pin: u32) -> Result<Led, String> {
        let line = find(pin)?;
        let offset = line.info.offset;
        let req = Request::builder()
            .with_found_line(&line)
            .with_consumer("kesher-node led")
            .as_output(Value::Inactive)
            .request()
            .map_err(|e| format!("GPIO{pin}: {e}"))?;
        let state = Arc::new(AtomicU8::new(LedState::Offline as u8));
        let thread_state = Arc::clone(&state);
        std::thread::Builder::new()
            .name("kesher-gpio-led".into())
            .spawn(move || {
                let mut tick = 0u32;
                loop {
                    let on = match thread_state.load(Ordering::Relaxed) {
                        x if x == LedState::On as u8 => true,
                        x if x == LedState::Offline as u8 => tick % 10 < 2,
                        x if x == LedState::Pending as u8 => matches!(tick % 10, 0 | 2),
                        _ => false,
                    };
                    let _ = req.set_value(offset, if on { Value::Active } else { Value::Inactive });
                    tick = tick.wrapping_add(1);
                    std::thread::sleep(Duration::from_millis(100));
                }
            })
            .map_err(|e| format!("spawn led thread: {e}"))?;
        log::info!("talk LED on GPIO{pin}");
        Ok(Led { state: Some(state) })
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::*;
    use tokio::sync::mpsc::UnboundedSender;

    pub fn spawn_button(pin: u32, _tx: UnboundedSender<bool>) -> Result<(), String> {
        Err(format!("GPIO{pin}: GPIO is only available on Linux"))
    }

    pub fn spawn_led(pin: u32) -> Result<Led, String> {
        Err(format!("GPIO{pin}: GPIO is only available on Linux"))
    }
}

pub use imp::{spawn_button, spawn_led};
