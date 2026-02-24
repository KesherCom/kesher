import { useState } from "react";
import type { PublicBootstrap } from "../types";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
  adminPin: string;
  onAdminPinChange: (value: string) => void;
  onAdminLogin: () => void;
  adminError?: string;
};

export function LoginView({
  publicData,
  username,
  roleId,
  onUsernameChange,
  onRoleChange,
  onLogin,
  adminPin,
  onAdminPinChange,
  onAdminLogin,
  adminError
}: LoginViewProps) {
  const [showAdmin, setShowAdmin] = useState(false);
  return (
    <div className="root login">
      <div className="login-card panel">
        <div className="login-card-head">
          <h1>Live Production Intercom</h1>
          <p className="variant-subtitle">Station Deck</p>
        </div>
        <div className="login-form">
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
          <button className="primary" onClick={onLogin} disabled={!username.trim() || !roleId}>
            Join Intercom
          </button>
        </div>

        <div>
          {!showAdmin ? (
            <button className="login-admin-toggle secondary" onClick={() => setShowAdmin(true)}>
              Admin anzeigen
            </button>
          ) : null}

          {showAdmin ? (
            <div className="login-admin-card">
              <div className="login-admin-head">
                <h3>Admin-Konsole</h3>
                <span className="login-admin-pin-hint">PIN erforderlich</span>
              </div>
              <p className="login-admin-note">Nur für Rollen- und Channel-Konfiguration.</p>
              <label>
                Admin-PIN
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => onAdminPinChange(e.target.value)}
                  placeholder="PIN"
                  autoComplete="off"
                />
              </label>
              {adminError ? <p className="login-error">{adminError}</p> : null}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button className="secondary" onClick={onAdminLogin} disabled={!adminPin.trim()}>
                  Admin-Konsole öffnen
                </button>
                <button className="secondary" onClick={() => setShowAdmin(false)}>Verbergen</button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

