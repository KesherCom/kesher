import { type Dispatch, type SetStateAction } from "react";
import type { Room } from "../../types";

type RoomMultiSelectProps = {
  label: string;
  selectedRoomIds: string[];
  setState: Dispatch<SetStateAction<string[]>>;
  keyPrefix: string;
  rooms: Room[];
};

function toggleRoomInSelection(
  roomValue: string,
  setState: Dispatch<SetStateAction<string[]>>
) {
  setState((prev) => (prev.includes(roomValue) ? prev.filter((entry) => entry !== roomValue) : [...prev, roomValue]));
}

export function RoomMultiSelect({ label, selectedRoomIds, setState, keyPrefix, rooms }: RoomMultiSelectProps) {
  return (
    <div className="role-multiselect">
      <details className="role-multiselect-details">
        <summary className="role-multiselect-summary">
          <span className="role-multiselect-label">{label}</span>
          <span className="role-multiselect-value">
            {selectedRoomIds.length === 0
              ? "No rooms selected"
              : selectedRoomIds
                  .map((roomEntryId) => rooms.find((room) => room.id === roomEntryId)?.name || roomEntryId)
                  .join(", ")}
          </span>
        </summary>
        <div className="role-multiselect-menu">
          <button type="button" className="secondary role-multiselect-reset" onClick={() => setState([])}>
            Clear selection
          </button>
          <div className="role-multiselect-options">
            {rooms.map((room) => (
              <label
                key={`${keyPrefix}-${room.id}`}
                className={`role-multiselect-option ${selectedRoomIds.includes(room.id) ? "selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedRoomIds.includes(room.id)}
                  onChange={() => toggleRoomInSelection(room.id, setState)}
                />
                <span className="role-multiselect-option-text">{room.name}</span>
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

