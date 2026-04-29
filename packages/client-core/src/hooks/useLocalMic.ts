/**
 * Manages local microphone capture, input-gain processing, input level
 * metering, and track hot-swapping when the selected device changes.
 *
 * Exposed refs (`localStreamRef`, `inputGainNodeRef`, `inputCaptureStreamRef`,
 * `micReinitGenerationRef`) are mutable and shared with the WebRTC layer so the
 * caller can access the current stream / gain node without triggering re-renders.
 */
import { useEffect, useRef, useState } from "react";
import {
  clampAudioGateThresholdDb,
  clampInputGainValue,
  micInputBaseBoost,
} from "../app/settings";
import { meterDbFsFloor, peakAmplitudeToDbFs } from "../lib/presence";

const webAudioGateBufferSize = 256;
const gateAttackTimeMs = 10;
const gateReleaseTimeMs = 150;

function dbFsToAmplitude(dbFs: number): number {
  return Math.pow(10, clampAudioGateThresholdDb(dbFs) / 20);
}

/**
 * Computes gate envelope attack/release coefficients for smooth gate opening/closing.
 * Prevents clicks and pops, and allows faster gate opening for word beginnings.
 */
function computeGateCoefficients(sampleRate: number): {
  attackCoeff: number;
  releaseCoeff: number;
} {
  const attackTimeSeconds = gateAttackTimeMs / 1000;
  const releaseTimeSeconds = gateReleaseTimeMs / 1000;
  // One-pole lowpass: coeff = 1.0 - exp(-2π * fc * dt)
  // where fc is cutoff in Hz, dt is time step
  const attackCoeff = 1.0 - Math.exp(-2 * Math.PI * (1 / attackTimeSeconds) / sampleRate);
  const releaseCoeff = 1.0 - Math.exp(-2 * Math.PI * (1 / releaseTimeSeconds) / sampleRate);
  return { attackCoeff, releaseCoeff };
}

export { computeGateCoefficients };

type GetUserMediaFn = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

type LowLatencyAudioConstraintKey =
  | "echoCancellation"
  | "noiseSuppression"
  | "autoGainControl"
  | "channelCount"
  | "latency";

type LowLatencyAudioConstraints = MediaTrackConstraints & {
  latency?: number;
};

const lowLatencyAudioConstraintVariants: ReadonlyArray<
  ReadonlyArray<LowLatencyAudioConstraintKey>
> = [
  [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "channelCount",
    "latency",
  ],
  [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "channelCount",
  ],
  [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
  ],
  ["channelCount", "latency"],
  ["channelCount"],
];

function buildLowLatencyAudioConstraints(
  keys: ReadonlyArray<LowLatencyAudioConstraintKey>,
): LowLatencyAudioConstraints {
  const constraints: LowLatencyAudioConstraints = {};
  for (const key of keys) {
    switch (key) {
      case "echoCancellation":
        constraints.echoCancellation = false;
        break;
      case "noiseSuppression":
        constraints.noiseSuppression = false;
        break;
      case "autoGainControl":
        constraints.autoGainControl = false;
        break;
      case "channelCount":
        constraints.channelCount = 1;
        break;
      case "latency":
        constraints.latency = 0;
        break;
    }
  }
  return constraints;
}

export function buildLowLatencyMicConstraintCandidates(
  deviceId: string,
): MediaStreamConstraints[] {
  const candidates: MediaStreamConstraints[] = [];
  for (const keys of lowLatencyAudioConstraintVariants) {
    const audio = buildLowLatencyAudioConstraints(keys);
    if (deviceId) {
      candidates.push({
        audio: { ...audio, deviceId: { exact: deviceId } },
        video: false,
      });
      candidates.push({
        audio: { ...audio, deviceId },
        video: false,
      });
    }
    candidates.push({ audio, video: false });
  }
  candidates.push({ audio: true, video: false });
  return candidates;
}

