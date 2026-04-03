import { useCallback, useEffect, useState } from "react";
import {
  deleteUser,
  fetchAdminUsers,
  getAdminBirthdayUsersToday,
  updateAdminBirthdayUsersToday,
} from "../../api";
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
  const [birthdayUsersInput, setBirthdayUsersInput] = useState("");
  const [birthdayError, setBirthdayError] = useState("");
  const [birthdayMessage, setBirthdayMessage] = useState("");
  const [birthdayBusy, setBirthdayBusy] = useState(false);
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

  const loadBirthdayUsers = useCallback(async () => {
    setBirthdayError("");
    try {
      const data = await getAdminBirthdayUsersToday(token, adminPin);
      setBirthdayUsersInput((data.usernames ?? []).join(", "));
    } catch (err) {
      setBirthdayError(
        err instanceof Error ? err.message : "Failed to load birthday users",
      );
    }
  }, [adminPin, token]);

  useEffect(() => {
    void loadBirthdayUsers();
  }, [loadBirthdayUsers]);

  function parseBirthdayUsers(raw: string): string[] {
    return raw
      .split(/[\n,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function handleDelete(user: UserWithOnlineStatus) {
    void runAdminAction(async () => {
      await deleteUser(token, adminPin, user.id);
      await loadUsers();
    });
  }

  function handleSaveBirthdayUsers() {
    setBirthdayError("");
    setBirthdayMessage("");
    setBirthdayBusy(true);
    void updateAdminBirthdayUsersToday(
      token,
      adminPin,
      parseBirthdayUsers(birthdayUsersInput),
    )
      .then((saved) => {
        setBirthdayUsersInput((saved.usernames ?? []).join(", "));
        setBirthdayMessage("Birthday list saved.");
      })
      .catch((err: unknown) => {
        setBirthdayError(
          err instanceof Error ? err.message : "Failed to save birthday users",
        );
      })
      .finally(() => {
        setBirthdayBusy(false);
      });
  }

  return (
    <>
      <div className="admin-block">
        <div className="admin-block-header">
          <h4>Birthday Users (Today)</h4>
        </div>
        <p className="admin-block-subtitle">
          Enter usernames separated by commas or new lines. Matching is case-insensitive.
        </p>
        <label className="admin-pin-field" htmlFor="birthday-users-today">
          <span>Usernames</span>
          <textarea
            id="birthday-users-today"
            rows={3}
            value={birthdayUsersInput}
            onChange={(event) => setBirthdayUsersInput(event.target.value)}
            placeholder="max, anna, chris"
            disabled={birthdayBusy}
          />
        </label>
        <div className="admin-form-actions">
          <button type="button" onClick={handleSaveBirthdayUsers} disabled={birthdayBusy}>
            {birthdayBusy ? "Saving..." : "Save birthday list"}
          </button>
        </div>
        {birthdayMessage ? <p>{birthdayMessage}</p> : null}
        {birthdayError ? <p className="admin-error">{birthdayError}</p> : null}
      </div>
      <div className="admin-block">
        <div className="admin-block-header">
          <h4>Users ({users?.length ?? "..."})</h4>
        </div>
        {loadError ? <p className="admin-error">{loadError}</p> : null}
        {adminError ? <p className="admin-error">{adminError}</p> : null}
        {users === null && !loadError ? (
          <p>Loading...</p>
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
    </>
  );
}
