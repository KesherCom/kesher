type SortableDirectUser = {
  roleId: string;
  username: string;
};

export function sortDirectUsersByRoleAndUsername<T extends SortableDirectUser>(
  users: T[],
  roleNameById: Map<string, string>,
): T[] {
  return users.slice().sort((a, b) => {
    const roleA = (roleNameById.get(a.roleId) || a.roleId || "").toLowerCase();
    const roleB = (roleNameById.get(b.roleId) || b.roleId || "").toLowerCase();
    const byRole = roleA.localeCompare(roleB, undefined, {
      sensitivity: "base",
    });
    if (byRole !== 0) return byRole;
    return a.username.localeCompare(b.username, undefined, {
      sensitivity: "base",
    });
  });
}
