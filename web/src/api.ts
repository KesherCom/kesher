import type { Bootstrap, PublicBootstrap, User } from "./types";

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizePublicBootstrap(data: unknown): PublicBootstrap {
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

async function apiMutation(
  url: string,
  token: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
  payload: {
    id: string;
    name: string;
    defaultRoomId?: string;
    defaultVoiceMode?: string;
    defaultSimpleView?: boolean;
  },
): Promise<void> {
  await apiMutation("/api/admin/roles", token, "POST", payload);
}
export async function updateRole(
  token: string,
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
    payload,
  );
}

export async function deleteRole(token: string, roleId: string): Promise<void> {
  await apiMutation(
    `/api/admin/roles/${encodeURIComponent(roleId)}`,
    token,
    "DELETE",
  );
}

export async function createRoom(
  token: string,
  payload: {
    id: string;
    name: string;
    senderRoleIds?: string[];
    receiverRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation("/api/admin/rooms", token, "POST", payload);
}
export async function updateRoom(
  token: string,
  roomId: string,
  payload: {
    name: string;
    senderRoleIds?: string[];
    receiverRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation(
    `/api/admin/rooms/${encodeURIComponent(roomId)}`,
    token,
    "PUT",
    payload,
  );
}

export async function deleteRoom(token: string, roomId: string): Promise<void> {
  await apiMutation(
    `/api/admin/rooms/${encodeURIComponent(roomId)}`,
    token,
    "DELETE",
  );
}

export async function createBroadcastGroup(
  token: string,
  payload: {
    id: string;
    name: string;
    roomIds: string[];
    allowedRoleIds?: string[];
  },
): Promise<void> {
  await apiMutation("/api/admin/broadcast-groups", token, "POST", payload);
}

export async function updateBroadcastGroup(
  token: string,
  groupId: string,
  payload: { name: string; roomIds: string[]; allowedRoleIds?: string[] },
): Promise<void> {
  await apiMutation(
    `/api/admin/broadcast-groups/${encodeURIComponent(groupId)}`,
    token,
    "PUT",
    payload,
  );
}

export async function deleteBroadcastGroup(
  token: string,
  groupId: string,
): Promise<void> {
  await apiMutation(
    `/api/admin/broadcast-groups/${encodeURIComponent(groupId)}`,
    token,
    "DELETE",
  );
}
