import { beforeEach, describe, expect, it } from "vitest";
import {
  clampGainValue,
  clampInputGainValue,
  favoritesStorageKey,
  globalSettingsStorageKey,
  loadFavoriteSettings,
  loadGlobalSettings,
  loadSessionSettings,
  micInputBaseBoost,
  sessionSettingsStorageKey,
} from "./settings";

describe("settings helpers", () => {
  beforeEach(() => {
    localStorage.removeItem(sessionSettingsStorageKey);
    localStorage.removeItem(globalSettingsStorageKey);
    localStorage.removeItem(favoritesStorageKey);
  });

  it("clamps output gain values to expected range", () => {
    expect(clampGainValue(-1)).toBe(0);
    expect(clampGainValue(3)).toBe(2);
    expect(clampGainValue(1.25)).toBe(1.25);
    expect(clampGainValue(Number.NaN)).toBe(1);
  });

  it("clamps input gain values to expanded range", () => {
    expect(clampInputGainValue(-1)).toBe(0);
    expect(clampInputGainValue(8)).toBe(8);
    expect(clampInputGainValue(99)).toBe(16);
    expect(clampInputGainValue(Number.POSITIVE_INFINITY)).toBe(1);
    expect(micInputBaseBoost).toBe(2);
  });

  it("loads default session settings when unset or invalid", () => {
    expect(loadSessionSettings()).toEqual({
      username: "",
      roleId: "",
      listenRoomIds: [],
      talkRoomIds: [],
    });

    localStorage.setItem(sessionSettingsStorageKey, "{not-json");
    expect(loadSessionSettings()).toEqual({
      username: "",
      roleId: "",
      listenRoomIds: [],
      talkRoomIds: [],
    });
  });

  it("defaults to unswapped footer buttons when global settings are unset", () => {
    expect(loadGlobalSettings()).toEqual({
      selectedInputDeviceId: "",
      selectedOutputDeviceId: "",
      enableDirectPpt: false,
      enableDirectTabs: false,
      swapPttAndReplyButtons: false,
      enableBackgroundAudioRecovery: true,
      keepScreenAwake: false,
      showVolumeControls: true,
      inputGainByDeviceId: {},
      roomGainById: {},
      directGainByUserId: {},
    });
  });

  it("sanitizes global settings with safe defaults and clamped gain maps", () => {
    localStorage.setItem(
      globalSettingsStorageKey,
      JSON.stringify({
        selectedInputDeviceId: "mic-1",
        selectedOutputDeviceId: "spk-1",
        enableDirectPpt: true,
        enableDirectTabs: false,
        swapPttAndReplyButtons: true,
        enableBackgroundAudioRecovery: false,
        keepScreenAwake: true,
        inputGainByDeviceId: { "mic-1": 0.9, broken: -3 },
        roomGainById: { a: 1.5, b: -2 },
        directGainByUserId: { u1: 5, u2: 0.5 },
      }),
    );

    expect(loadGlobalSettings()).toEqual({
      selectedInputDeviceId: "mic-1",
      selectedOutputDeviceId: "spk-1",
      enableDirectPpt: true,
      enableDirectTabs: false,
      swapPttAndReplyButtons: true,
      enableBackgroundAudioRecovery: false,
      keepScreenAwake: true,
      showVolumeControls: true,
      inputGainByDeviceId: { "mic-1": 0.9, broken: 0 },
      roomGainById: { a: 1.5, b: 0 },
      directGainByUserId: { u1: 2, u2: 0.5 },
    });
  });

  it("filters favorite settings to valid values only", () => {
    localStorage.setItem(
      favoritesStorageKey,
      JSON.stringify({
        pinnedRoomIds: ["r1", 123, null],
        pinnedUserIds: ["u1", false],
        showPinnedOnly: true,
      }),
    );
    expect(loadFavoriteSettings()).toEqual({
      pinnedRoomIds: ["r1"],
      pinnedUserIds: ["u1"],
      showPinnedOnly: true,
    });
  });
});
