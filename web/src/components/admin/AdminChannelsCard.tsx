import { useState } from "react";
import type { Bootstrap } from "../../types";
import {
  createBroadcastGroup,
  deleteBroadcastGroup,
  updateBroadcastGroup,
} from "../../api";
import { RoleMultiSelect } from "./RoleMultiSelect";
import { PartyLineMultiSelect } from "./PartyLineMultiSelect";
import { useAdminAction } from "./useAdminAction";

type AdminChannelsCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminChannelsCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminChannelsCardProps) {
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

  const [groupCreateId, setGroupCreateId] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateRoomIds, setGroupCreateRoomIds] = useState<string[]>([]);
  const [groupCreateAllowedRoleIds, setGroupCreateAllowedRoleIds] = useState<
    string[]
  >([]);
  const [groupCreatePriorityLevel, setGroupCreatePriorityLevel] = useState(1);
  const [showGroupCreateForm, setShowGroupCreateForm] = useState(false);
  const [groupEditId, setGroupEditId] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditRoomIds, setGroupEditRoomIds] = useState<string[]>([]);
  const [groupEditAllowedRoleIds, setGroupEditAllowedRoleIds] = useState<
    string[]
  >([]);
  const [groupEditPriorityLevel, setGroupEditPriorityLevel] = useState(1);

  function resetGroupCreateForm() {
    setGroupCreateId("");
    setGroupCreateName("");
    setGroupCreateRoomIds([]);
    setGroupCreateAllowedRoleIds([]);
    setGroupCreatePriorityLevel(1);
  }

  function resetGroupEditForm() {
    setGroupEditId(null);
    setGroupEditName("");
    setGroupEditRoomIds([]);
    setGroupEditAllowedRoleIds([]);
    setGroupEditPriorityLevel(1);
  }

  function createBroadcastGroupConfig() {
    const id = groupCreateId.trim();
    const name = groupCreateName.trim();
    if (!id || !name || groupCreateRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await createBroadcastGroup(token, adminPin, {
        id,
        name,
        priorityLevel: groupCreatePriorityLevel,
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
        priorityLevel: groupEditPriorityLevel,
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
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">
          Configuration · Broadcast Channels
        </div>
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
              <h4>Broadcast channels ({appData.broadcastGroups.length})</h4>
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
                  {showGroupCreateForm ? "Cancel" : "Create channel"}
                </button>
              ) : null}
            </div>
            {adminError ? <p className="admin-error">{adminError}</p> : null}

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
                  <label>
                    Priority
                    <select
                      value={groupCreatePriorityLevel}
                      onChange={(e) =>
                        setGroupCreatePriorityLevel(Number(e.target.value))
                      }
                    >
                      {priorityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  <PartyLineMultiSelect
                    label="Included party lines"
                    selectedPartyLineIds={groupCreateRoomIds}
                    setState={setGroupCreateRoomIds}
                    keyPrefix="group-create-party-line"
                    partyLines={appData.rooms}
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
                  <label>
                    Priority
                    <select
                      value={groupEditPriorityLevel}
                      onChange={(e) =>
                        setGroupEditPriorityLevel(Number(e.target.value))
                      }
                    >
                      {priorityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  <PartyLineMultiSelect
                    label="Included party lines"
                    selectedPartyLineIds={groupEditRoomIds}
                    setState={setGroupEditRoomIds}
                    keyPrefix="group-edit-party-line"
                    partyLines={appData.rooms}
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
                  <span>
                    {group.name} <small>({group.id})</small>
                  </span>
                  <button
                    disabled={adminBusy}
                    onClick={() => {
                      setShowGroupCreateForm(false);
                      setGroupEditId(group.id);
                      setGroupEditName(group.name);
                      setGroupEditPriorityLevel(group.priorityLevel ?? 1);
                      setGroupEditRoomIds(group.roomIds);
                      setGroupEditAllowedRoleIds(group.allowedRoleIds || []);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeBroadcastGroupConfig(group.id)}
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
