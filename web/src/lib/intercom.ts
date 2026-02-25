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
  if (!roleIDs || roleIDs.length === 0) return true;
  return roleIDs.includes(currentRoleId);
}

export function toggleRoomSelectionState(
  prev: string[],
  roomId: string,
): string[] {
  if (prev.includes(roomId)) {
    if (prev.length === 1) return prev;
    return prev.filter((id) => id !== roomId);
  }
  return [...prev, roomId];
}
