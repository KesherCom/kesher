/**
 * useNativeAudio — bridges the Tauri native audio engine to the existing
 * WebSocket signaling flow.
 *
 * When running inside Tauri:
 *   - `list_audio_devices` replaces `navigator.mediaDevices.enumerateDevices`
 *   - On `webrtc_offer` from the Go SFU, we call `start_audio_engine` (Rust)
 *     instead of creating a browser `RTCPeerConnection`.
 *   - The Rust layer returns an answer SDP + ICE candidates, which we relay
 *     back over the existing WebSocket.
 *   - PTT state changes call `set_ptt` via IPC.
 *   - Level meter events from Rust are forwarded to the callback.
 *
 * When NOT running in Tauri the hook is a no-op: all audio continues to flow
 * through the browser RTCPeerConnection path in useIntercomSession.
 */
import { useCallback, useEffect, useRef } from "react";

// ── Tauri IPC shim ────────────────────────────────────────────────────────────

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
      event: {
        listen: <T>(event: string, cb: (ev: { payload: T }) => void) => Promise<() => void>;
      };
    };
  }
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI__!.core.invoke<T>(cmd, args);
}

function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  return window.__TAURI__!.event.listen<T>(event, (ev) => cb(ev.payload));
}

// ── Public types ──────────────────────────────────────────────────────────────

export type NativeAudioDevice = {
  id: string;
  name: string;
  kind: "audioinput" | "audiooutput";
};

export type NativeAudioLevelEvent = {
  input_peak: number;
  output_peak: number;
};

export type NativeAudioEndpoint = {
  host: string;
  port: number;
  token: string;
  tokenHash: number;
  frameDurationMs: number;
  sampleRate: number;
  channels: number;
};

export type NativeAudioHook = {
  /** True if running inside Tauri with the native audio engine available. */
  isNative: boolean;
  /**
   * List audio devices via CPAL (replaces `enumerateDevices` in native mode).
   * Returns an empty array when not in Tauri.
   */
  listDevices: () => Promise<NativeAudioDevice[]>;
  /**
   * Handle a `webrtc_offer` from the Go SFU.  In native mode, forwards to the
   * Rust engine and returns the answer SDP; in browser mode returns null so the
   * caller can fall back to RTCPeerConnection.
   */
  handleOffer: (params: {
    offerSdp: string;
    inputDeviceId?: string;
    outputDeviceId?: string;
    inputGain?: number;
    audioGateEnabled?: boolean;
    audioGateThresholdDb?: number;
  }) => Promise<{ answerSdp: string; iceCandidates: string[] } | null>;
  /** Open or close the send gate in the Rust engine. */
  setPtt: (active: boolean) => void;
  setInputGain: (gain: number) => void;
  setAudioGate: (enabled: boolean, thresholdDb: number) => void;
  setOutputGains: (gainsByUserId: Record<string, number>) => void;
  setOutputDevice: (outputDeviceId: string) => void;
  /** Tear down the native engine (call on disconnect). */
  stopEngine: () => Promise<void>;
  // ── Performance Mode (UDP) ────────────────────────────────────────────
  /**
   * Start the native UDP performance pipeline. Called after the server WS
   * sends a `native_audio_endpoint` message announcing it expects native
   * transport. No-op in browser mode.
   */
  startPerformanceEngine: (
    endpoint: NativeAudioEndpoint,
    devices?: { inputDeviceId?: string; outputDeviceId?: string },
  ) => Promise<void>;
  /** Tear down the performance engine. */
  stopPerformanceEngine: () => Promise<void>;
  /** Mic gate for the performance pipeline (mirrors `setPtt` semantics). */
  setPerformanceMic: (active: boolean) => void;
};

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * @param onLevelMeter  Optional callback for input/output level updates.
 */
