/**
 * Manages local microphone capture, input-gain processing, input level
 * metering, and track hot-swapping when the selected device changes.
 *
 * Exposed refs (`localStreamRef`, `inputGainNodeRef`, `inputCaptureStreamRef`,
 * `micReinitGenerationRef`) are mutable and shared with the WebRTC layer so the
 * caller can access the current stream / gain node without triggering re-renders.
 */
import { useEffect, useRef, useState } from "react";
import { clampGainValue } from "../app/settings";
import { meterDbFsFloor, peakAmplitudeToDbFs } from "../lib/presence";

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

  getMicStream: (deviceId: string) => Promise<MediaStream>;
  buildOutgoingMicStream: (
    sourceStream: MediaStream,
    gainValue: number,
  ) => MediaStream;
  stopInputProcessing: () => void;
  startLevelMeter: (stream: MediaStream) => void;
  stopLevelMeter: () => void;
  applyVoiceModeToLocalTracks: (mode: "always_on" | "ptt") => void;
};

export function useLocalMic({
  selectedInputDeviceId,
  selectedInputGainFor,
  inputGainByDeviceId,
  isUserSettingsOpen,
  isUserSettingsOpenRef,
  voiceModeRef,
  pcRef,
  onAudioError,
  onRefreshAudioDevices,
  enableReinit,
}: UseLocalMicOptions): UseLocalMicResult {
  // ── State ──
  const [inputLevelDbFs, setInputLevelDbFs] = useState(meterDbFsFloor);
  const [inputSamplePeakClipping, setInputSamplePeakClipping] = useState(false);
  const [displayedInputClipping, setDisplayedInputClipping] = useState(false);

  // ── Refs ──
  const localStreamRef = useRef<MediaStream | null>(null);
  const inputCaptureStreamRef = useRef<MediaStream | null>(null);
  const inputProcessingAudioCtxRef = useRef<AudioContext | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterMonitorStreamRef = useRef<MediaStream | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const inputClippingDisplayTimeoutRef = useRef<number | null>(null);
  const micReinitGenerationRef = useRef(0);

  // ── Mic stream acquisition ──
  async function getMicStream(deviceId: string): Promise<MediaStream> {
    const baseAudio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...baseAudio, deviceId: { exact: deviceId } },
          video: false,
        });
      } catch {
        return navigator.mediaDevices.getUserMedia({
          audio: baseAudio,
          video: false,
        });
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
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
      const ctx = new AudioCtx();
      const src = ctx.createMediaStreamSource(sourceStream);
      const gain = ctx.createGain();
      gain.gain.value = clampGainValue(gainValue);
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(dest);
      const processedTrack = dest.stream.getAudioTracks()[0];
      if (!processedTrack) {
        void ctx.close();
        return sourceStream;
      }
      inputProcessingAudioCtxRef.current = ctx;
      inputGainNodeRef.current = gain;
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
    const ctx = new AudioCtx();
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
      meterGain.gain.value = clampGainValue(
        inputGainNodeRef.current?.gain.value ?? 1,
      );
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
      inputGainNodeRef.current.gain.value = selectedGain;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputDeviceId, inputGainByDeviceId]);

  // ── Level meter toggle (settings panel open/close) ──
  useEffect(() => {
    if (!isUserSettingsOpen) {
      stopLevelMeter();
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

  // Cleanup clipping timeout on unmount
  useEffect(
    () => () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
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
    getMicStream,
    buildOutgoingMicStream,
    stopInputProcessing,
    startLevelMeter,
    stopLevelMeter,
    applyVoiceModeToLocalTracks,
  };
}
