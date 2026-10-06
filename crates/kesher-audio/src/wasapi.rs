//! Direct WASAPI streams for the performance engine (Windows only).
//!
//! cpal 0.15 opens WASAPI in shared mode with the engine's default period
//! (typically 10 ms per direction), which alone would use most of the 20 ms
//! mouth-to-ear budget. This module offers the two low-latency paths:
//!
//!   - Exclusive: bypasses the Windows mixer, runs at the device's minimum
//!     period (often 2-3 ms). The device is unavailable to other apps while
//!     the engine runs. Works for USB headsets/interfaces and Dante Virtual
//!     Soundcard in WDM mode.
//!   - SharedLowLatency: IAudioClient3 at the smallest engine period the
//!     driver allows. Other apps keep working; how small the period gets
//!     depends on the driver (it may stay at 10 ms).
//!
//! Each stream runs on its own thread with MMCSS "Pro Audio" priority,
//! event-driven, and converts between the device format and the engine's
//! interleaved f32 buffers without allocating.

use std::sync::mpsc::{sync_channel, SyncSender};
use std::time::Duration;

use windows::core::{w, Interface};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IAudioCaptureClient, IAudioClient, IAudioClient3,
    IAudioRenderClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_SHAREMODE_EXCLUSIVE,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW,
    WaitForSingleObject,
};

const SAMPLE_RATE: u32 = 48_000;
const WAVE_FORMAT_PCM_TAG: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
const EVENT_TIMEOUT_MS: u32 = 100;
const INIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WasapiMode {
    Exclusive,
    SharedLowLatency,
}

impl WasapiMode {
    pub fn label(self) -> &'static str {
        match self {
            WasapiMode::Exclusive => "wasapi-exclusive",
            WasapiMode::SharedLowLatency => "wasapi-shared-low-latency",
        }
    }
}

/// What was actually opened, for logs and the UI.
#[derive(Clone, Debug)]
pub struct StreamInfo {
    pub mode: WasapiMode,
    pub device: String,
    pub period_frames: u32,
    pub channels: usize,
    pub format: &'static str,
}

pub type CaptureCallback = Box<dyn FnMut(&[f32]) + Send>;
pub type RenderCallback = Box<dyn FnMut(&mut [f32]) + Send>;

// ── Sample formats ───────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SampleKind {
    F32,
    I16,
    I24Packed,
    /// 32-bit container; 24 or 32 valid bits, both scale as full-range i32.
    I32,
}

#[derive(Clone, Copy, Debug)]
struct Format {
    kind: SampleKind,
    channels: u16,
    valid_bits: u16,
}

impl Format {
    fn container_bits(self) -> u16 {
        match self.kind {
            SampleKind::F32 | SampleKind::I32 => 32,
            SampleKind::I24Packed => 24,
            SampleKind::I16 => 16,
        }
    }

    fn block_align(self) -> usize {
        self.channels as usize * self.container_bits() as usize / 8
    }

    fn label(self) -> &'static str {
        match (self.kind, self.valid_bits) {
            (SampleKind::F32, _) => "f32",
            (SampleKind::I16, _) => "s16",
            (SampleKind::I24Packed, _) => "s24",
            (SampleKind::I32, 24) => "s24in32",
            (SampleKind::I32, _) => "s32",
        }
    }

    fn to_wave_format(self) -> WAVEFORMATEXTENSIBLE {
        let block_align = self.block_align() as u16;
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
                nChannels: self.channels,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
                nBlockAlign: block_align,
                wBitsPerSample: self.container_bits(),
                cbSize: (std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()) as u16,
            },
            Samples: WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: self.valid_bits,
            },
            dwChannelMask: channel_mask(self.channels),
            SubFormat: if self.kind == SampleKind::F32 {
                KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            } else {
                KSDATAFORMAT_SUBTYPE_PCM
            },
        }
    }

    /// Interprets an engine mix format (shared mode). Returns None for
    /// formats we cannot convert.
    unsafe fn from_wave_format(wfx: *const WAVEFORMATEX) -> Option<(Format, u32)> {
        let base = unsafe { *wfx };
        let tag = base.wFormatTag;
        let bits = base.wBitsPerSample;
        let (is_float, valid_bits) = if tag as u32 == WAVE_FORMAT_EXTENSIBLE {
            let ext = unsafe { *(wfx as *const WAVEFORMATEXTENSIBLE) };
            let sub = ext.SubFormat;
            let valid = unsafe { ext.Samples.wValidBitsPerSample };
            if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                (true, valid)
            } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
                (false, valid)
            } else {
                return None;
            }
        } else if tag == WAVE_FORMAT_IEEE_FLOAT_TAG {
            (true, bits)
        } else if tag == WAVE_FORMAT_PCM_TAG {
            (false, bits)
        } else {
            return None;
        };
        let kind = match (is_float, bits) {
            (true, 32) => SampleKind::F32,
            (false, 16) => SampleKind::I16,
            (false, 24) => SampleKind::I24Packed,
            (false, 32) => SampleKind::I32,
            _ => return None,
        };
        let format = Format {
            kind,
            channels: base.nChannels,
            valid_bits: if valid_bits == 0 { bits } else { valid_bits },
        };
        Some((format, base.nSamplesPerSec))
    }
}

