import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminChannelsCard } from "./AdminChannelsCard";
import type { Bootstrap } from "../../types";
import { deleteBroadcastGroup, updateBroadcastGroup } from "../../api";

vi.mock("../../api", () => ({
  createBroadcastGroup: vi.fn().mockResolvedValue(undefined),
  updateBroadcastGroup: vi.fn().mockResolvedValue(undefined),
  deleteBroadcastGroup: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "tim", roleId: "op" },
  users: [{ id: "u1", username: "tim", roleId: "op" }],
  roles: [{ id: "op", name: "Operator" }],
  rooms: [
    {
      id: "r1",
      name: "Party Line 1",
      senderRoleIds: ["op"],
      receiverRoleIds: ["op"],
      forcedListenRoleIds: [],
    },
  ],
  broadcastGroups: [
    { id: "bg1", name: "All Call", roomIds: ["r1"], allowedRoleIds: ["op"] },
  ],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

describe("AdminChannelsCard", () => {
  it("shows create channel action disabled until required values are complete", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelsCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    const createButton = screen.getByRole("button", { name: "Create channel" });
    expect(createButton).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText("broadcast-channel-id"),
      "program",
    );
    await user.type(
      screen.getByPlaceholderText("Broadcast channel name"),
      "Program",
    );

    expect(createButton).toBeDisabled();
  });

  it("edits a broadcast channel and saves changes", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);
    render(
      <AdminChannelsCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const channelNameInput = screen.getByDisplayValue("All Call");
    await user.clear(channelNameInput);
    await user.type(channelNameInput, "Stage Call");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateBroadcastGroup).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "bg1",
        expect.objectContaining({
          name: "Stage Call",
          roomIds: ["r1"],
          allowedRoleIds: ["op"],
        }),
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });

  it("deletes a broadcast channel", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);
    render(
      <AdminChannelsCard
        token="token-123"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteBroadcastGroup).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "bg1",
      );
    });
    expect(refreshBootstrapData).toHaveBeenCalledTimes(1);
  });
});
