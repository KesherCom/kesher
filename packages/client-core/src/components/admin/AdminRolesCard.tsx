import { useState } from "react";
import type { Bootstrap } from "../../types";
import { createRole, deleteRole, updateRole } from "../../api";
import { useAdminAction } from "./useAdminAction";

type AdminRolesCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminRolesCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminRolesCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const {
    busy: adminBusy,
    error: adminError,
    run: runAdminAction,
  } = useAdminAction({ onSuccess: refreshBootstrapData });
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

  function resetRoleCreateForm() {
    setRoleCreateId("");
    setRoleCreateName("");
    setRoleCreateDefaultRoomId("");
    setRoleCreateDefaultVoiceMode("");
    setRoleCreateDefaultSimpleView(false);
  }

  function resetRoleEditForm() {
    setRoleEditId(null);
    setRoleEditName("");
    setRoleEditDefaultRoomId("");
    setRoleEditDefaultVoiceMode("");
    setRoleEditDefaultSimpleView(false);
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

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Configuration · Roles</div>
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
              <h4>Roles ({appData.roles.length})</h4>
              {!roleEditId ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (showRoleCreateForm) resetRoleCreateForm();
                    setShowRoleCreateForm((prev) => !prev);
                  }}
                  disabled={adminBusy}
                >
                  {showRoleCreateForm ? "Cancel" : "Create role"}
                </button>
              ) : null}
            </div>
            {adminError ? <p className="admin-error">{adminError}</p> : null}
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
                    aria-label="Default party line"
                  >
                    <option value="">Default party line…</option>
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
                      adminBusy ||
                      !roleCreateId.trim() ||
                      !roleCreateName.trim()
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
                <div className="admin-edit-title">
                  Editing role: {roleEditId}
                </div>
                <div className="admin-grid">
                  <input
                    value={roleEditName}
                    onChange={(e) => setRoleEditName(e.target.value)}
                    placeholder="Role name"
                  />
                  <select
                    value={roleEditDefaultRoomId}
                    onChange={(e) => setRoleEditDefaultRoomId(e.target.value)}
                    aria-label="Default party line"
                  >
                    <option value="">Default party line…</option>
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
                  <span>
                    {role.name} <small>({role.id})</small>
                  </span>
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
                  <button
                    onClick={() => removeRoleConfig(role.id)}
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
