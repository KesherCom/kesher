import React from "react";
import type { Bootstrap } from "../../types";
import { AdminPanel } from "./AdminPanel";

type AdminMenuProps = {
  isOpen: boolean;
  setIsOpen: (v: (prev: boolean) => boolean) => void;
  token: string | null;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  adminPin: string;
  onUpdateAdminPin: (next: string) => void;
  audioStats: { inKbps: number; outKbps: number };
  activeRoutesCount: number;
};

export function AdminMenu({
  isOpen,
  setIsOpen,
  token,
  appData,
  refreshBootstrapData,
  adminPin,
  onUpdateAdminPin,
  audioStats,
  activeRoutesCount
}: AdminMenuProps) {
  const [pinCurrentInput, setPinCurrentInput] = React.useState("");
  const [pinNewInput, setPinNewInput] = React.useState("");
  const [pinConfirmInput, setPinConfirmInput] = React.useState("");
  const [pinMessage, setPinMessage] = React.useState("");
  
  if (!token) return null;
  return (
    <div className="admin-stack">
      {isOpen ? (
        <div className="admin-card">
          <div className="admin-card-body">
            <AdminPanel token={token} appData={appData} refreshBootstrapData={refreshBootstrapData} />
          </div>
        </div>
      ) : (
        <div className="admin-card">
          <div className="admin-card-header">
            <div className="admin-card-title">Konfiguration</div>
            <div className="admin-card-actions">
              <button
                className="admin-toggle-button"
                onClick={() => setIsOpen((v) => !v)}
                aria-expanded={isOpen}
              >
                {isOpen ? "Verbergen" : "Anzeigen"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="admin-card">
        <div className="admin-card-header">
          <div className="admin-card-title">Security · Admin PIN</div>
        </div>
        <div className="admin-card-body">
          <div className="admin-grid">
            <input
              type="password"
              value={pinCurrentInput}
              onChange={(e) => setPinCurrentInput(e.target.value)}
              placeholder="Current PIN"
            />
            <input
              type="password"
              value={pinNewInput}
              onChange={(e) => setPinNewInput(e.target.value)}
              placeholder="New PIN"
            />
            <input
              type="password"
              value={pinConfirmInput}
              onChange={(e) => setPinConfirmInput(e.target.value)}
              placeholder="Confirm new PIN"
            />
          </div>
          <div className="admin-form-actions">
            <button
              onClick={() => {
                setPinMessage("");
                if (pinCurrentInput.trim() !== adminPin) {
                  setPinMessage("Current PIN is incorrect.");
                  return;
                }
                if (!pinNewInput.trim()) {
                  setPinMessage("New PIN cannot be empty.");
                  return;
                }
                if (pinNewInput !== pinConfirmInput) {
                  setPinMessage("New PIN and confirmation do not match.");
                  return;
                }
                try {
                  onUpdateAdminPin(pinNewInput.trim());
                  setPinMessage("Admin PIN updated successfully.");
                  setPinCurrentInput("");
                  setPinNewInput("");
                  setPinConfirmInput("");
                } catch (err) {
                  setPinMessage("Failed to update PIN.");
                }
              }}
              className="secondary"
            >
              Update PIN
            </button>
            {pinMessage ? <div className="admin-pin-note">{pinMessage}</div> : null}
          </div>
        </div>
      </div>

      <div className="admin-card">
        <div className="admin-card-header">
          <div className="admin-card-title">Monitoring · Audio / RTP</div>
        </div>
        <div className="admin-card-body admin-metrics">
          <div className="admin-metric">
            <div className="admin-metric-label">Inbound</div>
            <div className="admin-metric-value">{audioStats.inKbps} kbps</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Outbound</div>
            <div className="admin-metric-value">{audioStats.outKbps} kbps</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Active routes</div>
            <div className="admin-metric-value">{activeRoutesCount}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
