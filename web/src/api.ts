import type { Bootstrap, PublicBootstrap, User } from "./types";

export async function getPublicBootstrap(): Promise<PublicBootstrap> {
  const res = await fetch("/api/public-bootstrap");
  if (!res.ok) throw new Error("failed to load public bootstrap");
  return res.json();
}

export async function login(username: string, roleId: string): Promise<{ token: string; user: User }> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, roleId })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function bootstrap(token: string): Promise<Bootstrap> {
  const res = await fetch("/api/bootstrap", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("failed to load bootstrap");
  return res.json();
}

export async function logout(token: string): Promise<void> {
  await fetch("/api/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function apiMutation(url: string, token: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
}

export async function createRole(
  token: string,
  payload: { id: string; name: string; defaultRoomId?: string; defaultVoiceMode?: string }
): Promise<void> {
  await apiMutation("/api/admin/roles", token, "POST", payload);
}
export async function updateRole(
  token: string,
  roleId: string,
  payload: { name: string; defaultRoomId?: string; defaultVoiceMode?: string }
): Promise<void> {
  await apiMutation(`/api/admin/roles/${encodeURIComponent(roleId)}`, token, "PUT", payload);
}

export async function deleteRole(token: string, roleId: string): Promise<void> {
  await apiMutation(`/api/admin/roles/${encodeURIComponent(roleId)}`, token, "DELETE");
}

export async function createRoom(token: string, payload: { id: string; name: string }): Promise<void> {
  await apiMutation("/api/admin/rooms", token, "POST", payload);
}

export async function updateRoom(token: string, roomId: string, payload: { name: string }): Promise<void> {
  await apiMutation(`/api/admin/rooms/${encodeURIComponent(roomId)}`, token, "PUT", payload);
}

export async function deleteRoom(token: string, roomId: string): Promise<void> {
  await apiMutation(`/api/admin/rooms/${encodeURIComponent(roomId)}`, token, "DELETE");
}

export async function createBroadcastGroup(
  token: string,
  payload: { id: string; name: string; roomIds: string[] }
): Promise<void> {
  await apiMutation("/api/admin/broadcast-groups", token, "POST", payload);
}

export async function updateBroadcastGroup(
  token: string,
  groupId: string,
  payload: { name: string; roomIds: string[] }
): Promise<void> {
  await apiMutation(`/api/admin/broadcast-groups/${encodeURIComponent(groupId)}`, token, "PUT", payload);
}

export async function deleteBroadcastGroup(token: string, groupId: string): Promise<void> {
  await apiMutation(`/api/admin/broadcast-groups/${encodeURIComponent(groupId)}`, token, "DELETE");
}

