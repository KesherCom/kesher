import type { PublicBootstrap } from "../types";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
};

export function LoginView({
  publicData,
  username,
  roleId,
  onUsernameChange,
  onRoleChange,
  onLogin
}: LoginViewProps) {
  return (
    <div className="root login">
      <h1>Live Production Intercom</h1>
      <p className="variant-subtitle">Station Deck</p>
      <label>
        Display name
        <input value={username} onChange={(e) => onUsernameChange(e.target.value)} placeholder="e.g. Tim FOH" />
      </label>
      <label>
        Role
        <select value={roleId} onChange={(e) => onRoleChange(e.target.value)}>
          <option value="">Select role</option>
          {publicData.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <button onClick={onLogin} disabled={!username.trim() || !roleId}>
        Join Intercom
      </button>
    </div>
  );
}

