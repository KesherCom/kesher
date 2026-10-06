//! Real-time scheduling on Linux (Raspberry Pi nodes).
//!
//! The Linux counterpart of MMCSS "Pro Audio" on Windows: the capture and
//! playback callbacks (ALSA threads created by cpal) and the UDP receive
//! thread switch themselves to SCHED_FIFO the first time they run. Without
//! it a busy system (logging, SSH, a desktop) can delay a 5 ms period long
//! enough to cause an audible dropout.
//!
//! Needs CAP_SYS_NICE or an RLIMIT_RTPRIO >= AUDIO_RT_PRIORITY; the systemd
//! unit in deploy/node grants that. Without it the engine keeps running at
//! normal priority and logs one warning.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};

/// Below the kernel's IRQ threads (50) on PREEMPT_RT so the network and USB
/// interrupts that feed the audio path still win; above everything else.
const AUDIO_RT_PRIORITY: libc::c_int = 40;

/// Overridable for experiments: KESHER_RT_PRIORITY=0 disables, 1..=98 sets.
fn rt_priority() -> libc::c_int {
    std::env::var("KESHER_RT_PRIORITY")
        .ok()
        .and_then(|v| v.trim().parse::<libc::c_int>().ok())
        .map(|p| p.clamp(0, 98))
        .unwrap_or(AUDIO_RT_PRIORITY)
}

thread_local! {
    static PROMOTED: Cell<bool> = const { Cell::new(false) };
}

static WARNED: AtomicBool = AtomicBool::new(false);

/// Switches the calling thread to SCHED_FIFO once. Cheap after the first
/// call (a thread-local flag), so audio callbacks call it every period.
pub fn promote_audio_thread_once() {
    if PROMOTED.with(|p| p.replace(true)) {
        return;
    }
    let priority = rt_priority();
    if priority == 0 {
        return;
    }
    let param = libc::sched_param { sched_priority: priority };
    // SAFETY: plain syscall on the current thread with a valid parameter.
    let rc = unsafe { libc::pthread_setschedparam(libc::pthread_self(), libc::SCHED_FIFO, &param) };
    if rc != 0 {
        if !WARNED.swap(true, Ordering::Relaxed) {
            log::warn!(
                "[native] could not enable real-time scheduling (error {rc}); \
                 audio runs at normal priority. Run as the kesher-node service \
                 or grant LimitRTPRIO / CAP_SYS_NICE."
            );
        }
    } else {
        log::info!(
            "[native] thread {:?} runs SCHED_FIFO priority {priority}",
            std::thread::current().name().unwrap_or("?")
        );
    }
}
