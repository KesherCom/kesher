import type {
  Bootstrap,
  PublicBootstrap,
  RealtimeStatsResponse,
  StatusResponse,
  TelegramStatus,
  User,
} from "./types";

const adminPinHeaderName = "X-Admin-Pin";

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
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
        roomIds: toStringArray(entry.roomIds),
        allowedRoleIds: toStringArray(entry.allowedRoleIds),
      };
    }),
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

export async function getPublicBootstrap(): Promise<PublicBootstrap> {
  const res = await fetch("/api/public-bootstrap");
  if (!res.ok) throw new Error("failed to load public bootstrap");
  const raw = (await res.json()) as unknown;
  return normalizePublicBootstrap(raw);
}

export async function login(
  username: string,
  roleId: string,
): Promise<{ token: string; user: User }> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, roleId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function bootstrap(token: string): Promise<Bootstrap> {
  const res = await fetch("/api/bootstrap", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("failed to load bootstrap");
  const raw = (await res.json()) as unknown;
  return normalizeBootstrap(raw);
}

export async function logout(token: string): Promise<void> {
  await fetch("/api/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getRealtimeStats(
  token: string,
  adminPin: string,
): Promise<RealtimeStatsResponse> {
  const res = await fetch("/api/realtime-stats", {
    headers: {
      Authorization: `Bearer ${token}`,
      [adminPinHeaderName]: adminPin,
    },
  });
  if (!res.ok) throw new Error("failed to load realtime stats");
  return res.json() as Promise<RealtimeStatsResponse>;
}

export async function getStatus(token: string): Promise<StatusResponse> {
  const res = await fetch("/api/status", {
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
  const res = await fetch(url, {
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

export async function createBroadcastGroup(
  token: string,
  adminPin: string,
  payload: {
    id: string;
    name: string;
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
  payload: { name: string; roomIds: string[]; allowedRoleIds?: string[] },
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

export async function getTelegramStatus(
  token: string,
  adminPin: string,
): Promise<TelegramStatus> {
  const res = await fetch("/api/admin/telegram", {
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

export async function updateAdminPin(
  token: string,
  currentAdminPin: string,
  newPin: string,
): Promise<void> {
  await apiMutation("/api/admin/pin", token, "PUT", currentAdminPin, {
    newPin,
  });
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
