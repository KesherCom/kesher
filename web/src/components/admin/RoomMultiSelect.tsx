import { type Dispatch, type SetStateAction } from "react";
import type { Room } from "../../types";
import { EntityMultiSelect } from "./EntityMultiSelect";

type RoomMultiSelectProps = {
  label: string;
  selectedRoomIds: string[];
  setState: Dispatch<SetStateAction<string[]>>;
  keyPrefix: string;
  rooms: Room[];
};

export function RoomMultiSelect({
  label,
  selectedRoomIds,
  setState,
  keyPrefix,
  rooms,
}: RoomMultiSelectProps) {
  return (
    <EntityMultiSelect
      label={label}
      selectedIds={selectedRoomIds}
      setState={setState}
      keyPrefix={keyPrefix}
      options={rooms.map((room) => ({ id: room.id, label: room.name }))}
      noneSelectedLabel="No rooms selected"
      clearLabel="Clear selection"
    />
  );
}
