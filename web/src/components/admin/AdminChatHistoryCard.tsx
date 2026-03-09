import { useState } from "react";
import { clearChatHistory } from "../../api";

type AdminChatHistoryCardProps = {
  token: string;
  adminPin: string;
};

export function AdminChatHistoryCard({
  token,
  adminPin,
}: AdminChatHistoryCardProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Chat History Reset</div>
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
          <p>
            Leert den fluechtigen Chat-Verlauf fuer alle Party-Lines und
            Direktnachrichten, z. B. vor Show-Beginn.
          </p>
          <div className="admin-form-actions">
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
          {error ? <p className="admin-error">{error}</p> : null}
          {message ? <p>{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
