export function matrixAnchorRoomId(
  listenIds: string[],
  talkIds: string[],
): string {
  return talkIds[0] || listenIds[0] || "";
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
