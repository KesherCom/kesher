import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { RoleMultiSelect } from "./RoleMultiSelect";

function RoleMultiSelectHarness() {
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  return (
    <RoleMultiSelect
      label="Allowed roles"
      selectedRoleIds={selectedRoleIds}
      setState={setSelectedRoleIds}
      keyPrefix="role-test"
      roles={[
        { id: "op", name: "Operator" },
        { id: "admin", name: "Admin" },
      ]}
    />
  );
}

describe("RoleMultiSelect", () => {
  it("shows default summary when nothing is selected", () => {
    render(<RoleMultiSelectHarness />);
    expect(screen.getByText("No roles selected")).toBeVisible();
  });

  it("selects all roles via Select all button", async () => {
    const user = userEvent.setup();
    render(<RoleMultiSelectHarness />);

    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("All roles")).toBeVisible();
  });

  it("toggles roles and can clear selection", async () => {
    const user = userEvent.setup();
    render(<RoleMultiSelectHarness />);

    await user.click(screen.getByLabelText("Operator"));
    expect(screen.getAllByText("Operator").length).toBeGreaterThan(0);
    expect(screen.queryByText("No roles selected")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("No roles selected")).toBeVisible();
  });
});
