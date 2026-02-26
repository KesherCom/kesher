export const tokenStorageKey = "intercom-token";
export const sessionSettingsStorageKey = "intercom-session-settings";
export const globalSettingsStorageKey = "intercom-global-settings";
export const favoritesStorageKey = "intercom-favorites";
export const defaultAdminPin = "123456";

export type SessionSettings = {
  username: string;
  roleId: string;
  listenRoomIds: string[];
  talkRoomIds: string[];
};

export type GlobalSettings = {
  selectedInputDeviceId: string;
  selectedOutputDeviceId: string;
  enableDirectPpt: boolean;
  enableDirectTabs: boolean;
  inputGainByDeviceId: Record<string, number>;
  roomGainById: Record<string, number>;
  directGainByUserId: Record<string, number>;
};

export type FavoriteSettings = {
  pinnedRoomIds: string[];
  pinnedUserIds: string[];
  showPinnedOnly: boolean;
};

export function clampGainValue(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(2, value));
}

function sanitizeGainMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => typeof key === "string" && key.length > 0)
    .map(
      ([key, raw]) =>
        [key, clampGainValue(typeof raw === "number" ? raw : 1)] as const,
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
      inputGainByDeviceId: sanitizeGainMap(parsed.inputGainByDeviceId),
      roomGainById: sanitizeGainMap(parsed.roomGainById),
      directGainByUserId: sanitizeGainMap(parsed.directGainByUserId),
    };
  } catch {
    return {
      selectedInputDeviceId: "",
      selectedOutputDeviceId: "",
      enableDirectPpt: false,
      enableDirectTabs: false,
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
