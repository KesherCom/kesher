import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminRoomsCard } from "./AdminRoomsCard";
import type { Bootstrap } from "../../types";
import { createRoom, updateRoom } from "../../api";

vi.mock("../../api", () => ({
  createRoom: vi.fn().mockResolvedValue(undefined),
  updateRoom: vi.fn().mockResolvedValue(undefined),
  deleteRoom: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [{ id: "u1", username: "tim", roleId: "op" }],
  roles: [
    { id: "op", name: "Operator" },
    { id: "admin", name: "Admin" },
  ],
  rooms: [
    {
      id: "r1",
      name: "Party Line 1",
      senderRoleIds: ["op"],
      receiverRoleIds: ["admin"],
      forcedListenRoleIds: [],
    },
  ],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

describe("AdminRoomsCard", () => {
  it("toggles open and closed", async () => {
    const user = userEvent.setup();
    render(
      <AdminRoomsCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "Party Lines (1)" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("heading", { name: "Party Lines (1)" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(
      screen.queryByRole("heading", { name: "Party Lines (1)" }),
    ).not.toBeInTheDocument();
  });

  it("creates a room and refreshes bootstrap data", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRoomsCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Create party line" }));
    await user.type(screen.getByPlaceholderText("party-line-id"), "new-room");
    await user.type(screen.getByPlaceholderText("Party line name"), "New Room");
    await user.click(screen.getByRole("button", { name: "Create party line" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith(
        "token-123",
        "1234",
        expect.objectContaining({
          id: "new-room",
          name: "New Room",
          senderRoleIds: [],
          receiverRoleIds: [],
        }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });

  it("edits an existing room and saves changes", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRoomsCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const roomNameInput = screen.getByDisplayValue("Party Line 1");
    await user.clear(roomNameInput);
    await user.type(roomNameInput, "Main Stage");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateRoom).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "r1",
        expect.objectContaining({
          name: "Main Stage",
          senderRoleIds: ["op"],
          receiverRoleIds: ["admin"],
        }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });
});
