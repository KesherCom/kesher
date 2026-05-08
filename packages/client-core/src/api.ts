import type {
  AdminLogsResponse,
  Bootstrap,
  CompanionAdminSummary,
  CompanionProfileResponse,
  CompanionRolePageConfig,
  CompanionRolePagesResponse,
  ConfigurationDocument,
  ConfigurationImportResponse,
  ConfigurationSection,
  LoginConflict,
  LoginSuccess,
  PublicBootstrap,
  RealtimeStatsResponse,
  StatusResponse,
  StreamDeckActionType,
  StreamDeckSettings,
  TelegramAllowlistEntry,
  TelegramStatus,
  User,
  UserWithOnlineStatus,
} from "./types";
import { toStringArray } from "./lib/normalize";

const adminPinHeaderName = "X-Admin-Pin";

// Global base URL state for runtime configuration (desktop Tauri + web)
let globalApiBaseUrl: string | null = null;

/**
 * Accepts full URLs and plain host/IP input for desktop server configuration.
 */
export function normalizeServerAddressInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Server address must not be empty.");
  }

  let parsed: URL;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      parsed = new URL(trimmed);
    } else {
      parsed = new URL(`http://${trimmed}`);
    }
  } catch {
    throw new Error("Invalid server address.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Server address must use http or https.");
  }

  if (parsed.pathname === "/") {
    parsed.pathname = "";
  }

  return parsed.toString().replace(/\/$/, "");
}

export function setGlobalApiBaseUrl(url: string): void {
  globalApiBaseUrl = url;
}

export function getGlobalApiBaseUrl(): string {
  if (globalApiBaseUrl !== null) {
    return globalApiBaseUrl;
  }
  // Default for web: relative paths (proxied in dev, same-origin in prod)
  return "";
}

