export const tokenStorageKey = "intercom-token";
export const sessionSettingsStorageKey = "intercom-session-settings";
export const globalSettingsStorageKey = "intercom-global-settings";
export const favoritesStorageKey = "intercom-favorites";
export const keyboardShortcutsStorageKey = "intercom-keyboard-shortcuts";
export const defaultAdminPin = "123456";
export const defaultAudioGateEnabled = false;
export const defaultAudioGateThresholdDb = -52;

// ── Keyboard shortcut types ──────────────────────────────────────────

/**
 * Actions that can be bound to keyboard shortcuts.
 * - hold-type: active while the key is held down (e.g. PTT)
 * - toggle-type: toggles state on each key press (e.g. always-on)
 */
export type ShortcutAction = "ptt" | "toggleAlwaysOn";

export const shortcutActionMeta: Record<
  ShortcutAction,
  { label: string; type: "hold" | "toggle" }
> = {
  ptt: { label: "Push to Talk (room)", type: "hold" },
  toggleAlwaysOn: { label: "Toggle Always On", type: "toggle" },
};

export const allShortcutActions: ShortcutAction[] = Object.keys(
  shortcutActionMeta,
) as ShortcutAction[];

export type ShortcutBinding = {
  code: string; // KeyboardEvent.code, e.g. "Space", "KeyT"
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type KeyboardShortcutSettings = Record<
  ShortcutAction,
  ShortcutBinding | null
>;

export const defaultShortcuts: KeyboardShortcutSettings = {
  ptt: { code: "Space" },
  toggleAlwaysOn: null,
};

/** Human-readable label for a binding. */
export function formatBinding(binding: ShortcutBinding | null): string {
  if (!binding) return "Not set";
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(friendlyKeyName(binding.code));
  return parts.join(" + ");
}

function friendlyKeyName(code: string): string {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return code;
}

export type SessionSettings = {
  username: string;
  roleId: string;
  listenRoomIds: string[];
  talkRoomIds: string[];
};

export function hasStoredSessionSettings(): boolean {
  return localStorage.getItem(sessionSettingsStorageKey) !== null;
}

export type GlobalSettings = {
  selectedInputDeviceId: string;
  selectedOutputDeviceId: string;
  enableDirectPpt: boolean;
  enableDirectTabs: boolean;
  swapPttAndReplyButtons: boolean;
  enableBackgroundAudioRecovery: boolean;
  keepScreenAwake: boolean;
  showVolumeControls: boolean;
  audioGateEnabled: boolean;
  audioGateThresholdDb: number;
  inputGainByDeviceId: Record<string, number>;
  roomGainById: Record<string, number>;
  directGainByUserId: Record<string, number>;
};

export type FavoriteSettings = {
  pinnedRoomIds: string[];
  pinnedUserIds: string[];
  showPinnedOnly: boolean;
};

// Fixed global mic base boost (+6 dB) applied on top of per-device input gain.
export const micInputBaseBoost = 2;

export function clampInputGainValue(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(16, value));
}

export function clampAudioGateThresholdDb(value: number): number {
  if (!Number.isFinite(value)) return defaultAudioGateThresholdDb;
  return Math.max(-72, Math.min(-12, Math.round(value)));
}

export function clampOutputGainValue(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(2, value));
}

// Backward-compatible alias used by existing room/direct volume code paths.
export const clampGainValue = clampOutputGainValue;

function sanitizeGainMap(
  value: unknown,
  clampFn: (value: number) => number,
): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => typeof key === "string" && key.length > 0)
    .map(
      ([key, raw]) => [key, clampFn(typeof raw === "number" ? raw : 1)] as const,
    );
  return Object.fromEntries(entries);
}

export function loadSessionSettings(): SessionSettings {
  try {
    const raw = localStorage.getItem(sessionSettingsStorageKey);
    if (!raw) {
      return { username: "", roleId: "", listenRoomIds: [], talkRoomIds: [] };
    }
    const parsed = JSON.parse(raw) as Partial<SessionSettings>;
    return {
      username: typeof parsed.username === "string" ? parsed.username : "",
      roleId: typeof parsed.roleId === "string" ? parsed.roleId : "",
      listenRoomIds: Array.isArray(parsed.listenRoomIds)
        ? parsed.listenRoomIds.filter((value) => typeof value === "string")
        : [],
      talkRoomIds: Array.isArray(parsed.talkRoomIds)
        ? parsed.talkRoomIds.filter((value) => typeof value === "string")
        : [],
    };
  } catch {
    return { username: "", roleId: "", listenRoomIds: [], talkRoomIds: [] };
  }
}

