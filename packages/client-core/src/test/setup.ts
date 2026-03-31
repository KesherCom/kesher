import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

if (typeof window !== "undefined") {
  const hasValidStorage =
    typeof window.localStorage !== "undefined" &&
    typeof window.localStorage.getItem === "function" &&
    typeof window.localStorage.setItem === "function" &&
    typeof window.localStorage.removeItem === "function" &&
    typeof window.localStorage.clear === "function";

  if (!hasValidStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
      configurable: true,
    });
  }
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [],
        }),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      configurable: true,
    });
  }
}

class MockRTCPeerConnection {
  addTrack() {}
  close() {}
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  createAnswer = vi
    .fn()
    .mockResolvedValue({ type: "answer", sdp: "mock-sdp-answer" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
}

if (typeof globalThis.RTCPeerConnection === "undefined") {
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: MockRTCPeerConnection,
    configurable: true,
  });
}
