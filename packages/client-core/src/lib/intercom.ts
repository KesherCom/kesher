import type { Role, Room } from "../types";

export function matrixAnchorRoomId(
  listenIds: string[],
  talkIds: string[],
): string {
  return talkIds[0] || listenIds[0] || "";
}

export function resolveChatTargetRoomId(
  listenIds: string[],
  talkIds: string[],
  rooms: Room[],
  role: Role | undefined,
  currentRoleId: string,
): string {
  const anchorRoomId = matrixAnchorRoomId(listenIds, talkIds);
  if (anchorRoomId) {
    return anchorRoomId;
  }

  const canUseRoom = (room: Room | undefined) =>
    !!room &&
    (roleAllowed(room.senderRoleIds, currentRoleId) ||
      roleAllowed(room.receiverRoleIds, currentRoleId));

  const defaultRoom = rooms.find((room) => room.id === role?.defaultRoomId);
  if (defaultRoom && canUseRoom(defaultRoom)) {
    return defaultRoom.id;
  }

  const firstAllowedTalkRoom = rooms.find((room) =>
    roleAllowed(room.senderRoleIds, currentRoleId),
  );
  if (firstAllowedTalkRoom) {
    return firstAllowedTalkRoom.id;
  }

  const firstAllowedListenRoom = rooms.find((room) =>
    roleAllowed(room.receiverRoleIds, currentRoleId),
  );
  return firstAllowedListenRoom?.id || "";
}

export function roleAllowed(
  roleIDs: string[] | undefined,
  currentRoleId: string,
): boolean {
  if (!roleIDs || roleIDs.length === 0) return false;
  return roleIDs.includes(currentRoleId);
}

export function toggleRoomSelectionState(
  prev: string[],
  roomId: string,
): string[] {
  if (prev.includes(roomId)) {
    return prev.filter((id) => id !== roomId);
  }
  return [...prev, roomId];
}

/** Ensure forced-listen rooms for the given role are included in a listen-room set. */
export function mergeForcedListenRooms(
  prev: string[],
  rooms: { id: string; forcedListenRoleIds?: string[] }[],
  roleId: string,
): string[] {
  const forced = rooms
    .filter((r) => (r.forcedListenRoleIds ?? []).includes(roleId))
    .map((r) => r.id);
  if (forced.length === 0) return prev;
  const existing = new Set(prev);
  const merged = [...prev];
  for (const id of forced) {
    if (!existing.has(id)) merged.push(id);
  }
  return merged;
}
