import { useEffect, useState } from "react";
import { clearChatHistory, updateAckSettings } from "../../api";
import type { Bootstrap } from "../../types";

type AdminChatHistoryCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminChatHistoryCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminChatHistoryCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAck, setBusyAck] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ackEnabled, setAckEnabled] = useState(appData.ackEnabled);

  useEffect(() => {
    setAckEnabled(appData.ackEnabled);
  }, [appData.ackEnabled]);

  async function handleClear() {
    const confirmed = window.confirm(
      "Chat-Verlauf wirklich fuer alle verbundenen Clients leeren?",
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    setError("");
    try {
      await clearChatHistory(token, adminPin);
      setMessage("Chat-Verlauf wurde geleert.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to clear history");
    } finally {
      setBusy(false);
    }
  }

  async function handleAckToggle(nextValue: boolean) {
    setBusyAck(true);
    setMessage("");
    setError("");
    try {
      const updated = await updateAckSettings(token, adminPin, nextValue);
      setAckEnabled(updated.enabled);
      setMessage(
        updated.enabled
          ? "ACK-Nachrichten sind jetzt aktiviert."
          : "ACK-Nachrichten sind jetzt deaktiviert.",
      );
      // Do not call refreshBootstrapData() here because it triggers an unnecessary room matrix resync
      // which causes the last chat message to be re-broadcasted. The config_updated WebSocket
      // message will update the ackEnabled state throughout the application.
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update ack settings");
    } finally {
      setBusyAck(false);
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Chat · Maintenance</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block admin-chat-block">
            <div className="admin-block-header">
              <h4>ACK cues</h4>
              <span className={ackEnabled ? "admin-status-ok" : "admin-status-warn"}>
                {ackEnabled ? "Aktiv" : "Inaktiv"}
              </span>
            </div>

            <p>
              Aktiviert oder deaktiviert ACK-Cue-Nachrichten global fuer alle
              Clients.
            </p>

            <label className="admin-chat-toggle-row">
              <input
                type="checkbox"
                checked={ackEnabled}
                disabled={busyAck}
                onChange={(e) => {
                  void handleAckToggle(e.target.checked);
                }}
              />
              <span>
                <strong>ACK-Nachrichten aktivieren</strong>
                <small>Bei Aktivierung koennen ACK-Cues im Chat genutzt werden.</small>
              </span>
            </label>
          </div>

          <div className="admin-block admin-chat-block">
            <div className="admin-block-header">
              <h4>Verlauf bereinigen</h4>
            </div>
            <p>
              Leert den fluechtigen Chat-Verlauf fuer alle Party-Lines und
              Direktnachrichten, z. B. vor Show-Beginn.
            </p>
            <div className="admin-form-actions admin-chat-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void handleClear();
                }}
                disabled={busy}
              >
                {busy ? "Loesche..." : "Clear for new Show"}
              </button>
            </div>
          </div>

          {message ? (
            <p className="admin-chat-message admin-chat-message-success">
              {message}
            </p>
          ) : null}

          {error ? <p className="admin-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