export function loadGlobalSettings(): GlobalSettings {
  try {
    const raw = localStorage.getItem(globalSettingsStorageKey);
    if (!raw) {
      return {
        selectedInputDeviceId: "",
        selectedOutputDeviceId: "",
        enableDirectPpt: false,
        enableDirectTabs: false,
        swapPttAndReplyButtons: false,
        enableBackgroundAudioRecovery: true,
        keepScreenAwake: false,
        showVolumeControls: true,
        audioGateEnabled: defaultAudioGateEnabled,
        audioGateThresholdDb: defaultAudioGateThresholdDb,
        inputGainByDeviceId: {},
        roomGainById: {},
        directGainByUserId: {},
      };
    }
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
    return {
      selectedInputDeviceId:
        typeof parsed.selectedInputDeviceId === "string"
          ? parsed.selectedInputDeviceId
          : "",
      selectedOutputDeviceId:
        typeof parsed.selectedOutputDeviceId === "string"
          ? parsed.selectedOutputDeviceId
          : "",
      enableDirectPpt:
        typeof parsed.enableDirectPpt === "boolean"
          ? parsed.enableDirectPpt
          : false,
      enableDirectTabs:
        typeof parsed.enableDirectTabs === "boolean"
          ? parsed.enableDirectTabs
          : false,
      swapPttAndReplyButtons:
        typeof parsed.swapPttAndReplyButtons === "boolean"
          ? parsed.swapPttAndReplyButtons
          : false,
      enableBackgroundAudioRecovery:
        typeof parsed.enableBackgroundAudioRecovery === "boolean"
          ? parsed.enableBackgroundAudioRecovery
          : true,
      keepScreenAwake:
        typeof parsed.keepScreenAwake === "boolean"
          ? parsed.keepScreenAwake
          : false,
      showVolumeControls:
        typeof parsed.showVolumeControls === "boolean"
          ? parsed.showVolumeControls
          : true,
      audioGateEnabled:
        typeof parsed.audioGateEnabled === "boolean"
          ? parsed.audioGateEnabled
          : defaultAudioGateEnabled,
      audioGateThresholdDb: clampAudioGateThresholdDb(
        typeof parsed.audioGateThresholdDb === "number"
          ? parsed.audioGateThresholdDb
          : defaultAudioGateThresholdDb,
      ),
      inputGainByDeviceId: sanitizeGainMap(
        parsed.inputGainByDeviceId,
        clampInputGainValue,
      ),
      roomGainById: sanitizeGainMap(parsed.roomGainById, clampOutputGainValue),
      directGainByUserId: sanitizeGainMap(
        parsed.directGainByUserId,
        clampOutputGainValue,
      ),
    };
  } catch {
    return {
      selectedInputDeviceId: "",
      selectedOutputDeviceId: "",
      enableDirectPpt: false,
      enableDirectTabs: false,
      swapPttAndReplyButtons: false,
      enableBackgroundAudioRecovery: true,
      keepScreenAwake: false,
      showVolumeControls: true,
      audioGateEnabled: defaultAudioGateEnabled,
      audioGateThresholdDb: defaultAudioGateThresholdDb,
      inputGainByDeviceId: {},
      roomGainById: {},
      directGainByUserId: {},
    };
  }
}

export function loadFavoriteSettings(): FavoriteSettings {
  try {
    const raw = localStorage.getItem(favoritesStorageKey);
    if (!raw) {
      return { pinnedRoomIds: [], pinnedUserIds: [], showPinnedOnly: false };
    }
    const parsed = JSON.parse(raw) as Partial<FavoriteSettings>;
    return {
      pinnedRoomIds: Array.isArray(parsed.pinnedRoomIds)
        ? parsed.pinnedRoomIds.filter((value) => typeof value === "string")
        : [],
      pinnedUserIds: Array.isArray(parsed.pinnedUserIds)
        ? parsed.pinnedUserIds.filter((value) => typeof value === "string")
        : [],
      showPinnedOnly:
        typeof parsed.showPinnedOnly === "boolean"
          ? parsed.showPinnedOnly
          : false,
    } satisfies FavoriteSettings;
  } catch {
    return { pinnedRoomIds: [], pinnedUserIds: [], showPinnedOnly: false };
  }
}

function sanitizeBinding(value: unknown): ShortcutBinding | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.length === 0) return null;
  return {
    code: record.code,
    ...(record.ctrl === true ? { ctrl: true } : {}),
    ...(record.shift === true ? { shift: true } : {}),
    ...(record.alt === true ? { alt: true } : {}),
  };
}

export function loadKeyboardShortcuts(): KeyboardShortcutSettings {
  try {
    const raw = localStorage.getItem(keyboardShortcutsStorageKey);
    if (!raw) return { ...defaultShortcuts };
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutAction, unknown>>;
    const result = { ...defaultShortcuts };
    for (const action of allShortcutActions) {
      if (action in parsed) {
        result[action] = sanitizeBinding(parsed[action]);
      }
    }
    return result;
  } catch {
    return { ...defaultShortcuts };
  }
}