function normalizeApiPath(path: string): string {
  if (!path) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Builds an API URL for network requests.
 * - On web: returns a relative path (works with Vite proxy in dev)
 * - On desktop: prefixes path with configured server URL
 */
export function buildApiUrl(path: string): string {
  const normalizedPath = normalizeApiPath(path);
  const base = getGlobalApiBaseUrl();
  if (!base) {
    return normalizedPath;
  }
  
  // Strip any pathname from base URL to ensure we only use protocol://host:port
  try {
    const parsed = new URL(base);
    const cleanBase = `${parsed.protocol}//${parsed.host}`;
    return `${cleanBase}${normalizedPath}`;
  } catch {
    // Fallback if URL parsing fails
    return `${base}${normalizedPath}`;
  }
}

/**
 * Builds an absolute API URL for display/integration output.
 */
export function buildAbsoluteApiUrl(path: string): string {
  const normalizedPath = normalizeApiPath(path);
  const base = getGlobalApiBaseUrl();
  if (base) {
    try {
      const parsed = new URL(base);
      const cleanBase = `${parsed.protocol}//${parsed.host}`;
      return `${cleanBase}${normalizedPath}`;
    } catch {
      return `${base}${normalizedPath}`;
    }
  }
  if (typeof window !== "undefined" && window.location.origin) {
    return `${window.location.origin}${normalizedPath}`;
  }
  return normalizedPath;
}

/**
 * Builds a websocket URL from the currently active API origin.
 */
export function buildWebSocketUrl(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): string {
  const normalizedPath = normalizeApiPath(path);
  const base = getGlobalApiBaseUrl() ||
    (typeof window !== "undefined" ? window.location.origin : "");

  if (!base) {
    throw new Error("Unable to resolve websocket origin.");
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new Error("Invalid base URL for websocket.");
  }
  
  // Strip pathname to ensure clean origin
  const cleanOrigin = `${parsedBase.protocol}//${parsedBase.host}`;
  const wsProtocol = parsedBase.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return `${wsProtocol}//${parsedBase.host}${normalizedPath}${queryString ? `?${queryString}` : ""}`;
}

/**
 * Constructs full API URL with configured base URL prefix.
 * - On web: returns path as-is (proxied in dev, same-origin in prod)
 * - On desktop: prefixes with configured server URL (e.g., http://127.0.0.1:8080)
 */
function apiUrl(path: string): string {
  return buildApiUrl(path);
}

export function normalizePublicBootstrap(data: unknown): PublicBootstrap {
  const raw = (data ?? {}) as Record<string, unknown>;
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const broadcastGroups = Array.isArray(raw.broadcastGroups)
    ? raw.broadcastGroups
    : [];

  return {
    roles: roles.map((role) => {
      const entry = role as Record<string, unknown>;
      return {
        ...entry,
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "",
      };
    }),
    rooms: rooms.map((room) => {
      const entry = room as Record<string, unknown>;
      return {
        ...entry,
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "",
        priorityLevel:
          typeof entry.priorityLevel === "number" &&
          Number.isFinite(entry.priorityLevel)
            ? Math.max(0, Math.min(3, Math.trunc(entry.priorityLevel)))
            : 1,
        senderRoleIds: toStringArray(entry.senderRoleIds),
        receiverRoleIds: toStringArray(entry.receiverRoleIds),
        forcedListenRoleIds: toStringArray(entry.forcedListenRoleIds),
      };
    }),
    broadcastGroups: broadcastGroups.map((group) => {
      const entry = group as Record<string, unknown>;
      return {
        ...entry,
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "",
        priorityLevel:
          typeof entry.priorityLevel === "number" &&
          Number.isFinite(entry.priorityLevel)
            ? Math.max(0, Math.min(3, Math.trunc(entry.priorityLevel)))
            : 1,
        roomIds: toStringArray(entry.roomIds),
        allowedRoleIds: toStringArray(entry.allowedRoleIds),
      };
    }),
    ackEnabled:
      typeof raw.ackEnabled === "boolean" ? raw.ackEnabled : true,
    appVersion: {
      version: typeof (raw.appVersion as any)?.version === "string" ? (raw.appVersion as any).version : "unknown",
      buildTimestamp: typeof (raw.appVersion as any)?.buildTimestamp === "string" ? (raw.appVersion as any).buildTimestamp : "unknown",
    },
  };
}

function normalizeBootstrap(data: unknown): Bootstrap {
  const raw = (data ?? {}) as Record<string, unknown>;
  const normalizedPublic = normalizePublicBootstrap(raw);
  const users = Array.isArray(raw.users) ? raw.users : [];
  const self = (raw.self ?? {}) as Record<string, unknown>;

  return {
    ...normalizedPublic,
    self: {
      ...self,
      id: typeof self.id === "string" ? self.id : "",
      username: typeof self.username === "string" ? self.username : "",
      roleId: typeof self.roleId === "string" ? self.roleId : "",
    } as User,
    users: users.map((user) => {
      const entry = user as Record<string, unknown>;
      return {
        ...entry,
        id: typeof entry.id === "string" ? entry.id : "",
        username: typeof entry.username === "string" ? entry.username : "",
        roleId: typeof entry.roleId === "string" ? entry.roleId : "",
      };
    }) as User[],
  };
}

function normalizeConfigurationDocument(data: unknown): ConfigurationDocument {
  const raw = (data ?? {}) as Record<string, unknown>;
  const normalizedPublic = normalizePublicBootstrap(raw);
  const users = Array.isArray(raw.users) ? raw.users : [];
  const telegramAllowlist = Array.isArray(raw.telegramAllowlist)
    ? raw.telegramAllowlist
    : [];
  const streamDeckSettings = Array.isArray(raw.streamDeckSettings)
    ? raw.streamDeckSettings
    : [];
  const meta = (raw.meta ?? {}) as Record<string, unknown>;
  const ackSettings = (raw.ackSettings ?? null) as Record<string, unknown> | null;

  return {
    meta: {
      format: typeof meta.format === "string" ? meta.format : "",
      schemaVersion:
        typeof meta.schemaVersion === "number" ? meta.schemaVersion : 0,
      exportedAt: typeof meta.exportedAt === "string" ? meta.exportedAt : "",
      sourceVersion: {
        version:
          typeof (meta.sourceVersion as any)?.version === "string"
            ? (meta.sourceVersion as any).version
            : "unknown",
        buildTimestamp:
          typeof (meta.sourceVersion as any)?.buildTimestamp === "string"
            ? (meta.sourceVersion as any).buildTimestamp
            : "unknown",
      },
      sections: toStringArray(meta.sections) as ConfigurationSection[],
    },
    roles: normalizedPublic.roles,
    users: users.map((user) => {
      const entry = user as Record<string, unknown>;
      return {
        username: typeof entry.username === "string" ? entry.username : "",
        roleId: typeof entry.roleId === "string" ? entry.roleId : "",
      };
    }),
    rooms: normalizedPublic.rooms,
    broadcastGroups: normalizedPublic.broadcastGroups,
    telegramAllowlist: telegramAllowlist.map((allowlistEntry) => {
      const entry = allowlistEntry as Record<string, unknown>;
      return {
        id: typeof entry.id === "string" ? entry.id : "",
        telegramUsername:
          typeof entry.telegramUsername === "string"
            ? entry.telegramUsername
            : "",
        telegramNumericId:
          typeof entry.telegramNumericId === "string"
            ? entry.telegramNumericId
            : "",
        kesherUsername:
          typeof entry.kesherUsername === "string" ? entry.kesherUsername : "",
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
        status: typeof entry.status === "string" ? entry.status : "",
        isBound: typeof entry.isBound === "boolean" ? entry.isBound : false,
      };
    }),
    ackSettings:
      ackSettings && typeof ackSettings.enabled === "boolean"
        ? { enabled: ackSettings.enabled }
        : null,
    streamDeckSettings: streamDeckSettings.map((assignment) => {
      const entry = assignment as Record<string, unknown>;
      return {
        username: typeof entry.username === "string" ? entry.username : "",
        settings: normalizeStreamDeckSettings(entry.settings),
      };
    }),
  };
}

function defaultStreamDeckSettings(): StreamDeckSettings {
  const buttons = Array.from({ length: 15 }, (_, index) => ({ index }));
  return {
    version: 1,
    gridColumns: 5,
    gridRows: 3,
    selectedPage: 0,
    pages: [{ page: 0, buttons }],
  };
}

export function normalizeStreamDeckSettings(data: unknown): StreamDeckSettings {
  const allowedActionTypes: StreamDeckActionType[] = [
    "none",
    "ptt_room",
    "select_talk_room",
    "select_listen_room",
    "ptt_selected",
    "listen_room",
    "call_room",
    "direct_user",
    "direct_role",
    "reply_to_caller",
    "incoming_call_indicator",
    "broadcast_ptt",
    "mute_toggle",
    "volume_delta",
    "page_up",
    "page_down",
    "page_jump",
    "page_home",
    "page_back",
  ];
  const raw = (data ?? {}) as Record<string, unknown>;
  const version =
    typeof raw.version === "number" && Number.isFinite(raw.version)
      ? raw.version
      : 1;
  const gridColumns =
    typeof raw.gridColumns === "number" && Number.isFinite(raw.gridColumns)
      ? raw.gridColumns
      : 5;
  const gridRows =
    typeof raw.gridRows === "number" && Number.isFinite(raw.gridRows)
      ? raw.gridRows
      : 3;
  const selectedPage =
    typeof raw.selectedPage === "number" && Number.isFinite(raw.selectedPage)
      ? raw.selectedPage
      : 0;
  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : [];
  const pages = pagesRaw
    .map((page) => {
      const pageEntry = page as Record<string, unknown>;
      const pageNo =
        typeof pageEntry.page === "number" && Number.isFinite(pageEntry.page)
          ? pageEntry.page
          : -1;
      const buttonsRaw = Array.isArray(pageEntry.buttons)
        ? pageEntry.buttons
        : [];
      const buttons = buttonsRaw
        .map((button) => {
          const buttonEntry = button as Record<string, unknown>;
          const index =
            typeof buttonEntry.index === "number" &&
            Number.isFinite(buttonEntry.index)
              ? buttonEntry.index
              : -1;
          const actionRaw = (buttonEntry.action ?? null) as
            | Record<string, unknown>
            | null;
          const typeCandidate =
            typeof actionRaw?.type === "string" ? actionRaw.type : "none";
          const type: StreamDeckActionType = allowedActionTypes.includes(
            typeCandidate as StreamDeckActionType,
          )
            ? (typeCandidate as StreamDeckActionType)
            : "none";
          const action = actionRaw
            ? {
                type,
                roomId:
                  typeof actionRaw.roomId === "string" ? actionRaw.roomId : undefined,
                userId:
                  typeof actionRaw.userId === "string" ? actionRaw.userId : undefined,
                roleId:
                  typeof actionRaw.roleId === "string" ? actionRaw.roleId : undefined,
                broadcastGroupId:
                  typeof actionRaw.broadcastGroupId === "string"
                    ? actionRaw.broadcastGroupId
                    : undefined,
                volumeDelta:
                  typeof actionRaw.volumeDelta === "number"
                    ? actionRaw.volumeDelta
                    : undefined,
                targetPage:
                  typeof actionRaw.targetPage === "number"
                    ? actionRaw.targetPage
                    : undefined,
              }
            : undefined;
          return {
            index,
            label:
              typeof buttonEntry.label === "string" ? buttonEntry.label : undefined,
            color:
              typeof buttonEntry.color === "string" ? buttonEntry.color : undefined,
            action,
          };
        })
        .filter((button) => button.index >= 0);
      return { page: pageNo, buttons };

    })
    .filter((page) => page.page >= 0);

  if (gridColumns !== 5 || gridRows !== 3 || pages.length === 0) {
    return defaultStreamDeckSettings();
  }
  return {
    version,
    gridColumns,
    gridRows,
    selectedPage,
    pages: pages.map((pageRaw, index) => {
      const pageEntry = pagesRaw[index] as Record<string, unknown>;
      const pageTypeCandidate =
        typeof pageEntry.pageType === "string" ? pageEntry.pageType : "manual";
      const pageType =
        pageTypeCandidate === "all_roles" || pageTypeCandidate === "all_party_lines"
          ? pageTypeCandidate
          : "manual";
      const parentPage =
        typeof pageEntry.parentPage === "number" && Number.isFinite(pageEntry.parentPage)
          ? pageEntry.parentPage
          : undefined;
      return {
        ...pageRaw,
        title: typeof pageEntry.title === "string" ? pageEntry.title : undefined,
        pageType,
        parentPage,
      };
    }),
  };
}

export async function getPublicBootstrap(): Promise<PublicBootstrap> {
  const res = await fetch(apiUrl("/api/public-bootstrap"));
  if (!res.ok) throw new Error("failed to load public bootstrap");
  const raw = (await res.json()) as unknown;
  return normalizePublicBootstrap(raw);
}

export async function login(
  username: string,
  roleId: string,
): Promise<LoginSuccess | LoginConflict> {
  const res = await fetch(apiUrl("/api/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, roleId }),
  });
  if (res.status === 409) {
    return (await res.json()) as LoginConflict;
  }
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as LoginSuccess;
}

export async function loginTakeover(
  username: string,
  roleId: string,
): Promise<LoginSuccess> {
  const res = await fetch(apiUrl("/api/login/takeover"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, roleId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as LoginSuccess;
}

export async function adminLogin(pin: string): Promise<LoginSuccess> {
  const res = await fetch(apiUrl("/api/admin/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as LoginSuccess;
}

export async function bootstrap(token: string): Promise<Bootstrap> {
  const res = await fetch(apiUrl("/api/bootstrap"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("failed to load bootstrap");
  const raw = (await res.json()) as unknown;
  return normalizeBootstrap(raw);
}

export async function logout(token: string): Promise<void> {
  await fetch(apiUrl("/api/logout"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getRealtimeStats(
  token: string,
  adminPin: string,
): Promise<RealtimeStatsResponse> {
  const res = await fetch(apiUrl("/api/realtime-stats"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error("failed to load realtime stats");
  return res.json() as Promise<RealtimeStatsResponse>;
}

export async function getStatus(token: string): Promise<StatusResponse> {
  const res = await fetch(apiUrl("/api/status"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("failed to load status");
  return res.json() as Promise<StatusResponse>;
}

async function apiMutation(
  url: string,
  token: string,
  method: "POST" | "PUT" | "DELETE",
  adminPin: string,
  body?: unknown,
): Promise<void> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
}

export async function createRole(
  token: string,
  adminPin: string,
  payload: {
    id: string;
    name: string;
    defaultRoomId?: string;
    defaultVoiceMode?: string;
    defaultSimpleView?: boolean;
  },
): Promise<void> {
  await apiMutation("/api/admin/roles", token, "POST", adminPin, payload);
}
export async function updateRole(
  token: string,
  adminPin: string,
  roleId: string,
  payload: {
    name: string;
    defaultRoomId?: string;
    defaultVoiceMode?: string;
    defaultSimpleView?: boolean;
  },
): Promise<void> {
  await apiMutation(
    `/api/admin/roles/${encodeURIComponent(roleId)}`,
    token,
    "PUT",
    adminPin,
    payload,
  );
}

export async function deleteRole(
  token: string,
  adminPin: string,
  roleId: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/roles/${encodeURIComponent(roleId)}`,
    token,
    "DELETE",
    adminPin,
  );
}

export async function createRoom(
  token: string,
  adminPin: string,
  payload: {
    id: string;
    name: string;
    priorityLevel?: number;
    senderRoleIds?: string[];
    receiverRoleIds?: string[];
    forcedListenRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation("/api/admin/rooms", token, "POST", adminPin, payload);
}
export async function updateRoom(
  token: string,
  adminPin: string,
  roomId: string,
  payload: {
    name: string;
    priorityLevel?: number;
    senderRoleIds?: string[];
    receiverRoleIds?: string[];
    forcedListenRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation(
    `/api/admin/rooms/${encodeURIComponent(roomId)}`,
    token,
    "PUT",
    adminPin,
    payload,
  );
}

export async function deleteRoom(
  token: string,
  adminPin: string,
  roomId: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/rooms/${encodeURIComponent(roomId)}`,
    token,
    "DELETE",
    adminPin,
  );
}

// new terminology aliases (party-line) kept for compatibility with UI docs
// and future external integrations. These simply call the existing room
// helpers so that the underlying API paths remain unchanged.
export const createPartyLine = createRoom;
export const updatePartyLine = updateRoom;
export const deletePartyLine = deleteRoom;

export async function createBroadcastGroup(
  token: string,
  adminPin: string,
  payload: {
    id: string;
    name: string;
    priorityLevel?: number;
    roomIds: string[];
    allowedRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation(
    "/api/admin/broadcast-groups",
    token,
    "POST",
    adminPin,
    payload,
  );
}

export async function updateBroadcastGroup(
  token: string,
  adminPin: string,
  groupId: string,
  payload: {
    name: string;
    priorityLevel?: number;
    roomIds: string[];
    allowedRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation(
    `/api/admin/broadcast-groups/${encodeURIComponent(groupId)}`,
    token,
    "PUT",
    adminPin,
    payload,
  );
}

export async function deleteBroadcastGroup(
  token: string,
  adminPin: string,
  groupId: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/broadcast-groups/${encodeURIComponent(groupId)}`,
    token,
    "DELETE",
    adminPin,
  );
}

export async function exportConfiguration(
  token: string,
  adminPin: string,
): Promise<ConfigurationDocument> {
  const res = await fetch(apiUrl("/api/admin/configuration-export"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeConfigurationDocument(raw);
}

export async function importConfiguration(
  token: string,
  adminPin: string,
  document: ConfigurationDocument,
  sections: ConfigurationSection[],
): Promise<ConfigurationImportResponse> {
  const res = await fetch(apiUrl("/api/admin/configuration-import"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ document, sections }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ConfigurationImportResponse>;
}

export async function getCompanionAdminSummary(
  token: string,
  adminPin: string,
): Promise<CompanionAdminSummary> {
  const res = await fetch(apiUrl("/api/admin/companion/config"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CompanionAdminSummary>;
}

export async function publishCompanionProfile(
  token: string,
  adminPin: string,
  roleId?: string,
): Promise<CompanionProfileResponse> {
  const res = await fetch(apiUrl("/api/admin/companion/publish"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roleId: roleId?.trim() || undefined }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CompanionProfileResponse>;
}

export async function publishUserCompanionProfile(
  token: string,
): Promise<CompanionProfileResponse> {
  const res = await fetch(apiUrl("/api/user/companion/publish"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CompanionProfileResponse>;
}

export async function getAdminCompanionRolePages(
  token: string,
  adminPin: string,
): Promise<CompanionRolePagesResponse> {
  const res = await fetch(apiUrl("/api/admin/companion/role-pages"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CompanionRolePagesResponse>;
}

export async function saveAdminCompanionRolePage(
  token: string,
  adminPin: string,
  roleId: string,
  pageNumber: number,
): Promise<CompanionRolePageConfig> {
  const res = await fetch(apiUrl("/api/admin/companion/role-pages"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roleId, pageNumber }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CompanionRolePageConfig>;
}

export async function getTelegramStatus(
  token: string,
  adminPin: string,
): Promise<TelegramStatus> {
  const res = await fetch(apiUrl("/api/admin/telegram"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error("failed to load telegram status");
  return res.json() as Promise<TelegramStatus>;
}

export async function createTelegramMapping(
  token: string,
  adminPin: string,
  payload: { chatId: string; label: string; roomId: string },
): Promise<void> {
  await apiMutation("/api/admin/telegram", token, "POST", adminPin, payload);
}

export async function updateTelegramMapping(
  token: string,
  adminPin: string,
  id: string,
  payload: { chatId: string; label: string; roomId: string },
): Promise<void> {
  await apiMutation(
    `/api/admin/telegram/${encodeURIComponent(id)}`,
    token,
    "PUT",
    adminPin,
    payload,
  );
}

export async function deleteTelegramMapping(
  token: string,
  adminPin: string,
  id: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/telegram/${encodeURIComponent(id)}`,
    token,
    "DELETE",
    adminPin,
  );
}

export async function getTelegramAllowlist(
  token: string,
  adminPin: string,
): Promise<TelegramAllowlistEntry[]> {
  const res = await fetch(apiUrl("/api/admin/telegram-users"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error("failed to load telegram allowlist");
  return res.json() as Promise<TelegramAllowlistEntry[]>;
}

export async function createTelegramAllowlistEntry(
  token: string,
  adminPin: string,
  payload: { telegramUsername: string; kesherUsername: string },
): Promise<void> {
  await apiMutation(
    "/api/admin/telegram-users",
    token,
    "POST",
    adminPin,
    payload,
  );
}

export async function deleteTelegramAllowlistEntry(
  token: string,
  adminPin: string,
  id: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/telegram-users/${encodeURIComponent(id)}`,
    token,
    "DELETE",
    adminPin,
  );
}

export async function updateAdminPin(
  token: string,
  currentAdminPin: string,
  newPin: string,
): Promise<void> {
  await apiMutation("/api/admin/pin", token, "PUT", currentAdminPin, {
    newPin,
  });
}

type AdminLogQuery = {
  level?: string;
  category?: string;
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
};

function buildAdminLogQueryString(query: AdminLogQuery = {}): string {
  const params = new URLSearchParams();
  if (query.level) params.set("level", query.level);
  if (query.category) params.set("category", query.category);
  if (query.q) params.set("q", query.q);
  if (typeof query.from === "number") params.set("from", String(query.from));
  if (typeof query.to === "number") params.set("to", String(query.to));
  if (typeof query.limit === "number") params.set("limit", String(query.limit));
  if (typeof query.offset === "number") params.set("offset", String(query.offset));
  const built = params.toString();
  return built ? `?${built}` : "";
}

export async function getAdminLogs(
  token: string,
  adminPin: string,
  query: AdminLogQuery = {},
): Promise<AdminLogsResponse> {
  const res = await fetch(apiUrl(`/api/admin/logs${buildAdminLogQueryString(query)}`), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AdminLogsResponse>;
}

export async function exportAdminLogsText(
  token: string,
  adminPin: string,
  query: AdminLogQuery = {},
): Promise<string> {
  const res = await fetch(
    apiUrl(`/api/admin/logs/export${buildAdminLogQueryString(query)}`),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        [adminPinHeaderName]: adminPin,
      },
    },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

export type RoutingMatrixEntry = {
  roomId: string;
  senderRoleIds: string[];
  receiverRoleIds: string[];
  forcedListenRoleIds: string[];
};

export async function updateRoutingMatrix(
  token: string,
  adminPin: string,
  entries: RoutingMatrixEntry[],
): Promise<void> {
  await apiMutation(
    "/api/admin/routing-matrix",
    token,
    "PUT",
    adminPin,
    entries,
  );
}

export async function clearChatHistory(
  token: string,
  adminPin: string,
): Promise<void> {
  await apiMutation(
    "/api/admin/chat-history/clear",
    token,
    "POST",
    adminPin,
  );
}

export async function updateAckSettings(
  token: string,
  adminPin: string,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  const res = await fetch(apiUrl("/api/admin/ack-settings"), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<{ enabled: boolean }>;
}

export async function getStreamDeckSettings(
  token: string,
): Promise<StreamDeckSettings> {
  const res = await fetch(apiUrl("/api/user/stream-deck/settings"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeStreamDeckSettings(raw);
}

export async function updateStreamDeckSettings(
  token: string,
  settings: StreamDeckSettings,
): Promise<StreamDeckSettings> {
  const res = await fetch(apiUrl("/api/user/stream-deck/settings"), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeStreamDeckSettings(raw);
}

export async function resetStreamDeckSettings(
  token: string,
): Promise<StreamDeckSettings> {
  const res = await fetch(apiUrl("/api/user/stream-deck/settings"), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeStreamDeckSettings(raw);
}

export type StreamDeckPreviewButton = {
  buttonIndex: number;
  label?: string;
  subtitle?: string;
  actionType?: StreamDeckActionType;
  color?: string;
  state?: "IDLE" | "TALK" | "LISTEN" | "BROADCAST";
  channel?: string;
  isListening?: boolean;
  isPttSelected?: boolean;
  isActive?: boolean;
};

export async function renderStreamDeckPreviewImages(
  token: string,
  payload: {
    width?: number;
    height?: number;
    buttons: StreamDeckPreviewButton[];
  },
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  if (!payload.buttons.length) {
    return new Map();
  }

  const res = await fetch(apiUrl("/api/user/stream-deck/preview"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as {
    images?: Array<{ buttonIndex: number; imageBuffer: string }>;
  };
  const images = Array.isArray(raw.images) ? raw.images : [];
  const byIndex = new Map<number, string>();
  for (const entry of images) {
    if (typeof entry?.buttonIndex !== "number") continue;
    if (typeof entry?.imageBuffer !== "string" || !entry.imageBuffer) continue;
    byIndex.set(entry.buttonIndex, `data:image/png;base64,${entry.imageBuffer}`);
  }
  return byIndex;
}

export async function getAdminRoleStreamDeckSettings(
  token: string,
  adminPin: string,
  roleId: string,
): Promise<StreamDeckSettings> {
  const res = await fetch(
    apiUrl(`/api/admin/stream-deck/settings?roleId=${encodeURIComponent(roleId)}`),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        [adminPinHeaderName]: adminPin,
      },
    },
  );
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeStreamDeckSettings(raw);
}

export async function updateAdminRoleStreamDeckSettings(
  token: string,
  adminPin: string,
  roleId: string,
  settings: StreamDeckSettings,
): Promise<StreamDeckSettings> {
  const res = await fetch(
    apiUrl(`/api/admin/stream-deck/settings?roleId=${encodeURIComponent(roleId)}`),
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        [adminPinHeaderName]: adminPin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ settings }),
    },
  );
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeStreamDeckSettings(raw);
}

export async function resetAdminRoleStreamDeckSettings(
  token: string,
  adminPin: string,
  roleId: string,
): Promise<StreamDeckSettings> {
  const res = await fetch(
    apiUrl(`/api/admin/stream-deck/settings?roleId=${encodeURIComponent(roleId)}`),
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        [adminPinHeaderName]: adminPin,
      },
    },
  );
  if (!res.ok) throw new Error(await res.text());
  const raw = (await res.json()) as unknown;
  return normalizeStreamDeckSettings(raw);
}

export async function fetchAdminUsers(
  token: string,
  adminPin: string,
): Promise<UserWithOnlineStatus[]> {
  const res = await fetch(apiUrl("/api/admin/users"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<UserWithOnlineStatus[]>;
}

export async function deleteUser(
  token: string,
  adminPin: string,
  userId: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    token,
    "DELETE",
    adminPin,
  );
}

export async function getAdminBirthdayUsersToday(
  token: string,
  adminPin: string,
): Promise<{ usernames: string[] }> {
  const res = await fetch(apiUrl("/api/admin/birthday-users"), {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ usernames: string[] }>;
}

export async function updateAdminBirthdayUsersToday(
  token: string,
  adminPin: string,
  usernames: string[],
): Promise<{ usernames: string[] }> {
  const res = await fetch(apiUrl("/api/admin/birthday-users"), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ usernames }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ usernames: string[] }>;
}
