import { useMemo, useState } from "react";
import { resetAdminRoleStreamDeckSettings } from "../../api";
import type { Bootstrap } from "../../types";

type AdminStreamDeckCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

export function AdminStreamDeckCard({
  token,
  adminPin,
  appData,
}: AdminStreamDeckCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState(
    () => appData.roles[0]?.id || appData.self.roleId || "",
  );

  const selectedRoleName = useMemo(() => {
    return appData.roles.find((role) => role.id === selectedRoleId)?.name || selectedRoleId;
  }, [appData.roles, selectedRoleId]);

  async function handleReset() {
    if (!selectedRoleId) return;
    setResetting(true);
    setError("");
    setMessage("");
    try {
      await resetAdminRoleStreamDeckSettings(token, adminPin, selectedRoleId);
      setMessage(`Stream Deck layout for ${selectedRoleName} reset to defaults.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to reset Stream Deck settings");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Stream Deck Profiles</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((value) => !value)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <p>
            Each operator configures their own Stream Deck layout via the user settings
            panel. Use this to reset a role's layout back to defaults if needed.
          </p>
          <div className="admin-grid">
            <label>
              <span>Role</span>
              <select
                value={selectedRoleId}
                onChange={(event) => setSelectedRoleId(event.target.value)}
                disabled={resetting}
              >
                <option value="">Select role…</option>
                {appData.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
            <button
              type="button"
              className="secondary"
              onClick={() => void handleReset()}
              disabled={!selectedRoleId || resetting}
            >
              {resetting ? "Resetting…" : "Reset to defaults"}
            </button>
          </div>
          {error ? <p className="admin-error">{error}</p> : null}
          {message ? <p>{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
