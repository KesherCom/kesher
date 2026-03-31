import { useState } from "react";
import type { LoginConflict, PublicBootstrap } from "../types";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
  loginError?: string;
  adminPin: string;
  onAdminPinChange: (value: string) => void;
  onAdminLogin: () => void;
  adminError?: string;
  takeoverConflict: LoginConflict | null;
  onConfirmTakeover: () => void;
  onCancelTakeover: () => void;
};

export function LoginView({
  publicData,
  username,
  roleId,
  onUsernameChange,
  onRoleChange,
  onLogin,
  loginError,
  adminPin,
  onAdminPinChange,
  onAdminLogin,
  adminError,
  takeoverConflict,
  onConfirmTakeover,
  onCancelTakeover,
}: LoginViewProps) {
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  const [showAdmin, setShowAdmin] = useState(false);
  return (
    <div className="root login">
      <div className="login-card panel">
        <div className="login-card-head">
          <h1>kesher - Live Production Intercom</h1>
          <p className="variant-subtitle">Station Deck</p>
        </div>
        <div className="login-form">
          <label>
            <span className="login-label-text">Display name</span>
            <input
              value={username}
              onChange={(e) => onUsernameChange(stripWhitespace(e.target.value))}
              placeholder="e.g. Tim FOH"
            />
          </label>
          <label>
            <span className="login-label-text">Role</span>
            <select
              value={roleId}
              onChange={(e) => onRoleChange(e.target.value)}
            >
              <option value="">Select role</option>
              {publicData.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            onClick={onLogin}
            disabled={!username.trim() || !roleId}
          >
            Join Intercom
          </button>
          {loginError ? <p className="login-error">{loginError}</p> : null}
          {takeoverConflict ? (
            <div className="login-admin-card" role="alert">
              <div className="login-admin-head">
                <h3>Role currently in use</h3>
              </div>
              <p className="login-admin-note">
                {takeoverConflict.conflictRoleName || takeoverConflict.conflictRoleId}
                {" "}
                is currently active
                {takeoverConflict.conflictUsername
                  ? ` by ${takeoverConflict.conflictUsername}`
                  : ""}
                . Confirm takeover to replace the existing session.
              </p>
              <div className="login-admin-actions">
                <button className="primary" onClick={onConfirmTakeover}>
                  Confirm takeover
                </button>
                <button className="secondary" onClick={onCancelTakeover}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div>
          {!showAdmin ? (
            <button
              className="login-admin-toggle secondary"
              onClick={() => setShowAdmin(true)}
            >
              Show admin
            </button>
          ) : null}

          {showAdmin ? (
            <div className="login-admin-card">
              <div className="login-admin-head">
                <h3>Admin console</h3>
                <span className="login-admin-pin-hint">PIN required</span>
              </div>
              <p className="login-admin-note">
                For role and channel configuration only.
              </p>
              <label>
                <span className="login-label-text">Admin PIN</span>
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => onAdminPinChange(e.target.value)}
                  placeholder="PIN"
                  autoComplete="off"
                />
              </label>
              {adminError ? <p className="login-error">{adminError}</p> : null}
              <div className="login-admin-actions">
                <button
                  className="secondary"
                  onClick={onAdminLogin}
                  disabled={!adminPin.trim()}
                >
                  Open admin console
                </button>
                <button
                  className="secondary"
                  onClick={() => setShowAdmin(false)}
                >
                  Hide
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