fn channel_mask(channels: u16) -> u32 {
    match channels {
        1 => 0x4,           // SPEAKER_FRONT_CENTER
        2 => 0x1 | 0x2,     // FRONT_LEFT | FRONT_RIGHT
        n => (1u32 << n.min(18)) - 1,
    }
}

/// Device bytes -> f32. `src` must hold `out.len()` samples.
unsafe fn read_samples(kind: SampleKind, src: *const u8, out: &mut [f32]) {
    let n = out.len();
    unsafe {
        match kind {
            SampleKind::F32 => {
                out.copy_from_slice(std::slice::from_raw_parts(src as *const f32, n));
            }
            SampleKind::I16 => {
                let s = std::slice::from_raw_parts(src as *const i16, n);
                for (o, &v) in out.iter_mut().zip(s) {
                    *o = v as f32 / 32_768.0;
                }
            }
            SampleKind::I32 => {
                let s = std::slice::from_raw_parts(src as *const i32, n);
                for (o, &v) in out.iter_mut().zip(s) {
                    *o = v as f32 / 2_147_483_648.0;
                }
            }
            SampleKind::I24Packed => {
                let s = std::slice::from_raw_parts(src, n * 3);
                for (o, b) in out.iter_mut().zip(s.chunks_exact(3)) {
                    let v = ((b[0] as i32) << 8 | (b[1] as i32) << 16 | (b[2] as i32) << 24) >> 8;
                    *o = v as f32 / 8_388_608.0;
                }
            }
        }
    }
}

/// f32 -> device bytes. `dst` must have room for `src.len()` samples.
unsafe fn write_samples(kind: SampleKind, src: &[f32], dst: *mut u8) {
    let n = src.len();
    unsafe {
        match kind {
            SampleKind::F32 => {
                std::slice::from_raw_parts_mut(dst as *mut f32, n).copy_from_slice(src);
            }
            SampleKind::I16 => {
                let d = std::slice::from_raw_parts_mut(dst as *mut i16, n);
                for (o, &v) in d.iter_mut().zip(src) {
                    *o = (v.clamp(-1.0, 1.0) * 32_767.0) as i16;
                }
            }
            SampleKind::I32 => {
                let d = std::slice::from_raw_parts_mut(dst as *mut i32, n);
                for (o, &v) in d.iter_mut().zip(src) {
                    *o = (v.clamp(-1.0, 1.0) as f64 * 2_147_483_647.0) as i32;
                }
            }
            SampleKind::I24Packed => {
                let d = std::slice::from_raw_parts_mut(dst, n * 3);
                for (o, &v) in d.chunks_exact_mut(3).zip(src) {
                    let s = (v.clamp(-1.0, 1.0) * 8_388_607.0) as i32;
                    o[0] = s as u8;
                    o[1] = (s >> 8) as u8;
                    o[2] = (s >> 16) as u8;
                }
            }
        }
    }
}

// ── Devices ──────────────────────────────────────────────────────────────

unsafe fn friendly_name(device: &IMMDevice) -> Option<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let mut value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let name = PropVariantToStringAlloc(&value).ok().map(|pw| {
            let s = pw.to_string().unwrap_or_default();
            CoTaskMemFree(Some(pw.0 as _));
            s
        });
        let _ = PropVariantClear(&mut value);
        name
    }
}

