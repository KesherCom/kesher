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
import type { Bootstrap } from "../../types";
import { RoleMultiSelect } from "./RoleMultiSelect";

type AdminPanelProps = {
  token: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminPanel({ token, appData, refreshBootstrapData }: AdminPanelProps) {
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  const [roleCreateId, setRoleCreateId] = useState("");
  const [roleCreateName, setRoleCreateName] = useState("");
  const [roleCreateDefaultRoomId, setRoleCreateDefaultRoomId] = useState("");
  const [roleCreateDefaultVoiceMode, setRoleCreateDefaultVoiceMode] = useState<"always_on" | "ptt" | "">("");
  const [roleCreateDefaultSimpleView, setRoleCreateDefaultSimpleView] = useState(false);
  const [roleEditId, setRoleEditId] = useState<string | null>(null);
  const [roleEditName, setRoleEditName] = useState("");
  const [roleEditDefaultRoomId, setRoleEditDefaultRoomId] = useState("");
  const [roleEditDefaultVoiceMode, setRoleEditDefaultVoiceMode] = useState<"always_on" | "ptt" | "">("");
  const [roleEditDefaultSimpleView, setRoleEditDefaultSimpleView] = useState(false);
  const [roomCreateId, setRoomCreateId] = useState("");
  const [roomCreateName, setRoomCreateName] = useState("");
  const [roomCreateSenderRoleIds, setRoomCreateSenderRoleIds] = useState<string[]>([]);
  const [roomCreateReceiverRoleIds, setRoomCreateReceiverRoleIds] = useState<string[]>([]);
  const [roomEditId, setRoomEditId] = useState<string | null>(null);
  const [roomEditName, setRoomEditName] = useState("");
  const [roomEditSenderRoleIds, setRoomEditSenderRoleIds] = useState<string[]>([]);
  const [roomEditReceiverRoleIds, setRoomEditReceiverRoleIds] = useState<string[]>([]);
  const [groupCreateId, setGroupCreateId] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateRoomIds, setGroupCreateRoomIds] = useState<string[]>([]);
  const [groupEditId, setGroupEditId] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditRoomIds, setGroupEditRoomIds] = useState<string[]>([]);

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

  function resetGroupCreateForm() {
    setGroupCreateId("");
    setGroupCreateName("");
    setGroupCreateRoomIds([]);
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
      setRoleCreateId("");
      setRoleCreateName("");
      setRoleCreateDefaultVoiceMode("");
      setRoleCreateDefaultSimpleView(false);
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
    void runAdminAction(() => deleteRole(token, id));
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
      setRoomCreateId("");
      setRoomCreateName("");
      setRoomCreateSenderRoleIds([]);
      setRoomCreateReceiverRoleIds([]);
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
    void runAdminAction(() => deleteRoom(token, id));
  }

  function createBroadcastGroupConfig() {
    const id = groupCreateId.trim();
    const name = groupCreateName.trim();
    if (!id || !name || groupCreateRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await createBroadcastGroup(token, { id, name, roomIds: groupCreateRoomIds });
      resetGroupCreateForm();
    });
  }

  function saveGroupEdit() {
    if (!groupEditId) return;
    const name = groupEditName.trim();
    if (!name || groupEditRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await updateBroadcastGroup(token, groupEditId, { name, roomIds: groupEditRoomIds });
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
        <h4>Create role</h4>
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
          <button onClick={createRoleConfig} disabled={adminBusy || !roleCreateId.trim() || !roleCreateName.trim()}>
            Create role
          </button>
        </div>
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
                onClick={() => {
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
      <div className="admin-block">
        <h4>Create room</h4>
        <div className="admin-grid">
          <input value={roomCreateId} onChange={(e) => setRoomCreateId(e.target.value)} placeholder="room-id" />
          <input value={roomCreateName} onChange={(e) => setRoomCreateName(e.target.value)} placeholder="Room name" />
          <button onClick={createRoomConfig} disabled={adminBusy || !roomCreateId.trim() || !roomCreateName.trim()}>
            Create room
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
                onClick={() => {
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
      <div className="admin-block">
        <h4>Create broadcast channel</h4>
        <div className="admin-grid">
          <input value={groupCreateId} onChange={(e) => setGroupCreateId(e.target.value)} placeholder="broadcast-channel-id" />
          <input value={groupCreateName} onChange={(e) => setGroupCreateName(e.target.value)} placeholder="Broadcast channel name" />
          <button
            onClick={createBroadcastGroupConfig}
            disabled={adminBusy || !groupCreateId.trim() || !groupCreateName.trim() || groupCreateRoomIds.length === 0}
          >
            Create channel
          </button>
        </div>
        <div className="admin-room-picker">
          {appData.rooms.map((room) => (
            <label key={`group-create-room-${room.id}`} className="admin-checkbox">
              <input
                type="checkbox"
                checked={groupCreateRoomIds.includes(room.id)}
                onChange={() =>
                  setGroupCreateRoomIds((prev) =>
                    prev.includes(room.id) ? prev.filter((id) => id !== room.id) : [...prev, room.id]
                  )
                }
              />
              <span>{room.name}</span>
            </label>
          ))}
        </div>
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
            <div className="admin-room-picker">
              {appData.rooms.map((room) => (
                <label key={`group-edit-room-${room.id}`} className="admin-checkbox">
                  <input
                    type="checkbox"
                    checked={groupEditRoomIds.includes(room.id)}
                    onChange={() =>
                      setGroupEditRoomIds((prev) =>
                        prev.includes(room.id) ? prev.filter((id) => id !== room.id) : [...prev, room.id]
                      )
                    }
                  />
                  <span>{room.name}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
        <ul className="admin-list">
          {appData.broadcastGroups.map((group) => (
            <li key={group.id}>
              <button
                onClick={() => {
                  setGroupEditId(group.id);
                  setGroupEditName(group.name);
                  setGroupEditRoomIds(group.roomIds);
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
    </div>
  );
}

