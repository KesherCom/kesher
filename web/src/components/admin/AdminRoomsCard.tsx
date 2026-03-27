import { useState } from "react";
import type { Bootstrap } from "../../types";
import { createRoom, deleteRoom, updateRoom } from "../../api";
import { RoleMultiSelect } from "./RoleMultiSelect";
import { useAdminAction } from "./useAdminAction";

type AdminRoomsCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminRoomsCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminRoomsCardProps) {
  const priorityOptions = [
    { value: 0, label: "Low" },
    { value: 1, label: "Normal" },
    { value: 2, label: "High" },
    { value: 3, label: "Critical" },
  ] as const;

  const [isOpen, setIsOpen] = useState(false);
  const {
    busy: adminBusy,
    error: adminError,
    run: runAdminAction,
  } = useAdminAction({ onSuccess: refreshBootstrapData });

  const [roomCreateId, setRoomCreateId] = useState("");
  const [roomCreateName, setRoomCreateName] = useState("");
  const [roomCreateSenderRoleIds, setRoomCreateSenderRoleIds] = useState<
    string[]
  >([]);
  const [roomCreateReceiverRoleIds, setRoomCreateReceiverRoleIds] = useState<
    string[]
  >([]);
  const [roomCreateForcedListenRoleIds, setRoomCreateForcedListenRoleIds] =
    useState<string[]>([]);
  const [roomCreatePriorityLevel, setRoomCreatePriorityLevel] = useState(1);
  const [showRoomCreateForm, setShowRoomCreateForm] = useState(false);
  const [roomEditId, setRoomEditId] = useState<string | null>(null);
  const [roomEditName, setRoomEditName] = useState("");
  const [roomEditSenderRoleIds, setRoomEditSenderRoleIds] = useState<string[]>(
    [],
  );
  const [roomEditReceiverRoleIds, setRoomEditReceiverRoleIds] = useState<
    string[]
  >([]);
  const [roomEditForcedListenRoleIds, setRoomEditForcedListenRoleIds] =
    useState<string[]>([]);
  const [roomEditPriorityLevel, setRoomEditPriorityLevel] = useState(1);

  function getPriorityLabel(priorityLevel: number | undefined) {
    return (
      priorityOptions.find((option) => option.value === priorityLevel)?.label ||
      "Normal"
    );
  }

  function resetRoomCreateForm() {
    setRoomCreateId("");
    setRoomCreateName("");
    setRoomCreateSenderRoleIds([]);
    setRoomCreateReceiverRoleIds([]);
    setRoomCreateForcedListenRoleIds([]);
    setRoomCreatePriorityLevel(1);
  }

  function resetRoomEditForm() {
    setRoomEditId(null);
    setRoomEditName("");
    setRoomEditSenderRoleIds([]);
    setRoomEditReceiverRoleIds([]);
    setRoomEditForcedListenRoleIds([]);
    setRoomEditPriorityLevel(1);
  }

  function createRoomConfig() {
    const id = roomCreateId.trim();
    const name = roomCreateName.trim();
    if (!id || !name) return;
    void runAdminAction(async () => {
      await createRoom(token, adminPin, {
        id,
        name,
        priorityLevel: roomCreatePriorityLevel,
        senderRoleIds: roomCreateSenderRoleIds,
        receiverRoleIds: roomCreateReceiverRoleIds,
        forcedListenRoleIds: roomCreateForcedListenRoleIds,
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
        priorityLevel: roomEditPriorityLevel,
        senderRoleIds: roomEditSenderRoleIds,
        receiverRoleIds: roomEditReceiverRoleIds,
        forcedListenRoleIds: roomEditForcedListenRoleIds,
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

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Configuration · Party Lines</div>
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
            <div className="admin-block-header">
              <h4>Party Lines ({appData.rooms.length})</h4>
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
                  {showRoomCreateForm ? "Cancel" : "Create party line"}
                </button>
              ) : null}
            </div>
            {adminError ? <p className="admin-error">{adminError}</p> : null}

            {showRoomCreateForm && !roomEditId ? (
              <div className="admin-edit-panel admin-room-form">
                <div className="admin-room-form-header">
                  <div className="admin-edit-title">New party line</div>
                  <p className="admin-room-form-subtitle">
                    Set basic details and define who can send, receive, or must
                    listen.
                  </p>
                </div>
                <div className="admin-room-form-layout">
                  <div className="admin-room-form-main">
                    <div className="admin-room-form-section-title">
                      Basic settings
                    </div>
                    <div className="admin-room-fields">
                      <input
                        value={roomCreateId}
                        onChange={(e) => setRoomCreateId(e.target.value)}
                        placeholder="party-line-id"
                      />
                      <input
                        value={roomCreateName}
                        onChange={(e) => setRoomCreateName(e.target.value)}
                        placeholder="Party line name"
                      />
                      <label className="admin-room-field">
                        Priority
                        <select
                          value={roomCreatePriorityLevel}
                          onChange={(e) =>
                            setRoomCreatePriorityLevel(Number(e.target.value))
                          }
                        >
                          {priorityOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

                  <div className="admin-room-form-side">
                    <div className="admin-room-form-section-title">Actions</div>
                    <div className="admin-room-action-buttons">
                      <button
                        onClick={createRoomConfig}
                        disabled={
                          adminBusy ||
                          !roomCreateId.trim() ||
                          !roomCreateName.trim()
                        }
                      >
                        Create party line
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
                  </div>
                </div>

                <div className="admin-room-form-roles">
                  <div className="admin-room-form-section-title">Role access</div>
                  <div className="admin-room-role-grid">
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
                    <RoleMultiSelect
                      label="Forced listeners"
                      selectedRoleIds={roomCreateForcedListenRoleIds}
                      setState={setRoomCreateForcedListenRoleIds}
                      keyPrefix="room-create-forced-listen"
                      roles={appData.roles}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {roomEditId ? (
              <div className="admin-edit-panel admin-room-form">
                <div className="admin-room-form-header">
                  <div className="admin-edit-title">
                    Editing party line: {roomEditId}
                  </div>
                  <p className="admin-room-form-subtitle">
                    Update routing permissions and keep this party line easy to
                    scan.
                  </p>
                </div>
                <div className="admin-room-form-layout">
                  <div className="admin-room-form-main">
                    <div className="admin-room-form-section-title">
                      Basic settings
                    </div>
                    <div className="admin-room-fields admin-room-fields-edit">
                      <input
                        value={roomEditName}
                        onChange={(e) => setRoomEditName(e.target.value)}
                        placeholder="Party line name"
                      />
                      <label className="admin-room-field">
                        Priority
                        <select
                          value={roomEditPriorityLevel}
                          onChange={(e) =>
                            setRoomEditPriorityLevel(Number(e.target.value))
                          }
                        >
                          {priorityOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

                  <div className="admin-room-form-side">
                    <div className="admin-room-form-section-title">Actions</div>
                    <div className="admin-room-action-buttons">
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
                  </div>
                </div>

                <div className="admin-room-form-roles">
                  <div className="admin-room-form-section-title">Role access</div>
                  <div className="admin-room-role-grid">
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
                    <RoleMultiSelect
                      label="Forced listeners"
                      selectedRoleIds={roomEditForcedListenRoleIds}
                      setState={setRoomEditForcedListenRoleIds}
                      keyPrefix="room-edit-forced-listen"
                      roles={appData.roles}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <ul className="admin-list">
              {appData.rooms.map((room) => (
                <li key={room.id}>
                  <span className="admin-room-list-entry">
                    <span className="admin-room-list-name">{room.name}</span>
                    <span className="admin-room-list-meta">
                      <small>({room.id})</small>
                      <span
                        className={`priority-badge priority-${room.priorityLevel ?? 1}`}
                      >
                        {getPriorityLabel(room.priorityLevel ?? 1)}
                      </span>
                    </span>
                  </span>
                  <button
                    disabled={adminBusy}
                    onClick={() => {
                      setShowRoomCreateForm(false);
                      setRoomEditId(room.id);
                      setRoomEditName(room.name);
                      setRoomEditSenderRoleIds(room.senderRoleIds || []);
                      setRoomEditReceiverRoleIds(room.receiverRoleIds || []);
                      setRoomEditForcedListenRoleIds(
                        room.forcedListenRoleIds || [],
                      );
                      setRoomEditPriorityLevel(room.priorityLevel ?? 1);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeRoomConfig(room.id)}
                    disabled={adminBusy}
                    className="delete"
                  >
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
