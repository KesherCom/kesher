import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminRoutingMatrixCard } from "./AdminRoutingMatrixCard";
import type { Bootstrap } from "../../types";
import { updateRoutingMatrix } from "../../api";

vi.mock("../../api", () => ({
  updateRoutingMatrix: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "admin", roleId: "op" },
  users: [{ id: "u1", username: "admin", roleId: "op" }],
  roles: [
    { id: "audio", name: "Audio" },
    { id: "video", name: "Video" },
  ],
  rooms: [
    {
      id: "foh",
      name: "FOH",
      senderRoleIds: ["audio"],
      receiverRoleIds: ["audio", "video"],
      forcedListenRoleIds: [],
    },
    {
      id: "stage",
      name: "Stage",
      senderRoleIds: [],
      receiverRoleIds: ["video"],
      forcedListenRoleIds: [],
    },
  ],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

describe("AdminRoutingMatrixCard", () => {
  it("is visible by default and can be collapsed", async () => {
    const user = userEvent.setup();
    render(
      <AdminRoutingMatrixCard
        token="tok"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    // Initially expanded
    expect(screen.getByRole("grid")).toBeVisible();
    // header corner should mention party line instead of room
    expect(screen.getByText("Role ╲ Party Line")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("renders correct initial toggle states", () => {
    render(
      <AdminRoutingMatrixCard
        token="tok"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    // Audio can talk on FOH (active)
    const audioFohTalk = screen.getByLabelText("Talk Audio → FOH: on");
    expect(audioFohTalk).toHaveClass("active");

    // Audio can listen on FOH (active)
    const audioFohListen = screen.getByLabelText("Listen Audio → FOH: on");
    expect(audioFohListen).toHaveClass("active");

    // Video cannot talk on FOH (inactive)
    const videoFohTalk = screen.getByLabelText("Talk Video → FOH: off");
    expect(videoFohTalk).not.toHaveClass("active");

    // Video can listen on FOH (active)
    const videoFohListen = screen.getByLabelText("Listen Video → FOH: on");
    expect(videoFohListen).toHaveClass("active");

    // Audio cannot talk on Stage (inactive)
    const audioStageTalk = screen.getByLabelText("Talk Audio → Stage: off");
    expect(audioStageTalk).not.toHaveClass("active");
  });

  it("toggling a cell shows save/discard buttons and saves changes", async () => {
    const user = userEvent.setup();
    const refreshBootstrapData = vi.fn().mockResolvedValue(undefined);

    render(
      <AdminRoutingMatrixCard
        token="tok"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />,
    );

    // No save button initially
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();

    // Toggle Video talk on FOH
    const videoFohTalk = screen.getByLabelText("Talk Video → FOH: off");
    await user.click(videoFohTalk);

    // The label should now say "on"
    expect(
      screen.getByLabelText("Talk Video → FOH: on"),
    ).toBeInTheDocument();

    // Save/Discard buttons should appear
    expect(screen.getByText("Save changes")).toBeVisible();
    expect(screen.getByText("Discard")).toBeVisible();

    // Click save
    await user.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(updateRoutingMatrix).toHaveBeenCalledWith(
        "tok",
        "1234",
        expect.arrayContaining([
          expect.objectContaining({
            roomId: "foh",
            senderRoleIds: expect.arrayContaining(["audio", "video"]),
          }),
        ]),
      );
      expect(refreshBootstrapData).toHaveBeenCalled();
    });
  });

  it("discard resets changes", async () => {
    const user = userEvent.setup();
    render(
      <AdminRoutingMatrixCard
        token="tok"
        adminPin="1234"
        appData={appData}
        refreshBootstrapData={vi.fn()}
      />,
    );

    // Toggle Audio talk on Stage (off→on)
    const audioStageTalk = screen.getByLabelText("Talk Audio → Stage: off");
    await user.click(audioStageTalk);

    // Now discard
    await user.click(screen.getByText("Discard"));

    // Should be back to off
    expect(
      screen.getByLabelText("Talk Audio → Stage: off"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("renders nothing if no roles or rooms", () => {
    const emptyData: Bootstrap = {
      ...appData,
      roles: [],
      rooms: [],
    };
    const { container } = render(
      <AdminRoutingMatrixCard
        token="tok"
        adminPin="1234"
        appData={emptyData}
        refreshBootstrapData={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
