import type { PublicBootstrap } from "../types";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
  onAdminLogin: () => void;
  adminPinInput: string;
  onAdminPinInputChange: (value: string) => void;
  loginError: string;
};

export function LoginView({
  publicData,
  username,
  roleId,
  onUsernameChange,
  onRoleChange,
  onLogin,
  onAdminLogin,
  adminPinInput,
  onAdminPinInputChange,
  loginError
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
      {loginError ? <p className="login-error">{loginError}</p> : null}
      <button onClick={onLogin} disabled={!username.trim() || !roleId}>
        Join Intercom
      </button>

      <div className="login-admin-card panel">
        <div className="login-admin-head">
          <div>
            <p className="variant-subtitle">Admin access</p>
            <h3>Configuration</h3>
          </div>
          <span className="login-admin-pin-hint">PIN required</span>
        </div>
        <label>
          Admin PIN
          <input
            type="password"
            value={adminPinInput}
            onChange={(e) => onAdminPinInputChange(e.target.value)}
            placeholder="Enter admin PIN"
          />
        </label>
        <button onClick={onAdminLogin} disabled={!username.trim() || !roleId || !adminPinInput.trim()}>
          Admin login
        </button>
        <small className="login-admin-note">Only administrators should use this entry point.</small>
      </div>
    </div>
  );
}

