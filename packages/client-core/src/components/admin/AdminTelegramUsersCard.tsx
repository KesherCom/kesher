import { useEffect, useState } from "react";
import {
  createTelegramAllowlistEntry,
  deleteTelegramAllowlistEntry,
  getTelegramAllowlist,
} from "../../api";
import type { TelegramAllowlistEntry } from "../../types";
import { useAdminAction } from "./useAdminAction";

type AdminTelegramUsersCardProps = {
  token: string;
  adminPin: string;
};

export function AdminTelegramUsersCard({
  token,
  adminPin,
}: AdminTelegramUsersCardProps) {
  const containsWhitespace = (value: string) => /\s/.test(value);
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<TelegramAllowlistEntry[]>([]);
  const {
    busy,
    error,
    run: runAction,
  } = useAdminAction({
    onSuccess: loadAllowlist,
    defaultErrorMessage: "operation failed",
  });

  const [createTelegramUsername, setCreateTelegramUsername] = useState("");
  const [createKesherUsername, setCreateKesherUsername] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createValidationError, setCreateValidationError] = useState("");

  async function loadAllowlist() {
    try {
      const data = await getTelegramAllowlist(token, adminPin);
      setEntries(data);
    } catch (err) {
      console.error("Failed to load telegram allowlist:", err);
    }
  }

  useEffect(() => {
    if (isOpen) {
      void loadAllowlist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function resetCreateForm() {
    setCreateTelegramUsername("");
    setCreateKesherUsername("");
    setCreateValidationError("");
  }

  function handleCreate() {
    const telegramUsername = createTelegramUsername.trim();
    const kesherUsername = createKesherUsername.trim();
    if (!telegramUsername || !kesherUsername) return;
    if (containsWhitespace(telegramUsername) || containsWhitespace(kesherUsername)) {
      setCreateValidationError("Usernames must not contain spaces.");
      return;
    }
    setCreateValidationError("");
    void runAction(async () => {
      await createTelegramAllowlistEntry(token, adminPin, {
        telegramUsername,
        kesherUsername,
      });
      resetCreateForm();
      setShowCreateForm(false);
    });
  }

  function handleDelete(id: string) {
    void runAction(async () => {
      await deleteTelegramAllowlistEntry(token, adminPin, id);
    });
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Telegram User Allowlist</div>
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
          <div className="admin-block">
            <p>
              <strong>Access Control:</strong> Only Telegram users on this
              allowlist can interact with the bot. When a user sends their
              first message, their Telegram numeric ID is bound to their
              username (Trust On First Use).
            </p>
          </div>
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Allowed Users</h4>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (showCreateForm) resetCreateForm();
                  setShowCreateForm((prev) => !prev);
                }}
                disabled={busy}
              >
                {showCreateForm ? "Cancel" : "Add user"}
              </button>
            </div>
            {error ? <p className="admin-error">{error}</p> : null}
            {showCreateForm ? (
              <div className="admin-edit-panel">
                <div className="admin-edit-title">Add new allowed user</div>
                <div className="admin-grid">
                  <input
                    value={createTelegramUsername}
                    onChange={(e) => {
                      setCreateTelegramUsername(stripWhitespace(e.target.value));
                      setCreateValidationError("");
                    }}
                    placeholder="Telegram @username"
                  />
                  <input
                    value={createKesherUsername}
                    onChange={(e) => {
                      setCreateKesherUsername(stripWhitespace(e.target.value));
                      setCreateValidationError("");
                    }}
                    placeholder="Kesher username (e.g., Sarah)"
                  />
                </div>
                {createValidationError ? (
                  <p className="admin-error">{createValidationError}</p>
                ) : null}
                <div className="admin-form-actions">
                  <button
                    onClick={handleCreate}
                    disabled={
                      busy ||
                      !createTelegramUsername.trim() ||
                      !createKesherUsername.trim() ||
                      containsWhitespace(createTelegramUsername.trim()) ||
                      containsWhitespace(createKesherUsername.trim())
                    }
                  >
                    Add user
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetCreateForm();
                      setShowCreateForm(false);
                    }}
                    disabled={busy}
                    className="secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            <ul className="admin-list">
              {entries.length === 0 ? (
                <li>
                  <span className="admin-empty">
                    No users configured. Add users to allow access.
                  </span>
                </li>
              ) : (
                entries.map((entry) => (
                  <li key={entry.id}>
                    <span>
                      <strong>@{entry.telegramUsername}</strong> → {entry.kesherUsername}
                      {" "}
                      <small>
                        ({entry.status})
                        {entry.isBound && entry.telegramNumericId ? (
                          <> • ID: {entry.telegramNumericId}</>
                        ) : null}
                      </small>
                    </span>
                    <button onClick={() => handleDelete(entry.id)} disabled={busy}>
                      Revoke
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
