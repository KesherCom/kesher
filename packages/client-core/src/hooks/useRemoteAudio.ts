/**
 * Manages remote audio playback elements, per-track Web Audio analyser nodes,
 * output-device routing (setSinkId), volume gain, and the incoming-audio
 * activity indicator.
 *
 * The caller is responsible for supplying `resolveGainForSourceUser` and
 * for setting `remoteSourceUserIdRef` entries when `pc.ontrack` fires.
 *
 * Exposed refs are shared with the WebRTC `ontrack` handler so the caller can
 * attach new audio elements/analyser nodes without storing them locally.
 */
import { useEffect, useRef, useState } from "react";

export type UseRemoteAudioOptions = {
  /** Currently selected output device id. */
  selectedOutputDeviceId: string;
  /** Stable ref version for use inside async callbacks. */
  selectedOutputDeviceIdRef: React.MutableRefObject<string>;
  /** Room gain map – listed as dep so volume is reapplied on changes. */
  roomGainById: Record<string, number>;
  /** Direct-user gain map – listed as dep so volume is reapplied on changes. */
  directGainByUserId: Record<string, number>;
  /**
   * A stable ref wrapping the upstream `resolveGainForSourceUser` function.
   * Using a ref means the audio meter loop always calls the latest version
   * without the effect having to re-register.
   */
  resolveGainRef: React.MutableRefObject<(sourceUserID: string) => number>;
  /** Called when a recoverable audio error occurs. */
  onAudioError: (msg: string) => void;
};

export type UseRemoteAudioResult = {
  /** HTMLAudioElement map keyed by `${trackId}-${streamId}`. */
  remoteAudioRef: React.MutableRefObject<Map<string, HTMLAudioElement>>;
  /** Maps track key to the source user-id resolved from SDP mid. */
  remoteSourceUserIdRef: React.MutableRefObject<Map<string, string>>;
  /** Per-key Web Audio chain (ctx + analyser + gain + buffer). */
  remoteAnalyserNodesRef: React.MutableRefObject<
    Map<
      string,
      {
        ctx: AudioContext;
        analyser: AnalyserNode;
        gain: GainNode;
        buf: Uint8Array;
      }
    >
  >;
  /** True while incoming audio is detected above the RMS threshold. */
  incomingAudioActive: boolean;

  applyOutputDeviceToAudio: (
    audio: HTMLAudioElement,
    outputDeviceId: string,
  ) => Promise<boolean>;
  applyVolumeToRemoteAudio: (key: string) => void;
  applyVolumeToAllRemoteAudio: () => void;
  startRemoteAudioMeterLoop: () => void;
  stopRemoteAudioMeter: () => void;
  pauseAllRemoteAudio: () => void;
  retryPlayAllRemoteAudio: () => Promise<void>;
  resumeRemoteAudioContexts: () => Promise<void>;
};

