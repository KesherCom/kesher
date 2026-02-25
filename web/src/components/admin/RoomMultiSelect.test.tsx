import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { RoomMultiSelect } from "./RoomMultiSelect";

function RoomMultiSelectHarness() {
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  return (
    <RoomMultiSelect
      label="Included rooms"
      selectedRoomIds={selectedRoomIds}
      setState={setSelectedRoomIds}
      keyPrefix="room-test"
      rooms={[
        { id: "r1", name: "Room 1", senderRoleIds: [], receiverRoleIds: [] },
        { id: "r2", name: "Room 2", senderRoleIds: [], receiverRoleIds: [] },
      ]}
    />
  );
}

describe("RoomMultiSelect", () => {
  it("shows no rooms selected by default", () => {
    render(<RoomMultiSelectHarness />);
    expect(screen.getByText("No rooms selected")).toBeVisible();
  });

  it("selects a room and supports clear selection", async () => {
    const user = userEvent.setup();
    render(<RoomMultiSelectHarness />);

    await user.click(screen.getByLabelText("Room 1"));
    expect(screen.getAllByText("Room 1").length).toBeGreaterThan(0);
    expect(screen.queryByText("No rooms selected")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("No rooms selected")).toBeVisible();
  });
});