export async function requestLowLatencyMicStream(
  deviceId: string,
  getUserMedia: GetUserMediaFn = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<MediaStream> {
  const candidates = buildLowLatencyMicConstraintCandidates(deviceId);
  let lastError: unknown = null;
  for (const constraints of candidates) {
    try {
      return await getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Failed to access microphone with low-latency constraints");
}

export type UseLocalMicOptions = {
  /** Currently selected input device id (triggers reinit when it changes). */
  selectedInputDeviceId: string;
  /** Stable ref version so callbacks always read the latest value. */
  selectedInputDeviceIdRef: React.MutableRefObject<string>;
  /**
   * Returns the desired gain for the given device id. Must be stable or
   * produced via `useCallback` to avoid spurious effect re-runs.
   */
  selectedInputGainFor: (deviceId: string) => number;
  /** Raw gain map – used only as effect dependency to detect gain changes. */
  inputGainByDeviceId: Record<string, number>;
  /** User-configurable microphone gate toggle. */
  audioGateEnabled: boolean;
  /** User-configurable microphone gate threshold in dBFS. */
  audioGateThresholdDb: number;
  /** Whether the settings panel is open (controls level meter). */
  isUserSettingsOpen: boolean;
  /** Stable ref so the async WS-open path can check the current value. */
  isUserSettingsOpenRef: React.MutableRefObject<boolean>;
  /** Stable ref to the current voice mode (needed when applying mode to tracks). */
  voiceModeRef: React.MutableRefObject<"always_on" | "ptt">;
  /** The active RTCPeerConnection – used to replace the audio sender on device switch. */
  pcRef: React.MutableRefObject<RTCPeerConnection | null>;
  /** Called when a recoverable audio error occurs. */
  onAudioError: (msg: string) => void;
  /** Called after a new mic stream is obtained so the device list can refresh. */
  onRefreshAudioDevices: () => Promise<void>;
  /** Optional callback to tune the active outgoing RTCRtpSender after add/replace. */
  onAfterAudioSenderUpdated?: (pc: RTCPeerConnection) => Promise<void> | void;
  /**
   * When true the mic-reinit effect fires on `selectedInputDeviceId` changes.
   * Should be `!!(token && appData)` in the caller.
   */
  enableReinit: boolean;
};

export type UseLocalMicResult = {
  /** The outgoing (gain-processed) local stream added to the peer connection. */
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  /** The Web Audio gain node that controls outgoing mic level. */
  inputGainNodeRef: React.MutableRefObject<GainNode | null>;
  /** The raw capture stream from getUserMedia (used for level metering). */
  inputCaptureStreamRef: React.MutableRefObject<MediaStream | null>;
  /** Incremented on every mic reinit to let async paths detect staleness. */
  micReinitGenerationRef: React.MutableRefObject<number>;
  /** Current input level in dBFS, updated by animation-frame loop. */
  inputLevelDbFs: number;
  /** True while a recent clipping peak has been detected. */
  displayedInputClipping: boolean;
  /** True while the local audio monitor (mic loopback) is active. */
  isLocalMonitorActive: boolean;

  getMicStream: (deviceId: string) => Promise<MediaStream>;
  buildOutgoingMicStream: (
    sourceStream: MediaStream,
    gainValue: number,
  ) => MediaStream;
  stopInputProcessing: () => void;
  startLevelMeter: (stream: MediaStream) => void;
  stopLevelMeter: () => void;
  applyVoiceModeToLocalTracks: (mode: "always_on" | "ptt") => void;
  /** Start playing mic input back to the user via the selected output device. */
  startLocalMonitor: (outputDeviceId: string) => Promise<void>;
  /** Stop local audio monitor loopback. */
  stopLocalMonitor: () => void;
};

export function useLocalMic({
  selectedInputDeviceId,
  selectedInputGainFor,
  inputGainByDeviceId,
  audioGateEnabled,
  audioGateThresholdDb,
  isUserSettingsOpen,
  isUserSettingsOpenRef,
  voiceModeRef,
  pcRef,
  onAudioError,
  onRefreshAudioDevices,
  onAfterAudioSenderUpdated,
  enableReinit,
}: UseLocalMicOptions): UseLocalMicResult {
  const effectiveInputGain = (deviceGain: number): number =>
    clampInputGainValue(deviceGain * micInputBaseBoost);

  // ── State ──
  const [inputLevelDbFs, setInputLevelDbFs] = useState(meterDbFsFloor);
  const [inputSamplePeakClipping, setInputSamplePeakClipping] = useState(false);
  const [displayedInputClipping, setDisplayedInputClipping] = useState(false);
  const [isLocalMonitorActive, setIsLocalMonitorActive] = useState(false);

  // ── Refs ──
  const localStreamRef = useRef<MediaStream | null>(null);
  const inputCaptureStreamRef = useRef<MediaStream | null>(null);
  const inputProcessingAudioCtxRef = useRef<AudioContext | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const gateProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterMonitorStreamRef = useRef<MediaStream | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const inputClippingDisplayTimeoutRef = useRef<number | null>(null);
  const micReinitGenerationRef = useRef(0);
  const localMonitorCtxRef = useRef<AudioContext | null>(null);
  const localMonitorAudioElRef = useRef<HTMLAudioElement | null>(null);
  const audioGateEnabledRef = useRef(audioGateEnabled);
  const audioGateThresholdDbRef = useRef(audioGateThresholdDb);
  const gateEnvelopeRef = useRef(0.0); // Current gate envelope (0.0 = fully muted, 1.0 = fully open)
  const gateCoefficientsRef = useRef({ attackCoeff: 0.1, releaseCoeff: 0.01 });

  useEffect(() => {
    audioGateEnabledRef.current = audioGateEnabled;
  }, [audioGateEnabled]);

  useEffect(() => {
    audioGateThresholdDbRef.current = audioGateThresholdDb;
  }, [audioGateThresholdDb]);

  // ── Mic stream acquisition ──
  async function getMicStream(deviceId: string): Promise<MediaStream> {
    return requestLowLatencyMicStream(deviceId);
  }

  // ── Gain processing ──
  function buildOutgoingMicStream(
    sourceStream: MediaStream,
    gainValue: number,
  ): MediaStream {
    const sourceTrack = sourceStream.getAudioTracks()[0];
    if (!sourceTrack) return sourceStream;
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return sourceStream;
    try {
      const ctx = new AudioCtx({ latencyHint: "interactive" });
      const sampleRate = ctx.sampleRate;
      gateCoefficientsRef.current = computeGateCoefficients(sampleRate);
      gateEnvelopeRef.current = 0.0;
      
      const src = ctx.createMediaStreamSource(sourceStream);
      const gate = ctx.createScriptProcessor(webAudioGateBufferSize, 1, 1);
      const gain = ctx.createGain();
      gain.gain.value = effectiveInputGain(gainValue);
      const dest = ctx.createMediaStreamDestination();
      
      gate.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);
        if (!audioGateEnabledRef.current) {
          output.set(input);
          return;
        }
        
        const threshold = dbFsToAmplitude(audioGateThresholdDbRef.current);
        const { attackCoeff, releaseCoeff } = gateCoefficientsRef.current;
        let gateEnvelope = gateEnvelopeRef.current;
        
        for (let index = 0; index < input.length; index += 1) {
          const sample = input[index] ?? 0;
          const isAboveThreshold = Math.abs(sample) >= threshold;
          
          // Smooth envelope: attack on signal, release when no signal
          const targetEnvelope = isAboveThreshold ? 1.0 : 0.0;
          const coeff = isAboveThreshold ? attackCoeff : releaseCoeff;
          gateEnvelope = targetEnvelope * coeff + gateEnvelope * (1.0 - coeff);
          
          // Apply soft gate (multiply by envelope instead of hard mute)
          output[index] = sample * gateEnvelope;
        }
        
        gateEnvelopeRef.current = gateEnvelope;
      };
      
      src.connect(gate);
      gate.connect(gain);
      gain.connect(dest);
      const processedTrack = dest.stream.getAudioTracks()[0];
      if (!processedTrack) {
        void ctx.close();
        return sourceStream;
      }
      inputProcessingAudioCtxRef.current = ctx;
      inputGainNodeRef.current = gain;
      gateProcessorNodeRef.current = gate;
      return new MediaStream([processedTrack]);
    } catch {
      return sourceStream;
    }
  }

  function stopInputProcessing() {
    if (inputCaptureStreamRef.current) {
      for (const track of inputCaptureStreamRef.current.getTracks())
        track.stop();
      inputCaptureStreamRef.current = null;
    }
    if (inputProcessingAudioCtxRef.current) {
      void inputProcessingAudioCtxRef.current.close();
      inputProcessingAudioCtxRef.current = null;
    }
    gateProcessorNodeRef.current = null;
    inputGainNodeRef.current = null;
  }

  // ── Level metering ──
  function stopLevelMeter() {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    analyserRef.current = null;
    if (meterMonitorStreamRef.current) {
      for (const track of meterMonitorStreamRef.current.getTracks())
        track.stop();
      meterMonitorStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setInputLevelDbFs(meterDbFsFloor);
    setInputSamplePeakClipping(false);
  }

  function startLevelMeter(stream: MediaStream) {
    stopLevelMeter();
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const sourceTrack = stream.getAudioTracks()[0];
    if (!sourceTrack) return;
    const monitorTrack = sourceTrack.clone();
    const monitorStream = new MediaStream([monitorTrack]);
    meterMonitorStreamRef.current = monitorStream;
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(monitorStream);
    const meterGain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(meterGain);
    meterGain.connect(analyser);
    analyserRef.current = analyser;
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      meterGain.gain.value = clampInputGainValue(inputGainNodeRef.current?.gain.value ?? 1);
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) {
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      setInputLevelDbFs(peakAmplitudeToDbFs(peak));
      setInputSamplePeakClipping(peak >= 1);
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
  }

  // ── Local audio monitor (mic loopback) ──
  function stopLocalMonitor() {
    const el = localMonitorAudioElRef.current;
    if (el) {
      el.pause();
      el.srcObject = null;
      localMonitorAudioElRef.current = null;
    }
    if (localMonitorCtxRef.current) {
      void localMonitorCtxRef.current.close();
      localMonitorCtxRef.current = null;
    }
    setIsLocalMonitorActive(false);
  }

  async function startLocalMonitor(outputDeviceId: string): Promise<void> {
    const captureStream = inputCaptureStreamRef.current;
    if (!captureStream) return;
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    stopLocalMonitor();
    try {
      const ctx = new AudioCtx({ latencyHint: "interactive" });
      localMonitorCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(captureStream);
      const gain = ctx.createGain();
      gain.gain.value = clampInputGainValue(
        inputGainNodeRef.current?.gain.value ?? 1,
      );
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      const elWithSink = el as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (outputDeviceId) {
        if (typeof elWithSink.setSinkId !== "function") {
          throw new Error("Output device selection is not supported");
        }
        await elWithSink.setSinkId(outputDeviceId);
      }
      await el.play();
      localMonitorAudioElRef.current = el;
      setIsLocalMonitorActive(true);
    } catch {
      stopLocalMonitor();
    }
  }

  // ── Track enable/disable ──
  function applyVoiceModeToLocalTracks(mode: "always_on" | "ptt") {
    const stream = localStreamRef.current;
    if (!stream) return;
    const enabled = mode === "always_on";
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  // ── Mic reinit on device or connection change ──
  useEffect(() => {
    if (!enableReinit || !pcRef.current) return;
    stopLocalMonitor();
    const generation = ++micReinitGenerationRef.current;
    void (async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const newCaptureStream = await getMicStream(selectedInputDeviceId);
        if (generation !== micReinitGenerationRef.current) {
          for (const t of newCaptureStream.getTracks()) t.stop();
          return;
        }
        stopInputProcessing();
        inputCaptureStreamRef.current = newCaptureStream;
        const newStream = buildOutgoingMicStream(
          newCaptureStream,
          selectedInputGainFor(selectedInputDeviceId),
        );
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          pc.addTrack(newTrack, newStream);
        }
        await onAfterAudioSenderUpdated?.(pc);
        if (generation !== micReinitGenerationRef.current) {
          for (const t of newStream.getTracks()) t.stop();
          return;
        }
        if (localStreamRef.current) {
          for (const t of localStreamRef.current.getTracks()) t.stop();
        }
        localStreamRef.current = newStream;
        if (isUserSettingsOpenRef.current) {
          startLevelMeter(newCaptureStream);
        } else {
          stopLevelMeter();
        }
        applyVoiceModeToLocalTracks(voiceModeRef.current);
        void onRefreshAudioDevices();
        onAudioError("");
      } catch (e) {
        onAudioError(
          `Failed to switch microphone: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    })();
    return () => {
      if (generation === micReinitGenerationRef.current) {
        micReinitGenerationRef.current += 1;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputDeviceId, enableReinit]);

  // ── Input gain node live update ──
  useEffect(() => {
    const selectedGain = selectedInputGainFor(selectedInputDeviceId);
    if (inputGainNodeRef.current) {
      inputGainNodeRef.current.gain.value = effectiveInputGain(selectedGain);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputDeviceId, inputGainByDeviceId]);

  // ── Level meter toggle + local monitor auto-stop (settings panel open/close) ──
  useEffect(() => {
    if (!isUserSettingsOpen) {
      stopLevelMeter();
      stopLocalMonitor();
      return;
    }
    const captureStream = inputCaptureStreamRef.current;
    if (captureStream) startLevelMeter(captureStream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUserSettingsOpen]);

  // ── Clipping display debounce ──
  useEffect(() => {
    if (displayedInputClipping === inputSamplePeakClipping) return;
    if (inputClippingDisplayTimeoutRef.current !== null) {
      window.clearTimeout(inputClippingDisplayTimeoutRef.current);
      inputClippingDisplayTimeoutRef.current = null;
    }
    inputClippingDisplayTimeoutRef.current = window.setTimeout(() => {
      inputClippingDisplayTimeoutRef.current = null;
      setDisplayedInputClipping(inputSamplePeakClipping);
    }, 2000);
    return () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
    };
  }, [inputSamplePeakClipping, displayedInputClipping]);

  // Cleanup clipping timeout and local monitor on unmount
  useEffect(
    () => () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
      stopLocalMonitor();
    },
    [],
  );

  // ── Secure context check ──
  useEffect(() => {
    if (!(window.isSecureContext || window.location.hostname === "localhost")) {
      onAudioError(
        "Microphone capture needs HTTPS (or localhost). Open the app via HTTPS for remote devices.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    localStreamRef,
    inputGainNodeRef,
    inputCaptureStreamRef,
    micReinitGenerationRef,
    inputLevelDbFs,
    displayedInputClipping,
    isLocalMonitorActive,
    getMicStream,
    buildOutgoingMicStream,
    stopInputProcessing,
    startLevelMeter,
    stopLevelMeter,
    applyVoiceModeToLocalTracks,
    startLocalMonitor,
    stopLocalMonitor,
  };
}