export function useRemoteAudio({
  selectedOutputDeviceId,
  roomGainById,
  directGainByUserId,
  resolveGainRef,
  onAudioError,
}: UseRemoteAudioOptions): UseRemoteAudioResult {
  // ── State ──
  const [incomingAudioActive, setIncomingAudioActive] = useState(false);

  // ── Refs ──
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteSourceUserIdRef = useRef<Map<string, string>>(new Map());
  const remoteAnalyserNodesRef = useRef<
    Map<
      string,
      {
        ctx: AudioContext;
        analyser: AnalyserNode;
        gain: GainNode;
        buf: Uint8Array;
      }
    >
  >(new Map());
  const remoteAudioMeterRafRef = useRef<number | null>(null);
  const incomingAudioOffTimeoutRef = useRef<number | null>(null);
  const incomingAudioActiveRef = useRef(false);

  // ── Output device ──
  async function applyOutputDeviceToAudio(
    audio: HTMLAudioElement,
    outputDeviceId: string,
  ): Promise<boolean> {
    type AudioWithSinkId = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const audioWithSink = audio as AudioWithSinkId;
    if (typeof audioWithSink.setSinkId !== "function")
      return outputDeviceId === "";
    const sinkId = outputDeviceId || "default";
    try {
      await audioWithSink.setSinkId(sinkId);
      return true;
    } catch (err) {
      onAudioError(
        `Failed to switch speaker output: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return false;
    }
  }

  // Apply output device when it changes
  useEffect(() => {
    for (const audio of remoteAudioRef.current.values()) {
      void (async () => {
        const sinkApplied = await applyOutputDeviceToAudio(
          audio,
          selectedOutputDeviceId,
        );
        // Fail closed for explicit device selection to avoid default-device leaks.
        if (selectedOutputDeviceId && !sinkApplied) {
          audio.pause();
          audio.muted = true;
          return;
        }
        audio.muted = false;
        if (audio.srcObject) {
          await audio.play();
        }
      })().catch((err) => {
        onAudioError(
          `Failed to resume remote audio: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOutputDeviceId]);

  // ── Volume routing ──
  function applyVolumeToRemoteAudio(key: string) {
    const sourceUserID = remoteSourceUserIdRef.current.get(key) || "";
    const gainValue = resolveGainRef.current(sourceUserID);
    const analyserNode = remoteAnalyserNodesRef.current.get(key);
    if (analyserNode) analyserNode.gain.gain.value = gainValue;
    const audio = remoteAudioRef.current.get(key);
    if (audio) audio.volume = Math.min(1, Math.max(0, gainValue));
  }

  function applyVolumeToAllRemoteAudio() {
    for (const key of remoteAudioRef.current.keys()) {
      applyVolumeToRemoteAudio(key);
    }
  }

  // Re-apply volume when gain maps change
  useEffect(() => {
    applyVolumeToAllRemoteAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomGainById, directGainByUserId]);

  // ── Incoming audio meter ──
  function stopRemoteAudioMeter() {
    if (remoteAudioMeterRafRef.current !== null) {
      cancelAnimationFrame(remoteAudioMeterRafRef.current);
      remoteAudioMeterRafRef.current = null;
    }
    if (incomingAudioOffTimeoutRef.current !== null) {
      window.clearTimeout(incomingAudioOffTimeoutRef.current);
      incomingAudioOffTimeoutRef.current = null;
    }
    for (const { ctx } of remoteAnalyserNodesRef.current.values()) {
      void ctx.close();
    }
    remoteAnalyserNodesRef.current.clear();
    incomingAudioActiveRef.current = false;
    setIncomingAudioActive(false);
  }

  function startRemoteAudioMeterLoop() {
    if (remoteAudioMeterRafRef.current !== null) return;
    const tick = () => {
      let active = false;
      for (const { analyser, buf } of remoteAnalyserNodesRef.current.values()) {
        analyser.getByteTimeDomainData(
          buf as unknown as Uint8Array<ArrayBuffer>,
        );
        let sum = 0;
        for (const v of buf) {
          const centered = (v - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 0.018) {
          active = true;
          break;
        }
      }
      if (active) {
        if (incomingAudioOffTimeoutRef.current !== null) {
          window.clearTimeout(incomingAudioOffTimeoutRef.current);
          incomingAudioOffTimeoutRef.current = null;
        }
        if (!incomingAudioActiveRef.current) {
          incomingAudioActiveRef.current = true;
          setIncomingAudioActive(true);
        }
      } else if (
        incomingAudioActiveRef.current &&
        incomingAudioOffTimeoutRef.current === null
      ) {
        incomingAudioOffTimeoutRef.current = window.setTimeout(() => {
          incomingAudioOffTimeoutRef.current = null;
          incomingAudioActiveRef.current = false;
          setIncomingAudioActive(false);
        }, 1000);
      }
      remoteAudioMeterRafRef.current = requestAnimationFrame(tick);
    };
    remoteAudioMeterRafRef.current = requestAnimationFrame(tick);
  }

  function pauseAllRemoteAudio() {
    for (const audio of remoteAudioRef.current.values()) {
      audio.pause();
    }
  }

  async function resumeRemoteAudioContexts() {
    await Promise.allSettled(
      Array.from(remoteAnalyserNodesRef.current.values()).map(({ ctx }) =>
        ctx.state === "suspended" ? ctx.resume() : Promise.resolve(),
      ),
    );
  }

  async function retryPlayAllRemoteAudio() {
    if (remoteAudioRef.current.size === 0) return;
    await resumeRemoteAudioContexts();
    let successfulPlays = 0;
    let firstError: unknown = null;
    await Promise.allSettled(
      Array.from(remoteAudioRef.current.values()).map(async (audio) => {
        try {
          await audio.play();
          successfulPlays += 1;
        } catch (err) {
          if (firstError === null) firstError = err;
        }
      }),
    );
    if (successfulPlays === 0 && firstError) {
      onAudioError(
        `Remote audio playback blocked: ${firstError instanceof Error ? firstError.message : "unknown error"}`,
      );
    }
  }

  return {
    remoteAudioRef,
    remoteSourceUserIdRef,
    remoteAnalyserNodesRef,
    incomingAudioActive,
    applyOutputDeviceToAudio,
    applyVolumeToRemoteAudio,
    applyVolumeToAllRemoteAudio,
    startRemoteAudioMeterLoop,
    stopRemoteAudioMeter,
    pauseAllRemoteAudio,
    retryPlayAllRemoteAudio,
    resumeRemoteAudioContexts,
  };
}
