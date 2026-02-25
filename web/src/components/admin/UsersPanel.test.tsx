import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsersPanel } from "./UsersPanel";
import type { Bootstrap } from "../../types";

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [
    { id: "u1", username: "tim", roleId: "op" },
    { id: "admin", username: "admin", roleId: "admin" },
    { id: "u2", username: "Alice", roleId: "op" },
  ],
  roles: [
    { id: "op", name: "Operator" },
    { id: "admin", name: "Admin" },
  ],
  rooms: [],
  broadcastGroups: [],
};

describe("UsersPanel", () => {
  it("renders non-admin users only", () => {
    render(
      <UsersPanel
        token="token-123"
        appData={appData}
        refreshBootstrapData={vi.fn()}
        adminBusy={false}
      />,
    );

    expect(screen.getByText("tim")).toBeVisible();
    expect(screen.getByText("Alice")).toBeVisible();
    expect(screen.queryByText("(admin)")).not.toBeInTheDocument();
  });

  it("keeps assign controls disabled while endpoints are not implemented", () => {
    render(
      <UsersPanel
        token="token-123"
        appData={appData}
        refreshBootstrapData={vi.fn()}
        adminBusy={false}
      />,
    );

    const assignButtons = screen.getAllByRole("button", { name: "Assign" });
    expect(assignButtons.length).toBe(2);
    assignButtons.forEach((button) => expect(button).toBeDisabled());
    screen
      .getAllByRole("combobox")
      .forEach((select) => expect(select).toBeDisabled());
  });
});
