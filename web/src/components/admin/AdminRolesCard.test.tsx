import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminRolesCard } from "./AdminRolesCard";
import type { Bootstrap } from "../../types";
import { createRole, updateRole } from "../../api";

vi.mock("../../api", () => ({
  createRole: vi.fn().mockResolvedValue(undefined),
  updateRole: vi.fn().mockResolvedValue(undefined),
  deleteRole: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [{ id: "u1", username: "tim", roleId: "op" }],
  roles: [{ id: "op", name: "Operator", defaultVoiceMode: "always_on" }],
  rooms: [
    {
      id: "r1",
      name: "Party Line 1",
      senderRoleIds: ["op"],
      receiverRoleIds: ["op"],
      forcedListenRoleIds: [],
    },
  ],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

describe("AdminRolesCard", () => {
  it("toggles open/closed body", async () => {
    const user = userEvent.setup();
    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: /Roles/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("heading", { name: "Roles (1)" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(
      screen.queryByRole("heading", { name: "Roles (1)" }),
    ).not.toBeInTheDocument();
  });

  it("creates a role and refreshes bootstrap", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Create role" }));
    await user.type(screen.getByPlaceholderText("role-id"), "editor");
    await user.type(screen.getByPlaceholderText("Role name"), "Editor");
    await user.click(screen.getByRole("button", { name: "Create role" }));

    await waitFor(() => {
      expect(createRole).toHaveBeenCalledWith(
        "token-123",
        "1234",
        expect.objectContaining({ id: "editor", name: "Editor" }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });

  it("opens edit form and saves role changes", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRolesCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const roleNameInput = screen.getByDisplayValue("Operator");
    await user.clear(roleNameInput);
    await user.type(roleNameInput, "Operator Team");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateRole).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "op",
        expect.objectContaining({ name: "Operator Team" }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });
});
