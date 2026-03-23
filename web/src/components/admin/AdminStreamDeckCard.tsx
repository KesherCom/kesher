import { useEffect, useMemo, useState } from "react";
import {
  getAdminRoleStreamDeckSettings,
  normalizeStreamDeckSettings,
  resetAdminRoleStreamDeckSettings,
  updateAdminRoleStreamDeckSettings,
} from "../../api";
import type { Bootstrap } from "../../types";

type AdminStreamDeckCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

function formatSettings(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function AdminStreamDeckCard({
  token,
  adminPin,
  appData,
}: AdminStreamDeckCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState(
    () => appData.roles[0]?.id || appData.self.roleId || "",
  );
  const [editorValue, setEditorValue] = useState("");

  useEffect(() => {
    if (!selectedRoleId && appData.roles.length > 0) {
      setSelectedRoleId(appData.roles[0]?.id || "");
    }
  }, [appData.roles, selectedRoleId]);

  const selectedRoleName = useMemo(() => {
    return appData.roles.find((role) => role.id === selectedRoleId)?.name || selectedRoleId;
  }, [appData.roles, selectedRoleId]);

  async function loadRoleSettings() {
    if (!selectedRoleId) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const settings = await getAdminRoleStreamDeckSettings(
        token,
        adminPin,
        selectedRoleId,
      );
      setEditorValue(formatSettings(settings));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load Stream Deck settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isOpen || !selectedRoleId) return;
    void loadRoleSettings();
  }, [isOpen, selectedRoleId]);

  async function handleSave() {
    if (!selectedRoleId) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const parsed = JSON.parse(editorValue) as unknown;
      const normalized = normalizeStreamDeckSettings(parsed);
      const saved = await updateAdminRoleStreamDeckSettings(
        token,
        adminPin,
        selectedRoleId,
        normalized,
      );
      setEditorValue(formatSettings(saved));
      setMessage(`Saved Stream Deck layout for ${selectedRoleName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save Stream Deck settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!selectedRoleId) return;
    setResetting(true);
    setError("");
    setMessage("");
    try {
      const reset = await resetAdminRoleStreamDeckSettings(
        token,
        adminPin,
        selectedRoleId,
      );
      setEditorValue(formatSettings(reset));
      setMessage(`Reset Stream Deck layout for ${selectedRoleName} to defaults.`);
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
            Kesher is the source of truth. Edit the role layout here, then publish the
            Companion profile for the same role.
          </p>
          <div className="admin-grid">
            <label>
              <span>Role</span>
              <select
                value={selectedRoleId}
                onChange={(event) => setSelectedRoleId(event.target.value)}
                disabled={loading || saving || resetting}
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
          <label style={{ display: "grid", gap: "0.45rem", marginTop: "0.9rem" }}>
            <span>Role Stream Deck JSON</span>
            <textarea
              value={editorValue}
              onChange={(event) => setEditorValue(event.target.value)}
              rows={24}
              spellCheck={false}
              disabled={!selectedRoleId || loading || saving || resetting}
              style={{ width: "100%", minHeight: "24rem", fontFamily: "monospace" }}
            />
          </label>
          <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
            <button
              type="button"
              onClick={() => void loadRoleSettings()}
              disabled={!selectedRoleId || loading || saving || resetting}
            >
              {loading ? "Loading…" : "Reload"}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!selectedRoleId || loading || saving || resetting}
            >
              {saving ? "Saving…" : "Save role layout"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void handleReset()}
              disabled={!selectedRoleId || loading || saving || resetting}
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
