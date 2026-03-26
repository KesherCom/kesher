import { useCallback, useEffect, useState } from "react";
import { deleteUser, fetchAdminUsers } from "../../api";
import type { Bootstrap, UserWithOnlineStatus } from "../../types";
import { useAdminAction } from "./useAdminAction";

type UsersPanelProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function UsersPanel({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: UsersPanelProps) {
  const [users, setUsers] = useState<UserWithOnlineStatus[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const { busy: adminBusy, error: adminError, run: runAdminAction } = useAdminAction({
    onSuccess: refreshBootstrapData,
  });

  const roleNameById = new Map(appData.roles.map((r) => [r.id, r.name]));

  const loadUsers = useCallback(async () => {
    setLoadError("");
    try {
      const data = await fetchAdminUsers(token, adminPin);
      setUsers(
        data.filter(
          (u) => u.username.toLowerCase() !== "admin" && u.id !== "admin",
        ),
      );
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load users",
      );
    }
  }, [token, adminPin]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  function handleDelete(user: UserWithOnlineStatus) {
    void runAdminAction(async () => {
      await deleteUser(token, adminPin, user.id);
      await loadUsers();
    });
  }

  return (
    <div className="admin-block">
      <div className="admin-block-header">
        <h4>Users ({users?.length ?? "…"})</h4>
      </div>
      {loadError ? <p className="admin-error">{loadError}</p> : null}
      {adminError ? <p className="admin-error">{adminError}</p> : null}
      {users === null && !loadError ? (
        <p>Loading…</p>
      ) : (
        <ul className="admin-list">
          {users?.map((u) => (
            <li key={u.id}>
              <span
                title={u.online ? "Online" : "Offline"}
                style={{ color: u.online ? "var(--color-active, #4caf50)" : "var(--color-muted, #888)" }}
              >
                {u.online ? "●" : "○"}
              </span>
              <span>
                {u.username}{" "}
                <small>({roleNameById.get(u.roleId) ?? u.roleId})</small>
              </span>
              <button
                className="secondary danger"
                disabled={u.online || adminBusy}
                title={u.online ? "Cannot delete an active user" : `Delete ${u.username}`}
                onClick={() => handleDelete(u)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
