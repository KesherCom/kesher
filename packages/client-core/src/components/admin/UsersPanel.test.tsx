import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsersPanel } from "./UsersPanel";
import type { Bootstrap } from "../../types";
import { deleteUser, fetchAdminUsers } from "../../api";

vi.mock("../../api", () => ({
  fetchAdminUsers: vi.fn().mockResolvedValue([]),
  deleteUser: vi.fn().mockResolvedValue(undefined),
}));

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
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

describe("UsersPanel", () => {
  it("loads users and filters out admin", async () => {
    vi.mocked(fetchAdminUsers).mockResolvedValueOnce([
      { id: "u1", username: "tim", roleId: "op", online: true },
      { id: "admin", username: "admin", roleId: "admin", online: false },
      { id: "u2", username: "Alice", roleId: "op", online: false },
    ]);

    render(
      <UsersPanel
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => {
      expect(fetchAdminUsers).toHaveBeenCalledWith("token-123", "1234");
    });
    expect(screen.getByText("tim")).toBeVisible();
    expect(screen.getByText("Alice")).toBeVisible();
    expect(screen.queryByText("admin")).not.toBeInTheDocument();
  });

  it("disables delete for online users and allows delete for offline users", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchAdminUsers).mockResolvedValue([
      { id: "u1", username: "tim", roleId: "op", online: true },
      { id: "u2", username: "Alice", roleId: "op", online: false },
    ]);

    render(
      <UsersPanel
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("tim")).toBeVisible();
    });

    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    expect(deleteButtons[0]).toBeDisabled();
    expect(deleteButtons[1]).not.toBeDisabled();

    await user.click(deleteButtons[1]);
    await waitFor(() => {
      expect(deleteUser).toHaveBeenCalledWith("token-123", "1234", "u2");
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });
});