/// Finds an endpoint by its friendly name (the same name cpal reports),
/// falling back to the system default.
unsafe fn find_device(flow: EDataFlow, name: Option<&str>) -> Result<(IMMDevice, String), String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("device enumerator: {e}"))?;
        if let Some(wanted) = name.filter(|n| !n.is_empty()) {
            if let Ok(collection) = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) {
                let count = collection.GetCount().unwrap_or(0);
                for i in 0..count {
                    if let Ok(device) = collection.Item(i) {
                        if friendly_name(&device).as_deref() == Some(wanted) {
                            return Ok((device, wanted.to_string()));
                        }
                    }
                }
            }
            log::warn!("[wasapi] device {wanted:?} not found, using system default");
        }
        let device = enumerator
            .GetDefaultAudioEndpoint(flow, eConsole)
            .map_err(|e| format!("default device: {e}"))?;
        let name = friendly_name(&device).unwrap_or_else(|| "default".to_string());
        Ok((device, name))
    }
}

// ── Stream setup ─────────────────────────────────────────────────────────

struct OpenStream {
    client: IAudioClient,
    event: HANDLE,
    format: Format,
    buffer_frames: u32,
    period_frames: u32,
    exclusive: bool,
}

impl Drop for OpenStream {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

fn period_override_hns() -> Option<i64> {
    std::env::var("KESHER_WASAPI_PERIOD_US")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|us| (500..=50_000).contains(us))
        .map(|us| us * 10)
}

unsafe fn init_exclusive(device: &IMMDevice) -> Result<OpenStream, String> {
    unsafe {
        let probe: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| format!("activate: {e}"))?;
        let mix_channels = probe
            .GetMixFormat()
            .map(|mix| {
                let ch = (*mix).nChannels;
                CoTaskMemFree(Some(mix as _));
                ch
            })
            .unwrap_or(2);

        // First format the device accepts exclusively at 48 kHz.
        let mut channel_options = vec![mix_channels, 2, 1];
        channel_options.dedup();
        let kinds = [
            (SampleKind::F32, 32),
            (SampleKind::I32, 32),
            (SampleKind::I32, 24),
            (SampleKind::I24Packed, 24),
            (SampleKind::I16, 16),
        ];
        let format = channel_options
            .iter()
            .flat_map(|&channels| kinds.iter().map(move |&(kind, valid_bits)| Format { kind, channels, valid_bits }))
            .find(|f| {
                let wfx = f.to_wave_format();
                probe
                    .IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &wfx as *const _ as *const WAVEFORMATEX, None)
                    .is_ok()
            })
            .ok_or_else(|| "no 48 kHz exclusive format supported".to_string())?;
        drop(probe);

        let wfx = format.to_wave_format();
        let wfx_ptr = &wfx as *const _ as *const WAVEFORMATEX;
        let mut client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| format!("activate: {e}"))?;
        let mut min_period = 0i64;
        client
            .GetDevicePeriod(None, Some(&mut min_period))
            .map_err(|e| format!("device period: {e}"))?;
        let mut period = period_override_hns().map_or(min_period, |p| p.max(min_period));
        let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        if let Err(e) = client.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, period, period, wfx_ptr, None) {
            if e.code() != AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                return Err(format!("exclusive initialize: {e}"));
            }
            // Documented retry: use the aligned buffer size the driver picked.
            let frames = client.GetBufferSize().map_err(|e| format!("buffer size: {e}"))?;
            period = (10_000_000.0 * frames as f64 / SAMPLE_RATE as f64 + 0.5) as i64;
            client = device.Activate(CLSCTX_ALL, None).map_err(|e| format!("activate: {e}"))?;
            client
                .Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, period, period, wfx_ptr, None)
                .map_err(|e| format!("exclusive initialize (aligned): {e}"))?;
        }
        let event = CreateEventW(None, false, false, None).map_err(|e| format!("event: {e}"))?;
        let mut stream = OpenStream {
            client,
            event,
            format,
            buffer_frames: 0,
            period_frames: 0,
            exclusive: true,
        };
        stream.client.SetEventHandle(event).map_err(|e| format!("set event: {e}"))?;
        stream.buffer_frames = stream.client.GetBufferSize().map_err(|e| format!("buffer size: {e}"))?;
        stream.period_frames = stream.buffer_frames;
        Ok(stream)
    }
}

