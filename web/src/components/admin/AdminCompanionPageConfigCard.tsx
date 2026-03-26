import { useEffect, useState } from "react";
import {
  getAdminCompanionRolePages,
  saveAdminCompanionRolePage,
} from "../../api";
import type {
  Bootstrap,
  CompanionRolePagesResponse,
} from "../../types";

type AdminCompanionPageConfigCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

export function AdminCompanionPageConfigCard({
  token,
  adminPin,
  appData,
}: AdminCompanionPageConfigCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rolePages, setRolePages] = useState<Record<string, number>>({});
  const [selectedRoleId, setSelectedRoleId] = useState(
    appData.roles[0]?.id || ""
  );
  const [selectedPageNumber, setSelectedPageNumber] = useState(0);

  async function loadRolePages() {
    setLoading(true);
    setError("");
    try {
      const data = await getAdminCompanionRolePages(token, adminPin);
      setRolePages(data.rolePages || {});
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load role pages"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadRolePages();
    }
  }, [isOpen]);

  async function handleSavePage() {
    if (!selectedRoleId) {
      setError("Please select a role");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await saveAdminCompanionRolePage(
        token,
        adminPin,
        selectedRoleId,
        selectedPageNumber
      );
      setMessage(
        `Saved ${selectedRoleId} → Streamdeck Page ${selectedPageNumber}`
      );
      await loadRolePages();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save role page"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div
        className="card-header"
        style={{ cursor: "pointer" }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <h3 style={{ margin: 0 }}>
          Companion Page Configuration {isOpen ? "▼" : "▶"}
        </h3>
      </div>
      {isOpen && (
        <div className="card-content">
          {error && <div className="error-message">{error}</div>}
          {message && <div className="success-message">{message}</div>}

          <div className="form-group">
            <label>Select Role:</label>
            <select
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
              disabled={saving}
            >
              {appData.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} ({role.id})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Streamdeck Page (0-14):</label>
            <input
              type="number"
              min="0"
              max="14"
              value={selectedPageNumber}
              onChange={(e) => setSelectedPageNumber(Math.min(14, Math.max(0, parseInt(e.target.value) || 0)))}
              disabled={saving}
            />
          </div>

          <button
            onClick={handleSavePage}
            disabled={saving || !selectedRoleId}
            className="button"
          >
            {saving ? "Saving..." : "Save Page Mapping"}
          </button>

          <div style={{ marginTop: "1.5rem" }}>
            <h4>Current Mappings:</h4>
            {loading ? (
              <p>Loading...</p>
            ) : Object.keys(rolePages).length === 0 ? (
              <p>No role page mappings configured yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ccc" }}>Role ID</th>
                    <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ccc" }}>Page Number</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(rolePages).map(([roleId, pageNum]) => (
                    <tr key={roleId}>
                      <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>{roleId}</td>
                      <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>{pageNum}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
