import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultShortcuts,
  formatBinding,
  keyboardShortcutsStorageKey,
  loadKeyboardShortcuts,
  type ShortcutBinding,
} from "./settings";

describe("keyboard shortcut settings", () => {
  beforeEach(() => {
    localStorage.removeItem(keyboardShortcutsStorageKey);
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadKeyboardShortcuts()).toEqual(defaultShortcuts);
  });

  it("returns defaults for invalid JSON", () => {
    localStorage.setItem(keyboardShortcutsStorageKey, "{bad");
    expect(loadKeyboardShortcuts()).toEqual(defaultShortcuts);
  });

  it("loads custom bindings from localStorage", () => {
    localStorage.setItem(
      keyboardShortcutsStorageKey,
      JSON.stringify({
        ptt: { code: "KeyT", ctrl: true },
        toggleAlwaysOn: { code: "KeyA" },
      }),
    );
    const result = loadKeyboardShortcuts();
    expect(result.ptt).toEqual({ code: "KeyT", ctrl: true });
    expect(result.toggleAlwaysOn).toEqual({ code: "KeyA" });
  });

  it("preserves defaults for actions not present in stored data", () => {
    localStorage.setItem(
      keyboardShortcutsStorageKey,
      JSON.stringify({ toggleAlwaysOn: { code: "KeyX" } }),
    );
    const result = loadKeyboardShortcuts();
    // ptt should keep default
    expect(result.ptt).toEqual(defaultShortcuts.ptt);
    expect(result.toggleAlwaysOn).toEqual({ code: "KeyX" });
  });

  it("sanitizes invalid binding values to null", () => {
    localStorage.setItem(
      keyboardShortcutsStorageKey,
      JSON.stringify({
        ptt: "not-an-object",
        toggleAlwaysOn: { code: "" }, // empty code
      }),
    );
    const result = loadKeyboardShortcuts();
    expect(result.ptt).toBeNull();
    expect(result.toggleAlwaysOn).toBeNull();
  });

  it("strips non-boolean modifier flags", () => {
    localStorage.setItem(
      keyboardShortcutsStorageKey,
      JSON.stringify({
        ptt: { code: "Space", ctrl: "yes", shift: 1, alt: true },
      }),
    );
    const result = loadKeyboardShortcuts();
    // "yes" and 1 are not booleans – they should be stripped
    expect(result.ptt).toEqual({ code: "Space", alt: true });
  });
});

describe("formatBinding", () => {
  it("returns 'Not set' for null", () => {
    expect(formatBinding(null)).toBe("Not set");
  });

  it("formats a simple key", () => {
    expect(formatBinding({ code: "Space" })).toBe("Space");
  });

  it("formats a Key* code to just the letter", () => {
    expect(formatBinding({ code: "KeyT" })).toBe("T");
  });

  it("formats Digit* codes", () => {
    expect(formatBinding({ code: "Digit3" })).toBe("3");
  });

  it("formats Numpad* codes", () => {
    expect(formatBinding({ code: "Numpad5" })).toBe("Num 5");
  });

  it("includes modifiers in correct order", () => {
    const binding: ShortcutBinding = {
      code: "KeyT",
      ctrl: true,
      alt: true,
      shift: true,
    };
    expect(formatBinding(binding)).toBe("Ctrl + Alt + Shift + T");
  });

  it("includes only set modifiers", () => {
    const binding: ShortcutBinding = { code: "Space", shift: true };
    expect(formatBinding(binding)).toBe("Shift + Space");
  });
});