unsafe fn init_shared_low_latency(device: &IMMDevice) -> Result<OpenStream, String> {
    unsafe {
        let client3: IAudioClient3 = device.Activate(CLSCTX_ALL, None).map_err(|e| format!("IAudioClient3: {e}"))?;
        let mix = client3.GetMixFormat().map_err(|e| format!("mix format: {e}"))?;
        let parsed = Format::from_wave_format(mix);
        let result = (|| {
            let (format, rate) = parsed.ok_or_else(|| "unsupported engine mix format".to_string())?;
            if rate != SAMPLE_RATE {
                return Err(format!("engine runs at {rate} Hz, need 48000 (set the device to 48 kHz)"));
            }
            let (mut default, mut fundamental, mut min, mut max) = (0u32, 0u32, 0u32, 0u32);
            client3
                .GetSharedModeEnginePeriod(mix, &mut default, &mut fundamental, &mut min, &mut max)
                .map_err(|e| format!("engine period: {e}"))?;
            client3
                .InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, min, mix, None)
                .map_err(|e| format!("shared low-latency initialize: {e}"))?;
            if min == default {
                log::info!("[wasapi] driver offers no period below {default} frames in shared mode");
            }
            Ok((format, min))
        })();
        CoTaskMemFree(Some(mix as _));
        let (format, period_frames) = result?;
        let client: IAudioClient = client3.cast().map_err(|e| format!("cast: {e}"))?;
        let event = CreateEventW(None, false, false, None).map_err(|e| format!("event: {e}"))?;
        let mut stream = OpenStream {
            client,
            event,
            format,
            buffer_frames: 0,
            period_frames,
            exclusive: false,
        };
        stream.client.SetEventHandle(event).map_err(|e| format!("set event: {e}"))?;
        stream.buffer_frames = stream.client.GetBufferSize().map_err(|e| format!("buffer size: {e}"))?;
        Ok(stream)
    }
}

unsafe fn open_stream(flow: EDataFlow, device_name: Option<&str>, mode: WasapiMode) -> Result<(OpenStream, String), String> {
    unsafe {
        let (device, name) = find_device(flow, device_name)?;
        let stream = match mode {
            WasapiMode::Exclusive => init_exclusive(&device)?,
            WasapiMode::SharedLowLatency => init_shared_low_latency(&device)?,
        };
        Ok((stream, name))
    }
}

/// Raises the calling thread to MMCSS "Pro Audio" for its lifetime.
pub struct ProAudioPriority(Option<HANDLE>);

impl ProAudioPriority {
    pub fn enter() -> Self {
        let mut task_index = 0u32;
        let handle = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) };
        if let Err(e) = &handle {
            log::warn!("[wasapi] MMCSS Pro Audio unavailable: {e}");
        }
        Self(handle.ok())
    }
}

impl Drop for ProAudioPriority {
    fn drop(&mut self) {
        if let Some(handle) = self.0 {
            unsafe {
                let _ = AvRevertMmThreadCharacteristics(handle);
            }
        }
    }
}

/// Keeps Windows from throttling the engine when the app is not in the
/// foreground. Windows 11 power throttling (EcoQoS) moves such processes to
/// efficiency cores and coalesces their timers; on the lab machine that
/// stalled the relay process for 40-100 ms at a time, and the engine's
/// network thread is exposed the same way. Also asks for 1 ms timers.
/// Idempotent; failures are logged and ignored.
pub fn tune_process_for_realtime() {
    use windows::Win32::Media::timeBeginPeriod;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
        ABOVE_NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
        PROCESS_POWER_THROTTLING_STATE,
    };
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
            StateMask: 0,
        };
        if let Err(e) = SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &state as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        ) {
            log::warn!("[wasapi] could not disable power throttling: {e}");
        }
        timeBeginPeriod(1);
        if let Err(e) = SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) {
            log::warn!("[wasapi] could not raise priority class: {e}");
        }
    });
}

