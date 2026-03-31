import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PartyLineMultiSelect } from "./PartyLineMultiSelect";

function PartyLineMultiSelectHarness() {
  const [selectedPartyLineIds, setSelectedPartyLineIds] = useState<string[]>([]);
  return (
    <PartyLineMultiSelect
      label="Included party lines"
      selectedPartyLineIds={selectedPartyLineIds}
      setState={setSelectedPartyLineIds}
      keyPrefix="party-line-test"
      partyLines={[
        { id: "r1", name: "Party Line 1", senderRoleIds: [], receiverRoleIds: [], forcedListenRoleIds: [] },
        { id: "r2", name: "Party Line 2", senderRoleIds: [], receiverRoleIds: [], forcedListenRoleIds: [] },
      ]}
    />
  );
}

describe("PartyLineMultiSelect", () => {
  it("shows no party lines selected by default", () => {
    render(<PartyLineMultiSelectHarness />);
    expect(screen.getByText("No party lines selected")).toBeVisible();
  });

  it("selects a party line and supports clear selection", async () => {
    const user = userEvent.setup();
    render(<PartyLineMultiSelectHarness />);

    await user.click(screen.getByLabelText("Party Line 1"));
    expect(screen.getAllByText("Party Line 1").length).toBeGreaterThan(0);
    expect(screen.queryByText("No party lines selected")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("No party lines selected")).toBeVisible();
  });
});