export function useNativeAudio(
  onLevelMeter?: (event: NativeAudioLevelEvent) => void,
): NativeAudioHook {
  const isNative = typeof window !== "undefined" && "__TAURI__" in window;
  const unlistenRef = useRef<(() => void) | null>(null);

  // Subscribe to level meter events from Rust
  useEffect(() => {
    if (!isNative || !onLevelMeter) return;

    let cancelled = false;

    tauriListen<NativeAudioLevelEvent>("audio_level_meter", onLevelMeter).then(
      (unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      },
    );

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [isNative, onLevelMeter]);

  const listDevices = useCallback(async (): Promise<NativeAudioDevice[]> => {
    if (!isNative) return [];
    try {
      return await tauriInvoke<NativeAudioDevice[]>("list_audio_devices");
    } catch (err) {
      console.error("[native-audio] list_audio_devices failed:", err);
      return [];
    }
  }, [isNative]);

  const handleOffer = useCallback(
    async (params: {
      offerSdp: string;
      inputDeviceId?: string;
      outputDeviceId?: string;
      inputGain?: number;
      audioGateEnabled?: boolean;
      audioGateThresholdDb?: number;
    }): Promise<{ answerSdp: string; iceCandidates: string[] } | null> => {
      if (!isNative) return null;

      try {
        const result = await tauriInvoke<{
          answer_sdp: string;
          ice_candidates: string[];
        }>("start_audio_engine", {
          params: {
            offer_sdp: params.offerSdp,
            input_device_id: params.inputDeviceId ?? null,
            output_device_id: params.outputDeviceId ?? null,
            input_gain: params.inputGain ?? null,
            audio_gate_enabled: params.audioGateEnabled ?? null,
            audio_gate_threshold_db: params.audioGateThresholdDb ?? null,
          },
        });

        return {
          answerSdp: result.answer_sdp,
          iceCandidates: result.ice_candidates,
        };
      } catch (err) {
        console.error("[native-audio] start_audio_engine failed:", err);
        // Returning null causes the caller to fall back to browser WebRTC
        return null;
      }
    },
    [isNative],
  );

  const setPtt = useCallback(
    (active: boolean) => {
      if (!isNative) return;
      tauriInvoke("set_ptt", { active }).catch((err) =>
        console.error("[native-audio] set_ptt failed:", err),
      );
    },
    [isNative],
  );

  const setInputGain = useCallback(
    (gain: number) => {
      if (!isNative) return;
      tauriInvoke("set_input_gain", { gain }).catch((err) =>
        console.error("[native-audio] set_input_gain failed:", err),
      );
    },
    [isNative],
  );

  const setAudioGate = useCallback(
    (enabled: boolean, thresholdDb: number) => {
      if (!isNative) return;
      tauriInvoke("set_audio_gate", {
        enabled,
        threshold_db: thresholdDb,
      }).catch((err) =>
        console.error("[native-audio] set_audio_gate failed:", err),
      );
    },
    [isNative],
  );

  const setOutputGains = useCallback(
    (gainsByUserId: Record<string, number>) => {
      if (!isNative) return;
      tauriInvoke("set_output_gains", {
        gains_by_user_id: gainsByUserId,
      }).catch((err) =>
        console.error("[native-audio] set_output_gains failed:", err),
      );
    },
    [isNative],
  );

  const setOutputDevice = useCallback(
    (outputDeviceId: string) => {
      if (!isNative) return;
      tauriInvoke("set_output_device", {
        output_device_id: outputDeviceId || null,
      }).catch((err) =>
        console.error("[native-audio] set_output_device failed:", err),
      );
    },
    [isNative],
  );

  const stopEngine = useCallback(async () => {
    if (!isNative) return;
    try {
      await tauriInvoke("stop_audio_engine");
    } catch (err) {
      console.error("[native-audio] stop_audio_engine failed:", err);
    }
  }, [isNative]);

  // ── Performance-Mode (UDP) bindings ────────────────────────────────────

  const startPerformanceEngine = useCallback(
    async (
      endpoint: NativeAudioEndpoint,
      devices?: { inputDeviceId?: string; outputDeviceId?: string },
    ): Promise<void> => {
      if (!isNative) return;
      try {
        await tauriInvoke("start_native_audio", {
          params: {
            server_host: endpoint.host,
            server_port: endpoint.port,
            session_token: endpoint.token,
            token_hash: endpoint.tokenHash,
            input_device_id: devices?.inputDeviceId ?? null,
            output_device_id: devices?.outputDeviceId ?? null,
          },
        });
      } catch (err) {
        console.error("[native-audio] start_native_audio failed:", err);
        throw err;
      }
    },
    [isNative],
  );

  const stopPerformanceEngine = useCallback(async () => {
    if (!isNative) return;
    try {
      await tauriInvoke("stop_native_audio");
    } catch (err) {
      console.error("[native-audio] stop_native_audio failed:", err);
    }
  }, [isNative]);

  const setPerformanceMic = useCallback(
    (active: boolean) => {
      if (!isNative) return;
      tauriInvoke("set_native_mic", { active }).catch((err) =>
        console.error("[native-audio] set_native_mic failed:", err),
      );
    },
    [isNative],
  );

  return {
    isNative,
    listDevices,
    handleOffer,
    setPtt,
    setInputGain,
    setAudioGate,
    setOutputGains,
    setOutputDevice,
    stopEngine,
    startPerformanceEngine,
    stopPerformanceEngine,
    setPerformanceMic,
  };
}