/// Runs `body` on a COM (MTA) thread and waits until it reports that the
/// stream started or failed.
fn spawn_stream<B>(name: &str, body: B) -> Result<StreamInfo, String>
where
    B: FnOnce(SyncSender<Result<StreamInfo, String>>) + Send + 'static,
{
    let (ready_tx, ready_rx) = sync_channel(1);
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if com.is_err() {
                let _ = ready_tx.send(Err(format!("COM init: {com:?}")));
                return;
            }
            body(ready_tx);
            unsafe { CoUninitialize() };
        })
        .map_err(|e| format!("spawn {name}: {e}"))?;
    ready_rx
        .recv_timeout(INIT_TIMEOUT)
        .map_err(|_| format!("{name}: device did not start in time"))?
}

// ── Public entry points ──────────────────────────────────────────────────

/// Opens a capture stream and calls the callback built by `make` with
/// interleaved f32 samples until `stop` returns true.
pub fn start_capture<M, S>(device_name: Option<String>, mode: WasapiMode, stop: S, make: M) -> Result<StreamInfo, String>
where
    M: FnOnce(usize) -> Result<CaptureCallback, String> + Send + 'static,
    S: Fn() -> bool + Send + 'static,
{
    spawn_stream("kesher-wasapi-capture", move |ready| unsafe {
        let (stream, device) = match open_stream(eCapture, device_name.as_deref(), mode) {
            Ok(s) => s,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let capture: IAudioCaptureClient = match stream.client.GetService() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready.send(Err(format!("capture client: {e}")));
                return;
            }
        };
        let channels = stream.format.channels as usize;
        let mut callback = match make(channels) {
            Ok(cb) => cb,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        if let Err(e) = stream.client.Start() {
            let _ = ready.send(Err(format!("start: {e}")));
            return;
        }
        let info = StreamInfo {
            mode,
            device,
            period_frames: stream.period_frames,
            channels,
            format: stream.format.label(),
        };
        let _ = ready.send(Ok(info));

        let _priority = ProAudioPriority::enter();
        let mut scratch = vec![0.0f32; stream.buffer_frames.max(stream.period_frames) as usize * channels * 2];
        let mut discontinuities = 0u64;
        'outer: while !stop() {
            if WaitForSingleObject(stream.event, EVENT_TIMEOUT_MS) != WAIT_OBJECT_0 {
                continue;
            }
            loop {
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if let Err(e) = capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) {
                    log::error!("[wasapi] capture stopped: {e}");
                    break 'outer;
                }
                if frames == 0 {
                    break;
                }
                let samples = frames as usize * channels;
                if samples > scratch.len() {
                    scratch.resize(samples, 0.0);
                }
                let out = &mut scratch[..samples];
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    out.fill(0.0);
                } else {
                    read_samples(stream.format.kind, data, out);
                }
                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    discontinuities += 1;
                }
                let _ = capture.ReleaseBuffer(frames);
                callback(out);
            }
        }
        if discontinuities > 0 {
            log::warn!("[wasapi] capture had {discontinuities} discontinuities (overruns)");
        }
        drop(capture);
        drop(stream);
    })
}

