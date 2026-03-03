import type { Bootstrap } from "../../types";

type UsersPanelProps = {
  appData: Bootstrap;
};

export function UsersPanel({ appData }: UsersPanelProps) {
  return (
    <div className="admin-block">
      <div className="admin-block-header">
        <h4>Users</h4>
      </div>
      <div className="admin-grid">
        <p>
          Manage users and assigned roles. User management endpoints are not
          implemented yet.
        </p>
      </div>
      <ul className="admin-list">
        {appData.users
          .filter(
            (u) => u.username.toLowerCase() !== "admin" && u.id !== "admin",
          )
          .map((u) => (
            <li key={u.id}>
              <span>
                {u.username} <small>({u.id})</small>
              </span>
              <select value={u.roleId} disabled>
                {appData.roles.map((r) => (
                  <option key={`usr-role-${r.id}-${u.id}`} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button disabled className="secondary">
                Assign
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
