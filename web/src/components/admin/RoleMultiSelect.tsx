import { type Dispatch, type SetStateAction } from "react";
import type { Role } from "../../types";

type RoleMultiSelectProps = {
  label: string;
  selectedRoleIds: string[];
  setState: Dispatch<SetStateAction<string[]>>;
  keyPrefix: string;
  roles: Role[];
};

function toggleRoleInSelection(
  roleValue: string,
  setState: Dispatch<SetStateAction<string[]>>
) {
  setState((prev) => (prev.includes(roleValue) ? prev.filter((entry) => entry !== roleValue) : [...prev, roleValue]));
}

export function RoleMultiSelect({ label, selectedRoleIds, setState, keyPrefix, roles }: RoleMultiSelectProps) {
  return (
    <div className="role-multiselect">
      <details className="role-multiselect-details">
        <summary className="role-multiselect-summary">
          <span className="role-multiselect-label">{label}</span>
          <span className="role-multiselect-value">
            {selectedRoleIds.length === 0
              ? "All roles"
              : selectedRoleIds.map((roleEntryId) => roles.find((role) => role.id === roleEntryId)?.name || roleEntryId).join(", ")}
          </span>
        </summary>
        <div className="role-multiselect-menu">
          <button type="button" className="secondary role-multiselect-reset" onClick={() => setState([])}>
            Clear (allow all)
          </button>
          <div className="role-multiselect-options">
            {roles.map((role) => (
              <label
                key={`${keyPrefix}-${role.id}`}
                className={`role-multiselect-option ${selectedRoleIds.includes(role.id) ? "selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedRoleIds.includes(role.id)}
                  onChange={() => toggleRoleInSelection(role.id, setState)}
                />
                <span className="role-multiselect-option-text">{role.name}</span>
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

