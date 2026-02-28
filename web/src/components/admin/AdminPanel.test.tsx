import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminPanel } from "./AdminPanel";
import type { Bootstrap } from "../../types";

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [
    { id: "u1", username: "tim", roleId: "op" },
    { id: "u2", username: "admin", roleId: "admin" },
  ],
  roles: [{ id: "op", name: "Operator" }],
  rooms: [
    {
      id: "r1",
      name: "Room 1",
      senderRoleIds: ["op"],
      receiverRoleIds: ["op"],
      forcedListenRoleIds: [],
    },
  ],
  broadcastGroups: [
    { id: "bg1", name: "All", roomIds: ["r1"], allowedRoleIds: ["op"] },
  ],
};

describe("AdminPanel", () => {
  it("shows roles section by default and hides heading when configured", () => {
    render(
      <AdminPanel
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
        showHeading={false}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "Admin · configuration" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Roles" })).toBeVisible();
  });

  it("switches sections from inline nav buttons", async () => {
    const user = userEvent.setup();
    render(
      <AdminPanel
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Rooms/i }));
    expect(screen.getByRole("heading", { name: "Rooms" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Channels/i }));
    expect(
      screen.getByRole("heading", { name: "Broadcast channels" }),
    ).toBeVisible();
  });

  it("respects externally controlled active section", () => {
    const { rerender } = render(
      <AdminPanel
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
        activeSection="users"
      />,
    );

    expect(screen.getByRole("heading", { name: "Users" })).toBeVisible();

    rerender(
      <AdminPanel
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
        activeSection="roles"
      />,
    );

    expect(screen.getByRole("heading", { name: "Roles" })).toBeVisible();
  });
});
