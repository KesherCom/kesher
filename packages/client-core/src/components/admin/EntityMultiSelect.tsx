import { type Dispatch, type SetStateAction } from "react";

type EntityMultiSelectOption = {
  id: string;
  label: string;
};

type EntityMultiSelectProps = {
  label: string;
  selectedIds: string[];
  setState: Dispatch<SetStateAction<string[]>>;
  keyPrefix: string;
  options: EntityMultiSelectOption[];
  noneSelectedLabel: string;
  allSelectedLabel?: string;
  selectAllLabel?: string;
  clearLabel: string;
};

function toggleEntityInSelection(
  entityID: string,
  setState: Dispatch<SetStateAction<string[]>>,
) {
  setState((prev) =>
    prev.includes(entityID)
      ? prev.filter((entry) => entry !== entityID)
      : [...prev, entityID],
  );
}

export function EntityMultiSelect({
  label,
  selectedIds,
  setState,
  keyPrefix,
  options,
  noneSelectedLabel,
  allSelectedLabel,
  selectAllLabel,
  clearLabel,
}: EntityMultiSelectProps) {
  const summaryLabel =
    selectedIds.length === 0
      ? noneSelectedLabel
      : allSelectedLabel && selectedIds.length === options.length
        ? allSelectedLabel
        : selectedIds
            .map(
              (entryID) =>
                options.find((option) => option.id === entryID)?.label ||
                entryID,
            )
            .join(", ");

  return (
    <div className="role-multiselect">
      <details className="role-multiselect-details">
        <summary className="role-multiselect-summary">
          <span className="role-multiselect-label">{label}</span>
          <span className="role-multiselect-value">{summaryLabel}</span>
        </summary>
        <div className="role-multiselect-menu">
          <div className="role-multiselect-actions">
            {selectAllLabel ? (
              <button
                type="button"
                className="secondary role-multiselect-reset"
                onClick={() => setState(options.map((option) => option.id))}
              >
                {selectAllLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="secondary role-multiselect-reset"
              onClick={() => setState([])}
            >
              {clearLabel}
            </button>
          </div>
          <div className="role-multiselect-options">
            {options.map((option) => (
              <label
                key={`${keyPrefix}-${option.id}`}
                className={`role-multiselect-option ${selectedIds.includes(option.id) ? "selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(option.id)}
                  onChange={() => toggleEntityInSelection(option.id, setState)}
                />
                <span className="role-multiselect-option-text">
                  {option.label}
                </span>
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
