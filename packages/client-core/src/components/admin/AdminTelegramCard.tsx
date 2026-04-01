import { useEffect, useState } from "react";
import {
  buildAbsoluteApiUrl,
  createTelegramMapping,
  deleteTelegramMapping,
  getTelegramStatus,
  updateTelegramMapping,
} from "../../api";
import type { Bootstrap } from "../../types";
import type { TelegramMapping } from "../../types";
import { useAdminAction } from "./useAdminAction";

type AdminTelegramCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

export function AdminTelegramCard({
  token,
  adminPin,
  appData,
}: AdminTelegramCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [botConfigured, setBotConfigured] = useState(false);
  const [mode, setMode] = useState<"polling" | "webhook" | "">("");
  const [mappings, setMappings] = useState<TelegramMapping[]>([]);
  const {
    busy,
    error,
    run: runAction,
  } = useAdminAction({
    onSuccess: loadStatus,
    defaultErrorMessage: "operation failed",
  });

  const [createChatId, setCreateChatId] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [createRoomId, setCreateRoomId] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [editChatId, setEditChatId] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editRoomId, setEditRoomId] = useState("");

  async function loadStatus() {
    try {
      const status = await getTelegramStatus(token, adminPin);
      setBotConfigured(status.botConfigured);
      setMode(status.mode);
      setMappings(status.mappings);
    } catch {
      // ignore if not yet configured
    }
  }

  useEffect(() => {
    if (isOpen) {
      void loadStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function resetCreateForm() {
    setCreateChatId("");
    setCreateLabel("");
    setCreateRoomId("");
  }

  function resetEditForm() {
    setEditId(null);
    setEditChatId("");
    setEditLabel("");
    setEditRoomId("");
  }

  function handleCreate() {
    const chatId = createChatId.trim();
    const label = createLabel.trim();
    const roomId = createRoomId.trim();
    if (!chatId || !label || !roomId) return;
    void runAction(async () => {
      await createTelegramMapping(token, adminPin, { chatId, label, roomId });
      resetCreateForm();
      setShowCreateForm(false);
    });
  }

  function handleEdit() {
    if (!editId) return;
    const chatId = editChatId.trim();
    const label = editLabel.trim();
    const roomId = editRoomId.trim();
    if (!chatId || !label || !roomId) return;
    void runAction(async () => {
      await updateTelegramMapping(token, adminPin, editId, {
        chatId,
        label,
        roomId,
      });
      resetEditForm();
    });
  }

  function handleDelete(id: string) {
    void runAction(async () => {
      await deleteTelegramMapping(token, adminPin, id);
      if (editId === id) resetEditForm();
    });
  }

  const webhookUrl = buildAbsoluteApiUrl("/api/telegram/webhook");

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Telegram Bot Integration</div>
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
              <strong>Bot status:</strong>{" "}
              {botConfigured ? (
                <span className="admin-status-ok">✓ Configured</span>
              ) : (
                <span className="admin-status-warn">
                  ✗ Not configured (set TELEGRAM_BOT_TOKEN env var)
                </span>
              )}
            </p>
            {botConfigured ? (
              <>
                <p>
                  <strong>Mode:</strong>{" "}
                  {mode === "polling" ? (
                    <span className="admin-status-ok">
                      Polling (server fetches updates from Telegram)
                    </span>
                  ) : (
                    <span>Webhook</span>
                  )}
                </p>
                {mode === "webhook" ? (
                  <p>
                    <strong>Webhook URL:</strong>{" "}
                    <code className="admin-code">{webhookUrl}</code>
                    <br />
                    <small>
                      Set this URL in BotFather via <code>/setwebhook</code>.
                    </small>
                  </p>
                ) : (
                  <p>
                    <small>
                      The server polls the Telegram API for new messages. No
                      public IP or webhook URL required.
                    </small>
                  </p>
                )}
              </>
            ) : null}
          </div>
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Chat–Room Mappings</h4>
              {!editId ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (showCreateForm) resetCreateForm();
                    setShowCreateForm((prev) => !prev);
                  }}
                  disabled={busy}
                >
                  {showCreateForm ? "Cancel" : "Add mapping"}
                </button>
              ) : null}
            </div>
            {error ? <p className="admin-error">{error}</p> : null}
            {showCreateForm && !editId ? (
              <div className="admin-edit-panel">
                <div className="admin-edit-title">New mapping</div>
                <div className="admin-grid">
                  <input
                    value={createChatId}
                    onChange={(e) => setCreateChatId(e.target.value)}
                    placeholder="Telegram chat ID (e.g. -100123456)"
                  />
                  <input
                    value={createLabel}
                    onChange={(e) => setCreateLabel(e.target.value)}
                    placeholder="Label"
                  />
                  <select
                    value={createRoomId}
                    onChange={(e) => setCreateRoomId(e.target.value)}
                    aria-label="Party line"
                  >
                    <option value="">Select party line…</option>
                    {appData.rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="admin-form-actions">
                  <button
                    onClick={handleCreate}
                    disabled={
                      busy ||
                      !createChatId.trim() ||
                      !createLabel.trim() ||
                      !createRoomId.trim()
                    }
                  >
                    Add mapping
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
            {editId ? (
              <div className="admin-edit-panel">
                <div className="admin-edit-title">Editing mapping</div>
                <div className="admin-grid">
                  <input
                    value={editChatId}
                    onChange={(e) => setEditChatId(e.target.value)}
                    placeholder="Telegram chat ID"
                  />
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder="Label"
                  />
                  <select
                    value={editRoomId}
                    onChange={(e) => setEditRoomId(e.target.value)}
                    aria-label="Party line"
                  >
                    <option value="">Select party line…</option>
                    {appData.rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="admin-form-actions">
                  <button
                    onClick={handleEdit}
                    disabled={
                      busy ||
                      !editChatId.trim() ||
                      !editLabel.trim() ||
                      !editRoomId.trim()
                    }
                  >
                    Save changes
                  </button>
                  <button
                    onClick={resetEditForm}
                    disabled={busy}
                    className="secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            <ul className="admin-list">
              {mappings.length === 0 ? (
                <li>
                  <span className="admin-empty">No mappings configured.</span>
                </li>
              ) : (
                mappings.map((m) => (
                  <li key={m.id}>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setShowCreateForm(false);
                        setEditId(m.id);
                        setEditChatId(m.chatId);
                        setEditLabel(m.label);
                        setEditRoomId(m.roomId);
                      }}
                    >
                      Edit
                    </button>
                    <span>
                      {m.label}{" "}
                      <small>
                        (chat: {m.chatId} → room:{" "}
                        {appData.rooms.find((r) => r.id === m.roomId)?.name ??
                          m.roomId}
                        )
                      </small>
                    </span>
                    <button onClick={() => handleDelete(m.id)} disabled={busy}>
                      Delete
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
