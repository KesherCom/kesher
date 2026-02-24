import { useEffect, useState } from "react";
import {
  createBroadcastGroup,
  createRole,
  createRoom,
  deleteBroadcastGroup,
  deleteRole,
  deleteRoom,
  updateBroadcastGroup,
  updateRole,
  updateRoom
} from "../../api";
import { UsersPanel } from "./UsersPanel";
import type { Bootstrap } from "../../types";
import { RoleMultiSelect } from "./RoleMultiSelect";
import { RoomMultiSelect } from "./RoomMultiSelect";

type AdminPanelProps = {
  token: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  adminPin: string;
  onUpdateAdminPin: (nextPin: string) => void;
};

export function AdminPanel({ token, appData, refreshBootstrapData, adminPin, onUpdateAdminPin }: AdminPanelProps) {
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [pinCurrentInput, setPinCurrentInput] = useState("");
  const [pinNewInput, setPinNewInput] = useState("");
  const [pinConfirmInput, setPinConfirmInput] = useState("");
  const [pinMessage, setPinMessage] = useState("");

  const [roleCreateId, setRoleCreateId] = useState("");
  const [roleCreateName, setRoleCreateName] = useState("");
  const [roleCreateDefaultRoomId, setRoleCreateDefaultRoomId] = useState("");
  const [roleCreateDefaultVoiceMode, setRoleCreateDefaultVoiceMode] = useState<"always_on" | "ptt" | "">("");
  const [roleCreateDefaultSimpleView, setRoleCreateDefaultSimpleView] = useState(false);
  const [showRoleCreateForm, setShowRoleCreateForm] = useState(false);
  const [roleEditId, setRoleEditId] = useState<string | null>(null);
  const [roleEditName, setRoleEditName] = useState("");
  const [roleEditDefaultRoomId, setRoleEditDefaultRoomId] = useState("");
  const [roleEditDefaultVoiceMode, setRoleEditDefaultVoiceMode] = useState<"always_on" | "ptt" | "">("");
  const [roleEditDefaultSimpleView, setRoleEditDefaultSimpleView] = useState(false);
  const [roomCreateId, setRoomCreateId] = useState("");
  const [roomCreateName, setRoomCreateName] = useState("");
  const [roomCreateSenderRoleIds, setRoomCreateSenderRoleIds] = useState<string[]>([]);
  const [roomCreateReceiverRoleIds, setRoomCreateReceiverRoleIds] = useState<string[]>([]);
  const [showRoomCreateForm, setShowRoomCreateForm] = useState(false);
  const [roomEditId, setRoomEditId] = useState<string | null>(null);
  const [roomEditName, setRoomEditName] = useState("");
  const [roomEditSenderRoleIds, setRoomEditSenderRoleIds] = useState<string[]>([]);
  const [roomEditReceiverRoleIds, setRoomEditReceiverRoleIds] = useState<string[]>([]);
  const [groupCreateId, setGroupCreateId] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateRoomIds, setGroupCreateRoomIds] = useState<string[]>([]);
  const [groupCreateAllowedRoleIds, setGroupCreateAllowedRoleIds] = useState<string[]>([]);
  const [showGroupCreateForm, setShowGroupCreateForm] = useState(false);
  const [groupEditId, setGroupEditId] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditRoomIds, setGroupEditRoomIds] = useState<string[]>([]);
  const [groupEditAllowedRoleIds, setGroupEditAllowedRoleIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"users" | "roles" | "rooms" | "channels">("roles");

  useEffect(() => {
    if (roleCreateDefaultRoomId === "" && appData.rooms[0]) {
      setRoleCreateDefaultRoomId(appData.rooms[0].id);
    }
  }, [appData, roleCreateDefaultRoomId]);

  async function runAdminAction(action: () => Promise<void>) {
    setAdminBusy(true);
    setAdminError("");
    try {
      await action();
      await refreshBootstrapData();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "admin operation failed");
    } finally {
      setAdminBusy(false);
    }
  }

  function resetRoleCreateForm() {
    setRoleCreateId("");
    setRoleCreateName("");
    setRoleCreateDefaultRoomId("");
    setRoleCreateDefaultVoiceMode("");
    setRoleCreateDefaultSimpleView(false);
  }

  function resetRoomCreateForm() {
    setRoomCreateId("");
    setRoomCreateName("");
    setRoomCreateSenderRoleIds([]);
    setRoomCreateReceiverRoleIds([]);
  }
  function resetGroupCreateForm() {
    setGroupCreateId("");
    setGroupCreateName("");
    setGroupCreateRoomIds([]);
    setGroupCreateAllowedRoleIds([]);
  }

  function resetRoleEditForm() {
    setRoleEditId(null);
    setRoleEditName("");
    setRoleEditDefaultRoomId("");
    setRoleEditDefaultVoiceMode("");
    setRoleEditDefaultSimpleView(false);
  }

  function resetRoomEditForm() {
    setRoomEditId(null);
    setRoomEditName("");
    setRoomEditSenderRoleIds([]);
    setRoomEditReceiverRoleIds([]);
  }

  function resetGroupEditForm() {
    setGroupEditId(null);
    setGroupEditName("");
    setGroupEditRoomIds([]);
    setGroupEditAllowedRoleIds([]);
  }

  function createRoleConfig() {
    const id = roleCreateId.trim();
    const name = roleCreateName.trim();
    if (!id || !name) return;
    void runAdminAction(async () => {
      await createRole(token, {
        id,
        name,
        defaultRoomId: roleCreateDefaultRoomId.trim() || undefined,
        defaultVoiceMode: roleCreateDefaultVoiceMode || undefined,
        defaultSimpleView: roleCreateDefaultSimpleView
      });
      resetRoleCreateForm();
      setShowRoleCreateForm(false);
    });
  }

  function saveRoleEdit() {
    if (!roleEditId) return;
    const name = roleEditName.trim();
    if (!name) return;
    void runAdminAction(async () => {
      await updateRole(token, roleEditId, {
        name,
        defaultRoomId: roleEditDefaultRoomId.trim() || undefined,
        defaultVoiceMode: roleEditDefaultVoiceMode || undefined,
        defaultSimpleView: roleEditDefaultSimpleView
      });
      resetRoleEditForm();
    });
  }

  function removeRoleConfig(id: string) {
    void runAdminAction(async () => {
      await deleteRole(token, id);
      if (roleEditId === id) {
        resetRoleEditForm();
      }
    });
  }

  function createRoomConfig() {
    const id = roomCreateId.trim();
    const name = roomCreateName.trim();
    if (!id || !name) return;
    void runAdminAction(async () => {
      await createRoom(token, {
        id,
        name,
        senderRoleIds: roomCreateSenderRoleIds,
        receiverRoleIds: roomCreateReceiverRoleIds
      });
      resetRoomCreateForm();
      setShowRoomCreateForm(false);
    });
  }

  function saveRoomEdit() {
    if (!roomEditId) return;
    const name = roomEditName.trim();
    if (!name) return;
    void runAdminAction(async () => {
      await updateRoom(token, roomEditId, {
        name,
        senderRoleIds: roomEditSenderRoleIds,
        receiverRoleIds: roomEditReceiverRoleIds
      });
      resetRoomEditForm();
    });
  }

  function removeRoomConfig(id: string) {
    void runAdminAction(async () => {
      await deleteRoom(token, id);
      if (roomEditId === id) {
        resetRoomEditForm();
      }
    });
  }

  function createBroadcastGroupConfig() {
    const id = groupCreateId.trim();
    const name = groupCreateName.trim();
    if (!id || !name || groupCreateRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await createBroadcastGroup(token, {
        id,
        name,
        roomIds: groupCreateRoomIds,
        allowedRoleIds: groupCreateAllowedRoleIds
      });
      resetGroupCreateForm();
      setShowGroupCreateForm(false);
    });
  }

  function saveGroupEdit() {
    if (!groupEditId) return;
    const name = groupEditName.trim();
    if (!name || groupEditRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await updateBroadcastGroup(token, groupEditId, {
        name,
        roomIds: groupEditRoomIds,
        allowedRoleIds: groupEditAllowedRoleIds
      });
      resetGroupEditForm();
    });
  }

  function removeBroadcastGroupConfig(id: string) {
    void runAdminAction(async () => {
      await deleteBroadcastGroup(token, id);
      if (groupEditId === id) {
        resetGroupEditForm();
      }
    });
  }

  return (
    <div className="admin-panel">
      <h3>Admin · configuration</h3>
      {adminError ? <p className="admin-error">{adminError}</p> : null}

      <div className="admin-block">
        <div className="admin-block-header">
          <h4>Admin PIN</h4>
        </div>
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
              setAdminError("");
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
            disabled={adminBusy}
          >
            Update PIN
          </button>
          {pinMessage ? <div className="admin-pin-note">{pinMessage}</div> : null}
        </div>
      </div>

      <div className="admin-tabs">
        <nav className="admin-tabs-nav">
          <button
            type="button"
            className={`admin-tab-button ${activeTab === "roles" ? "active" : ""}`}
            onClick={() => setActiveTab("roles")}
            aria-pressed={activeTab === "roles"}
          >
            Roles <span className="admin-tab-badge">{appData.roles.length}</span>
          </button>
          <button
            type="button"
            className={`admin-tab-button ${activeTab === "users" ? "active" : ""}`}
            onClick={() => setActiveTab("users")}
            aria-pressed={activeTab === "users"}
          >
            Users <span className="admin-tab-badge">{appData.users.length}</span>
          </button>
          <button
            type="button"
            className={`admin-tab-button ${activeTab === "rooms" ? "active" : ""}`}
            onClick={() => setActiveTab("rooms")}
            aria-pressed={activeTab === "rooms"}
          >
            Rooms <span className="admin-tab-badge">{appData.rooms.length}</span>
          </button>
          <button
            type="button"
            className={`admin-tab-button ${activeTab === "channels" ? "active" : ""}`}
            onClick={() => setActiveTab("channels")}
            aria-pressed={activeTab === "channels"}
          >
            Channels <span className="admin-tab-badge">{appData.broadcastGroups.length}</span>
          </button>
        </nav>
      </div>

      {activeTab === "users" && (
        <UsersPanel token={token} appData={appData} refreshBootstrapData={refreshBootstrapData} adminBusy={adminBusy} />
      )}

      {activeTab === "roles" && (
        <div className="admin-block">
        <div className="admin-block-header">
          <h4>Roles</h4>
          {!roleEditId ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (showRoleCreateForm) {
                  resetRoleCreateForm();
                }
                setShowRoleCreateForm((prev) => !prev);
              }}
              disabled={adminBusy}
            >
              {showRoleCreateForm ? "Cancel create" : "Create role"}
            </button>
          ) : null}
        </div>
        {showRoleCreateForm && !roleEditId ? (
          <div className="admin-edit-panel">
            <div className="admin-edit-title">New role</div>
            <div className="admin-grid">
              <input value={roleCreateId} onChange={(e) => setRoleCreateId(e.target.value)} placeholder="role-id" />
              <input value={roleCreateName} onChange={(e) => setRoleCreateName(e.target.value)} placeholder="Role name" />
              <select
                value={roleCreateDefaultRoomId}
                onChange={(e) => setRoleCreateDefaultRoomId(e.target.value)}
                aria-label="Default room"
              >
                <option value="">Default room…</option>
                {appData.rooms.map((room) => (
                  <option key={`role-room-${room.id}`} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
              <select
                value={roleCreateDefaultVoiceMode}
                onChange={(e) => setRoleCreateDefaultVoiceMode(e.target.value as "always_on" | "ptt" | "")}
                aria-label="Default audio mode"
              >
                <option value="">Default audio mode…</option>
                <option value="always_on">Always on</option>
                <option value="ptt">PTT</option>
              </select>
              <label className="admin-checkbox admin-checkbox-wide">
                <input
                  type="checkbox"
                  checked={roleCreateDefaultSimpleView}
                  onChange={(e) => setRoleCreateDefaultSimpleView(e.target.checked)}
                />
                <span>Default to simple mobile view</span>
              </label>
            </div>
            <div className="admin-form-actions">
              <button onClick={createRoleConfig} disabled={adminBusy || !roleCreateId.trim() || !roleCreateName.trim()}>
                Create role
              </button>
              <button
                type="button"
                onClick={() => {
                  resetRoleCreateForm();
                  setShowRoleCreateForm(false);
                }}
                disabled={adminBusy}
                className="secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {roleEditId ? (
          <div className="admin-edit-panel">
            <div className="admin-edit-title">Editing role: {roleEditId}</div>
            <div className="admin-grid">
              <input value={roleEditName} onChange={(e) => setRoleEditName(e.target.value)} placeholder="Role name" />
              <select
                value={roleEditDefaultRoomId}
                onChange={(e) => setRoleEditDefaultRoomId(e.target.value)}
                aria-label="Default room"
              >
                <option value="">Default room…</option>
                {appData.rooms.map((room) => (
                  <option key={`role-edit-room-${room.id}`} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
              <select
                value={roleEditDefaultVoiceMode}
                onChange={(e) => setRoleEditDefaultVoiceMode(e.target.value as "always_on" | "ptt" | "")}
                aria-label="Default audio mode"
              >
                <option value="">Default audio mode…</option>
                <option value="always_on">Always on</option>
                <option value="ptt">PTT</option>
              </select>
              <label className="admin-checkbox admin-checkbox-wide">
                <input
                  type="checkbox"
                  checked={roleEditDefaultSimpleView}
                  onChange={(e) => setRoleEditDefaultSimpleView(e.target.checked)}
                />
                <span>Default to simple mobile view</span>
              </label>
            </div>
            <div className="admin-form-actions">
              <button onClick={saveRoleEdit} disabled={adminBusy || !roleEditName.trim()}>
                Save changes
              </button>
              <button onClick={resetRoleEditForm} disabled={adminBusy} className="secondary">
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <ul className="admin-list">
          {appData.roles.map((role) => (
            <li key={role.id}>
              <button
                disabled={adminBusy}
                onClick={() => {
                  setShowRoleCreateForm(false);
                  setRoleEditId(role.id);
                  setRoleEditName(role.name);
                  setRoleEditDefaultRoomId(role.defaultRoomId || "");
                  setRoleEditDefaultVoiceMode((role.defaultVoiceMode as "always_on" | "ptt") || "");
                  setRoleEditDefaultSimpleView(!!role.defaultSimpleView);
                }}
              >
                Edit
              </button>
              <span>
                {role.name} <small>({role.id})</small>
              </span>
              <button onClick={() => removeRoleConfig(role.id)} disabled={adminBusy}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
      )}
      {activeTab === "rooms" && (
        <div className="admin-block">
        <div className="admin-block-header">
          <h4>Rooms</h4>
          {!roomEditId ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (showRoomCreateForm) {
                  resetRoomCreateForm();
                }
                setShowRoomCreateForm((prev) => !prev);
              }}
              disabled={adminBusy}
            >
              {showRoomCreateForm ? "Cancel create" : "Create room"}
            </button>
          ) : null}
        </div>
        {showRoomCreateForm && !roomEditId ? (
          <div className="admin-edit-panel">
            <div className="admin-edit-title">New room</div>
            <div className="admin-grid">
              <input value={roomCreateId} onChange={(e) => setRoomCreateId(e.target.value)} placeholder="room-id" />
              <input value={roomCreateName} onChange={(e) => setRoomCreateName(e.target.value)} placeholder="Room name" />
              <button onClick={createRoomConfig} disabled={adminBusy || !roomCreateId.trim() || !roomCreateName.trim()}>
                Create room
              </button>
              <button
                type="button"
                onClick={() => {
                  resetRoomCreateForm();
                  setShowRoomCreateForm(false);
                }}
                disabled={adminBusy}
                className="secondary"
              >
                Cancel
              </button>
            </div>
            <div className="admin-grid admin-grid-roles">
              <RoleMultiSelect
                label="Allowed senders"
                selectedRoleIds={roomCreateSenderRoleIds}
                setState={setRoomCreateSenderRoleIds}
                keyPrefix="room-create-sender"
                roles={appData.roles}
              />
              <RoleMultiSelect
                label="Allowed receivers"
                selectedRoleIds={roomCreateReceiverRoleIds}
                setState={setRoomCreateReceiverRoleIds}
                keyPrefix="room-create-receiver"
                roles={appData.roles}
              />
            </div>
          </div>
        ) : null}
        {roomEditId ? (
          <div className="admin-edit-panel">
            <div className="admin-edit-title">Editing room: {roomEditId}</div>
            <div className="admin-grid">
              <input value={roomEditName} onChange={(e) => setRoomEditName(e.target.value)} placeholder="Room name" />
              <button onClick={saveRoomEdit} disabled={adminBusy || !roomEditName.trim()}>
                Save changes
              </button>
              <button onClick={resetRoomEditForm} disabled={adminBusy} className="secondary">
                Cancel
              </button>
            </div>
            <div className="admin-grid admin-grid-roles">
              <RoleMultiSelect
                label="Allowed senders"
                selectedRoleIds={roomEditSenderRoleIds}
                setState={setRoomEditSenderRoleIds}
                keyPrefix="room-edit-sender"
                roles={appData.roles}
              />
              <RoleMultiSelect
                label="Allowed receivers"
                selectedRoleIds={roomEditReceiverRoleIds}
                setState={setRoomEditReceiverRoleIds}
                keyPrefix="room-edit-receiver"
                roles={appData.roles}
              />
            </div>
          </div>
        ) : null}
        <ul className="admin-list">
          {appData.rooms.map((room) => (
            <li key={room.id}>
              <button
                disabled={adminBusy}
                onClick={() => {
                  setShowRoomCreateForm(false);
                  setRoomEditId(room.id);
                  setRoomEditName(room.name);
                  setRoomEditSenderRoleIds(room.senderRoleIds || []);
                  setRoomEditReceiverRoleIds(room.receiverRoleIds || []);
                }}
              >
                Edit
              </button>
              <span>
                {room.name} <small>({room.id})</small>
              </span>
              <button onClick={() => removeRoomConfig(room.id)} disabled={adminBusy}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
      )}
      {activeTab === "channels" && (
        <div className="admin-block">
        <div className="admin-block-header">
          <h4>Broadcast channels</h4>
          {!groupEditId ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (showGroupCreateForm) {
                  resetGroupCreateForm();
                }
                setShowGroupCreateForm((prev) => !prev);
              }}
              disabled={adminBusy}
            >
              {showGroupCreateForm ? "Cancel create" : "Create channel"}
            </button>
          ) : null}
        </div>
        {showGroupCreateForm && !groupEditId ? (
          <div className="admin-edit-panel">
            <div className="admin-edit-title">New broadcast channel</div>
            <div className="admin-grid">
              <input
                value={groupCreateId}
                onChange={(e) => setGroupCreateId(e.target.value)}
                placeholder="broadcast-channel-id"
              />
              <input
                value={groupCreateName}
                onChange={(e) => setGroupCreateName(e.target.value)}
                placeholder="Broadcast channel name"
              />
              <button
                onClick={createBroadcastGroupConfig}
                disabled={adminBusy || !groupCreateId.trim() || !groupCreateName.trim() || groupCreateRoomIds.length === 0}
              >
                Create channel
              </button>
              <button
                type="button"
                onClick={() => {
                  resetGroupCreateForm();
                  setShowGroupCreateForm(false);
                }}
                disabled={adminBusy}
                className="secondary"
              >
                Cancel
              </button>
            </div>
            <div className="admin-grid admin-grid-roles">
              <RoomMultiSelect
                label="Included rooms"
                selectedRoomIds={groupCreateRoomIds}
                setState={setGroupCreateRoomIds}
                keyPrefix="group-create-room"
                rooms={appData.rooms}
              />
              <RoleMultiSelect
                label="Allowed roles"
                selectedRoleIds={groupCreateAllowedRoleIds}
                setState={setGroupCreateAllowedRoleIds}
                keyPrefix="group-create-allowed-roles"
                roles={appData.roles}
              />
            </div>
          </div>
        ) : null}
        {groupEditId ? (
          <div className="admin-edit-panel">
            <div className="admin-edit-title">Editing channel: {groupEditId}</div>
            <div className="admin-grid">
              <input value={groupEditName} onChange={(e) => setGroupEditName(e.target.value)} placeholder="Channel name" />
              <button onClick={saveGroupEdit} disabled={adminBusy || !groupEditName.trim() || groupEditRoomIds.length === 0}>
                Save changes
              </button>
              <button onClick={resetGroupEditForm} disabled={adminBusy} className="secondary">
                Cancel
              </button>
            </div>
            <div className="admin-grid admin-grid-roles">
              <RoomMultiSelect
                label="Included rooms"
                selectedRoomIds={groupEditRoomIds}
                setState={setGroupEditRoomIds}
                keyPrefix="group-edit-room"
                rooms={appData.rooms}
              />
              <RoleMultiSelect
                label="Allowed roles"
                selectedRoleIds={groupEditAllowedRoleIds}
                setState={setGroupEditAllowedRoleIds}
                keyPrefix="group-edit-allowed-roles"
                roles={appData.roles}
              />
            </div>
          </div>
        ) : null}
        <ul className="admin-list">
          {appData.broadcastGroups.map((group) => (
            <li key={group.id}>
              <button
                disabled={adminBusy}
                onClick={() => {
                  setShowGroupCreateForm(false);
                  setGroupEditId(group.id);
                  setGroupEditName(group.name);
                  setGroupEditRoomIds(group.roomIds);
                  setGroupEditAllowedRoleIds(group.allowedRoleIds || []);
                }}
              >
                Edit
              </button>
              <span>
                {group.name} <small>({group.id})</small>
              </span>
              <button onClick={() => removeBroadcastGroupConfig(group.id)} disabled={adminBusy}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
      )}
    </div>
  );
}

