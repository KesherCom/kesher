import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNativeAudio } from "./useNativeAudio";

// The desktop app has only window.__TAURI_INTERNALS__ (no withGlobalTauri),
// and Tauri 2 expects command arguments in camelCase. Both broke the native
// audio path once without any visible error.
describe("useNativeAudio in the desktop app", () => {
  const invoke = vi.fn(() => Promise.resolve(undefined));

  beforeEach(() => {
    invoke.mockClear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: () => 1,
    };
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("detects the app without the global Tauri API", () => {
    const { result } = renderHook(() => useNativeAudio());
    expect(result.current.isNative).toBe(true);
  });

  it("sends command arguments in camelCase", () => {
    const { result } = renderHook(() => useNativeAudio());
    result.current.setAudioGate(true, -40);
    result.current.setOutputGains({ u1: 0.5 });
    result.current.setOutputDevice("speakers");
    result.current.setPerformanceOutputGains({ s1: 1 });

    const args = Object.fromEntries(
      invoke.mock.calls.map((call) => {
        const [cmd, payload] = call as unknown as [string, Record<string, unknown>];
        return [cmd, payload];
      }),
    );
    expect(args.set_audio_gate).toEqual({ enabled: true, thresholdDb: -40 });
    expect(args.set_native_audio_gate).toEqual({ enabled: true, thresholdDb: -40 });
    expect(args.set_output_gains).toEqual({ gainsByUserId: { u1: 0.5 } });
    expect(args.set_output_device).toEqual({ outputDeviceId: "speakers" });
    expect(args.set_native_output_gains).toEqual({ gainsBySourceId: { s1: 1 } });
  });
});
