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
  updateRoom,
} from "../../api";
import { UsersPanel } from "./UsersPanel";
import type { Bootstrap } from "../../types";
import { RoleMultiSelect } from "./RoleMultiSelect";
import { RoomMultiSelect } from "./RoomMultiSelect";

type AdminPanelProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  activeSection?: "roles" | "users" | "rooms" | "channels" | null;
  showHeading?: boolean;
  compact?: boolean;
};

export function AdminPanel({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
  activeSection,
  showHeading = true,
  compact = false,
}: AdminPanelProps) {
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  const [roleCreateId, setRoleCreateId] = useState("");
  const [roleCreateName, setRoleCreateName] = useState("");
  const [roleCreateDefaultRoomId, setRoleCreateDefaultRoomId] = useState("");
  const [roleCreateDefaultVoiceMode, setRoleCreateDefaultVoiceMode] = useState<
    "always_on" | "ptt" | ""
  >("");
  const [roleCreateDefaultSimpleView, setRoleCreateDefaultSimpleView] =
    useState(false);
  const [showRoleCreateForm, setShowRoleCreateForm] = useState(false);
  const [roleEditId, setRoleEditId] = useState<string | null>(null);
  const [roleEditName, setRoleEditName] = useState("");
  const [roleEditDefaultRoomId, setRoleEditDefaultRoomId] = useState("");
  const [roleEditDefaultVoiceMode, setRoleEditDefaultVoiceMode] = useState<
    "always_on" | "ptt" | ""
  >("");
  const [roleEditDefaultSimpleView, setRoleEditDefaultSimpleView] =
    useState(false);
  const [roomCreateId, setRoomCreateId] = useState("");
  const [roomCreateName, setRoomCreateName] = useState("");
  const [roomCreateSenderRoleIds, setRoomCreateSenderRoleIds] = useState<
    string[]
  >([]);
  const [roomCreateReceiverRoleIds, setRoomCreateReceiverRoleIds] = useState<
    string[]
  >([]);
  const [showRoomCreateForm, setShowRoomCreateForm] = useState(false);
  const [roomEditId, setRoomEditId] = useState<string | null>(null);
  const [roomEditName, setRoomEditName] = useState("");
  const [roomEditSenderRoleIds, setRoomEditSenderRoleIds] = useState<string[]>(
    [],
  );
  const [roomEditReceiverRoleIds, setRoomEditReceiverRoleIds] = useState<
    string[]
  >([]);
  const [groupCreateId, setGroupCreateId] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateRoomIds, setGroupCreateRoomIds] = useState<string[]>([]);
  const [groupCreateAllowedRoleIds, setGroupCreateAllowedRoleIds] = useState<
    string[]
  >([]);
  const [showGroupCreateForm, setShowGroupCreateForm] = useState(false);
  const [groupEditId, setGroupEditId] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditRoomIds, setGroupEditRoomIds] = useState<string[]>([]);
  const [groupEditAllowedRoleIds, setGroupEditAllowedRoleIds] = useState<
    string[]
  >([]);
  const [localSection, setLocalSection] = useState<
    "roles" | "users" | "rooms" | "channels"
  >(activeSection ?? "roles");
  // keep local section in sync if parent controls it
  useEffect(() => {
    if (activeSection) setLocalSection(activeSection);
  }, [activeSection]);
  const section = activeSection ?? localSection;

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
      setAdminError(
        error instanceof Error ? error.message : "admin operation failed",
      );
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
      await createRole(token, adminPin, {
        id,
        name,
        defaultRoomId: roleCreateDefaultRoomId.trim() || undefined,
        defaultVoiceMode: roleCreateDefaultVoiceMode || undefined,
        defaultSimpleView: roleCreateDefaultSimpleView,
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
      await updateRole(token, adminPin, roleEditId, {
        name,
        defaultRoomId: roleEditDefaultRoomId.trim() || undefined,
        defaultVoiceMode: roleEditDefaultVoiceMode || undefined,
        defaultSimpleView: roleEditDefaultSimpleView,
      });
      resetRoleEditForm();
    });
  }

  function removeRoleConfig(id: string) {
    void runAdminAction(async () => {
      await deleteRole(token, adminPin, id);
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
      await createRoom(token, adminPin, {
        id,
        name,
        senderRoleIds: roomCreateSenderRoleIds,
        receiverRoleIds: roomCreateReceiverRoleIds,
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
      await updateRoom(token, adminPin, roomEditId, {
        name,
        senderRoleIds: roomEditSenderRoleIds,
        receiverRoleIds: roomEditReceiverRoleIds,
      });
      resetRoomEditForm();
    });
  }

  function removeRoomConfig(id: string) {
    void runAdminAction(async () => {
      await deleteRoom(token, adminPin, id);
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
      await createBroadcastGroup(token, adminPin, {
        id,
        name,
        roomIds: groupCreateRoomIds,
        allowedRoleIds: groupCreateAllowedRoleIds,
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
      await updateBroadcastGroup(token, adminPin, groupEditId, {
        name,
        roomIds: groupEditRoomIds,
        allowedRoleIds: groupEditAllowedRoleIds,
      });
      resetGroupEditForm();
    });
  }

  function removeBroadcastGroupConfig(id: string) {
    void runAdminAction(async () => {
      await deleteBroadcastGroup(token, adminPin, id);
      if (groupEditId === id) {
        resetGroupEditForm();
      }
    });
  }

  return (
    <div
      className={compact ? "admin-panel admin-panel-compact" : "admin-panel"}
    >
      {showHeading ? <h3>Admin · configuration</h3> : null}
      <nav className="admin-inline-nav" aria-label="Admin sections">
        <button
          className={`admin-inline-button ${section === "roles" ? "active" : ""}`}
          onClick={() => setLocalSection("roles")}
        >
          Roles <span className="admin-tab-badge">{appData.roles.length}</span>
        </button>
        <button
          className={`admin-inline-button ${section === "users" ? "active" : ""}`}
          onClick={() => setLocalSection("users")}
        >
          Users{" "}
          <span className="admin-tab-badge">
            {
              appData.users.filter((u) => u.username.toLowerCase() !== "admin")
                .length
            }
          </span>
        </button>
        <button
          className={`admin-inline-button ${section === "rooms" ? "active" : ""}`}
          onClick={() => setLocalSection("rooms")}
        >
          Rooms <span className="admin-tab-badge">{appData.rooms.length}</span>
        </button>
        <button
          className={`admin-inline-button ${section === "channels" ? "active" : ""}`}
          onClick={() => setLocalSection("channels")}
        >
          Channels{" "}
          <span className="admin-tab-badge">
            {appData.broadcastGroups.length}
          </span>
        </button>
      </nav>
      {adminError ? <p className="admin-error">{adminError}</p> : null}

      {section === "users" && (
        <UsersPanel
          token={token}
          appData={appData}
          refreshBootstrapData={refreshBootstrapData}
          adminBusy={adminBusy}
        />
      )}

      {section === "roles" && (
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
                <input
                  value={roleCreateId}
                  onChange={(e) => setRoleCreateId(e.target.value)}
                  placeholder="role-id"
                />
                <input
                  value={roleCreateName}
                  onChange={(e) => setRoleCreateName(e.target.value)}
                  placeholder="Role name"
                />
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
                  onChange={(e) =>
                    setRoleCreateDefaultVoiceMode(
                      e.target.value as "always_on" | "ptt" | "",
                    )
                  }
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
                    onChange={(e) =>
                      setRoleCreateDefaultSimpleView(e.target.checked)
                    }
                  />
                  <span>Default to simple mobile view</span>
                </label>
              </div>
              <div className="admin-form-actions">
                <button
                  onClick={createRoleConfig}
                  disabled={
                    adminBusy || !roleCreateId.trim() || !roleCreateName.trim()
                  }
                >
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
                <input
                  value={roleEditName}
                  onChange={(e) => setRoleEditName(e.target.value)}
                  placeholder="Role name"
                />
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
                  onChange={(e) =>
                    setRoleEditDefaultVoiceMode(
                      e.target.value as "always_on" | "ptt" | "",
                    )
                  }
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
                    onChange={(e) =>
                      setRoleEditDefaultSimpleView(e.target.checked)
                    }
                  />
                  <span>Default to simple mobile view</span>
                </label>
              </div>
              <div className="admin-form-actions">
                <button
                  onClick={saveRoleEdit}
                  disabled={adminBusy || !roleEditName.trim()}
                >
                  Save changes
                </button>
                <button
                  onClick={resetRoleEditForm}
                  disabled={adminBusy}
                  className="secondary"
                >
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
                    setRoleEditDefaultVoiceMode(
                      (role.defaultVoiceMode as "always_on" | "ptt") || "",
                    );
                    setRoleEditDefaultSimpleView(!!role.defaultSimpleView);
                  }}
                >
                  Edit
                </button>
                <span>
                  {role.name} <small>({role.id})</small>
                </span>
                <button
                  onClick={() => removeRoleConfig(role.id)}
                  disabled={adminBusy}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {section === "rooms" && (
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
                <input
                  value={roomCreateId}
                  onChange={(e) => setRoomCreateId(e.target.value)}
                  placeholder="room-id"
                />
                <input
                  value={roomCreateName}
                  onChange={(e) => setRoomCreateName(e.target.value)}
                  placeholder="Room name"
                />
                <button
                  onClick={createRoomConfig}
                  disabled={
                    adminBusy || !roomCreateId.trim() || !roomCreateName.trim()
                  }
                >
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
                <input
                  value={roomEditName}
                  onChange={(e) => setRoomEditName(e.target.value)}
                  placeholder="Room name"
                />
                <button
                  onClick={saveRoomEdit}
                  disabled={adminBusy || !roomEditName.trim()}
                >
                  Save changes
                </button>
                <button
                  onClick={resetRoomEditForm}
                  disabled={adminBusy}
                  className="secondary"
                >
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
                <button
                  onClick={() => removeRoomConfig(room.id)}
                  disabled={adminBusy}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {section === "channels" && (
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
                  disabled={
                    adminBusy ||
                    !groupCreateId.trim() ||
                    !groupCreateName.trim() ||
                    groupCreateRoomIds.length === 0
                  }
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
              <div className="admin-edit-title">
                Editing channel: {groupEditId}
              </div>
              <div className="admin-grid">
                <input
                  value={groupEditName}
                  onChange={(e) => setGroupEditName(e.target.value)}
                  placeholder="Channel name"
                />
                <button
                  onClick={saveGroupEdit}
                  disabled={
                    adminBusy ||
                    !groupEditName.trim() ||
                    groupEditRoomIds.length === 0
                  }
                >
                  Save changes
                </button>
                <button
                  onClick={resetGroupEditForm}
                  disabled={adminBusy}
                  className="secondary"
                >
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
                <button
                  onClick={() => removeBroadcastGroupConfig(group.id)}
                  disabled={adminBusy}
                >
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
