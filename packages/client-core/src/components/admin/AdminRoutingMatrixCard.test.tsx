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

    // One cell per role and party line, in plain words.
    expect(
      screen.getByLabelText("Audio on FOH: can talk, can switch listening on"),
    ).toHaveTextContent("TalkHear");
    expect(
      screen.getByLabelText("Video on FOH: can switch listening on"),
    ).toHaveTextContent("Hear");
    expect(
      screen.getByLabelText("Audio on Stage: no access"),
    ).toHaveTextContent("–");
    expect(
      screen.getByLabelText("Video on Stage: can switch listening on"),
    ).toBeInTheDocument();
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

    // Video on FOH: can hear → always hears → can talk, can hear
    await user.click(
      screen.getByLabelText("Video on FOH: can switch listening on"),
    );
    expect(
      screen.getByLabelText("Video on FOH: always hears"),
    ).toHaveTextContent("Always");
    await user.click(screen.getByLabelText("Video on FOH: always hears"));
    expect(
      screen.getByLabelText("Video on FOH: can talk, can switch listening on"),
    ).toHaveClass("changed");

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

    await user.click(screen.getByLabelText("Audio on Stage: no access"));
    expect(screen.getByLabelText("Audio on Stage: can switch listening on")).toBeInTheDocument();

    await user.click(screen.getByText("Discard"));

    expect(
      screen.getByLabelText("Audio on Stage: no access"),
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
