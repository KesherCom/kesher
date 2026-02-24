import React, { useState } from "react";
import type { Bootstrap } from "../../types";
import {
  createRoom,
  deleteRoom,
  updateRoom
} from "../../api";
import { RoleMultiSelect } from "./RoleMultiSelect";

type AdminRoomsCardProps = {
  token: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminRoomsCard({
  token,
  appData,
  refreshBootstrapData
}: AdminRoomsCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  const [roomCreateId, setRoomCreateId] = useState("");
  const [roomCreateName, setRoomCreateName] = useState("");
  const [roomCreateSenderRoleIds, setRoomCreateSenderRoleIds] = useState<string[]>([]);
  const [roomCreateReceiverRoleIds, setRoomCreateReceiverRoleIds] = useState<string[]>([]);
  const [showRoomCreateForm, setShowRoomCreateForm] = useState(false);
  const [roomEditId, setRoomEditId] = useState<string | null>(null);
  const [roomEditName, setRoomEditName] = useState("");
  const [roomEditSenderRoleIds, setRoomEditSenderRoleIds] = useState<string[]>([]);
  const [roomEditReceiverRoleIds, setRoomEditReceiverRoleIds] = useState<string[]>([]);

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

  function resetRoomCreateForm() {
    setRoomCreateId("");
    setRoomCreateName("");
    setRoomCreateSenderRoleIds([]);
    setRoomCreateReceiverRoleIds([]);
  }

  function resetRoomEditForm() {
    setRoomEditId(null);
    setRoomEditName("");
    setRoomEditSenderRoleIds([]);
    setRoomEditReceiverRoleIds([]);
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

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Configuration · Rooms</div>
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
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Rooms ({appData.rooms.length})</h4>
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
            {adminError ? <p className="admin-error">{adminError}</p> : null}

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
        </div>
      ) : null}
    </div>
  );
}
