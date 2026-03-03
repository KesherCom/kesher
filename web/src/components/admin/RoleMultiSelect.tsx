import { type Dispatch, type SetStateAction } from "react";
import type { Role } from "../../types";
import { EntityMultiSelect } from "./EntityMultiSelect";

type RoleMultiSelectProps = {
  label: string;
  selectedRoleIds: string[];
  setState: Dispatch<SetStateAction<string[]>>;
  keyPrefix: string;
  roles: Role[];
};

export function RoleMultiSelect({
  label,
  selectedRoleIds,
  setState,
  keyPrefix,
  roles,
}: RoleMultiSelectProps) {
  return (
    <EntityMultiSelect
      label={label}
      selectedIds={selectedRoleIds}
      setState={setState}
      keyPrefix={keyPrefix}
      options={roles.map((role) => ({ id: role.id, label: role.name }))}
      noneSelectedLabel="No roles selected"
      allSelectedLabel="All roles"
      selectAllLabel="Select all"
      clearLabel="Clear all"
    />
  );
}
