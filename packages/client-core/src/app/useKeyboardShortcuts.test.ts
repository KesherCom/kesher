import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useKeyboardShortcuts,
  type ShortcutCallbacks,
} from "./useKeyboardShortcuts";
import type { KeyboardShortcutSettings } from "./settings";

function fireKey(
  type: "keydown" | "keyup",
  code: string,
  opts: Partial<KeyboardEvent> = {},
) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(event);
  return event;
}

describe("useKeyboardShortcuts", () => {
  const defaultShortcuts: KeyboardShortcutSettings = {
    ptt: { code: "Space" },
    toggleAlwaysOn: { code: "KeyA" },
  };

  let pttStart: Mock<() => void>;
  let pttStop: Mock<() => void>;
  let toggleAlwaysOn: Mock<() => void>;
  let callbacks: ShortcutCallbacks;

  beforeEach(() => {
    pttStart = vi.fn();
    pttStop = vi.fn();
    toggleAlwaysOn = vi.fn();
    callbacks = {
      ptt: { onStart: pttStart, onStop: pttStop },
      toggleAlwaysOn: { onToggle: toggleAlwaysOn },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires ptt onStart on keydown and onStop on keyup", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, true));

    fireKey("keydown", "Space");
    expect(pttStart).toHaveBeenCalledTimes(1);
    expect(pttStop).not.toHaveBeenCalled();

    fireKey("keyup", "Space");
    expect(pttStop).toHaveBeenCalledTimes(1);
  });

  it("does not repeat-fire on held key", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, true));

    fireKey("keydown", "Space");
    fireKey("keydown", "Space", { repeat: true } as any);
    fireKey("keydown", "Space", { repeat: true } as any);
    expect(pttStart).toHaveBeenCalledTimes(1);
  });

  it("fires toggle on single keydown (no repeat)", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, true));

    fireKey("keydown", "KeyA");
    expect(toggleAlwaysOn).toHaveBeenCalledTimes(1);

    // Key up should NOT re-trigger
    fireKey("keyup", "KeyA");
    expect(toggleAlwaysOn).toHaveBeenCalledTimes(1);
  });

  it("ignores shortcuts when disabled", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, false));

    fireKey("keydown", "Space");
    expect(pttStart).not.toHaveBeenCalled();
  });

  it("ignores unbound keys", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, true));

    fireKey("keydown", "KeyZ");
    expect(pttStart).not.toHaveBeenCalled();
    expect(toggleAlwaysOn).not.toHaveBeenCalled();
  });

  it("ignores events when target is an input element", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, true));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent("keydown", {
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: input });
    window.dispatchEvent(event);

    expect(pttStart).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("releases held actions on window blur", () => {
    renderHook(() => useKeyboardShortcuts(defaultShortcuts, callbacks, true));

    fireKey("keydown", "Space");
    expect(pttStart).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("blur"));
    expect(pttStop).toHaveBeenCalledTimes(1);
  });

  it("respects modifier keys in bindings", () => {
    const shortcuts: KeyboardShortcutSettings = {
      ptt: { code: "Space", ctrl: true },
      toggleAlwaysOn: null,
    };

    renderHook(() => useKeyboardShortcuts(shortcuts, callbacks, true));

    // Without ctrl → should NOT match
    fireKey("keydown", "Space");
    expect(pttStart).not.toHaveBeenCalled();

    // With ctrl → should match
    fireKey("keydown", "Space", { ctrlKey: true });
    expect(pttStart).toHaveBeenCalledTimes(1);
  });

  it("handles null bindings gracefully", () => {
    const shortcuts: KeyboardShortcutSettings = {
      ptt: null,
      toggleAlwaysOn: null,
    };

    renderHook(() => useKeyboardShortcuts(shortcuts, callbacks, true));

    fireKey("keydown", "Space");
    expect(pttStart).not.toHaveBeenCalled();
    expect(toggleAlwaysOn).not.toHaveBeenCalled();
  });
});