/// Opens a render stream and fills it from the callback built by `make`
/// (interleaved f32) until `stop` returns true.
pub fn start_render<M, S>(device_name: Option<String>, mode: WasapiMode, stop: S, make: M) -> Result<StreamInfo, String>
where
    M: FnOnce(usize) -> Result<RenderCallback, String> + Send + 'static,
    S: Fn() -> bool + Send + 'static,
{
    spawn_stream("kesher-wasapi-render", move |ready| unsafe {
        let (stream, device) = match open_stream(eRender, device_name.as_deref(), mode) {
            Ok(s) => s,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let render: IAudioRenderClient = match stream.client.GetService() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready.send(Err(format!("render client: {e}")));
                return;
            }
        };
        // Pre-roll silence so the first period does not glitch.
        if let Ok(ptr) = render.GetBuffer(stream.buffer_frames) {
            let _ = ptr;
            let _ = render.ReleaseBuffer(stream.buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32);
        }
        let channels = stream.format.channels as usize;
        let mut callback = match make(channels) {
            Ok(cb) => cb,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        if let Err(e) = stream.client.Start() {
            let _ = ready.send(Err(format!("start: {e}")));
            return;
        }
        let info = StreamInfo {
            mode,
            device,
            period_frames: stream.period_frames,
            channels,
            format: stream.format.label(),
        };
        let _ = ready.send(Ok(info));

        let _priority = ProAudioPriority::enter();
        let mut scratch = vec![0.0f32; stream.buffer_frames as usize * channels];
        while !stop() {
            if WaitForSingleObject(stream.event, EVENT_TIMEOUT_MS) != WAIT_OBJECT_0 {
                continue;
            }
            // Exclusive event mode: the whole buffer is due each period.
            // Shared: fill whatever the engine has consumed.
            let frames = if stream.exclusive {
                stream.buffer_frames
            } else {
                match stream.client.GetCurrentPadding() {
                    Ok(padding) => stream.buffer_frames.saturating_sub(padding),
                    Err(e) => {
                        log::error!("[wasapi] render stopped: {e}");
                        break;
                    }
                }
            };
            if frames == 0 {
                continue;
            }
            let data = match render.GetBuffer(frames) {
                Ok(p) => p,
                Err(e) => {
                    log::error!("[wasapi] render stopped: {e}");
                    break;
                }
            };
            let out = &mut scratch[..frames as usize * channels];
            callback(out);
            write_samples(stream.format.kind, out, data);
            let _ = render.ReleaseBuffer(frames, 0);
        }
        drop(render);
        drop(stream);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_conversion_round_trips() {
        let src = [0.0f32, 0.5, -0.5, 0.999, -1.0];
        for kind in [SampleKind::F32, SampleKind::I16, SampleKind::I24Packed, SampleKind::I32] {
            let mut bytes = vec![0u8; src.len() * 4];
            let mut back = [0.0f32; 5];
            unsafe {
                write_samples(kind, &src, bytes.as_mut_ptr());
                read_samples(kind, bytes.as_ptr(), &mut back);
            }
            for (a, b) in src.iter().zip(back) {
                assert!((a - b).abs() < 1e-3, "{kind:?}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn extensible_format_is_consistent() {
        let f = Format {
            kind: SampleKind::I32,
            channels: 2,
            valid_bits: 24,
        };
        let wfx = f.to_wave_format();
        let base = wfx.Format;
        assert_eq!({ base.nBlockAlign }, 8);
        assert_eq!({ base.wBitsPerSample }, 32);
        assert_eq!({ base.cbSize }, 22);
        let parsed = unsafe { Format::from_wave_format(&wfx as *const _ as *const WAVEFORMATEX) };
        let (p, rate) = parsed.unwrap();
        assert_eq!(rate, SAMPLE_RATE);
        assert_eq!(p.kind, SampleKind::I32);
        assert_eq!(p.valid_bits, 24);
    }

    /// Opens the real default devices in both modes for a moment (renders
    /// silence). Run manually: `cargo test -- --ignored wasapi_hardware`.
    #[test]
    #[ignore]
    fn wasapi_hardware_probe() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;
        for mode in [WasapiMode::Exclusive, WasapiMode::SharedLowLatency] {
            let stop = Arc::new(AtomicBool::new(false));
            let frames_in = Arc::new(AtomicU64::new(0));
            let frames_out = Arc::new(AtomicU64::new(0));
            let (s1, s2) = (Arc::clone(&stop), Arc::clone(&stop));
            let (fi, fo) = (Arc::clone(&frames_in), Arc::clone(&frames_out));
            let cap = start_capture(None, mode, move || s1.load(Ordering::Relaxed), move |ch| {
                Ok(Box::new(move |d: &[f32]| {
                    fi.fetch_add((d.len() / ch) as u64, Ordering::Relaxed);
                }) as CaptureCallback)
            });
            let ren = start_render(None, mode, move || s2.load(Ordering::Relaxed), move |ch| {
                Ok(Box::new(move |d: &mut [f32]| {
                    d.fill(0.0);
                    fo.fetch_add((d.len() / ch) as u64, Ordering::Relaxed);
                }) as RenderCallback)
            });
            std::thread::sleep(Duration::from_millis(500));
            stop.store(true, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(200));
            println!(
                "{mode:?}: capture={:?} ({} frames in 0.5 s) render={:?} ({} frames)",
                cap.as_ref().map(|i| (i.device.clone(), i.period_frames, i.channels, i.format)),
                frames_in.load(Ordering::Relaxed),
                ren.as_ref().map(|i| (i.device.clone(), i.period_frames, i.channels, i.format)),
                frames_out.load(Ordering::Relaxed),
            );
        }
    }
}
