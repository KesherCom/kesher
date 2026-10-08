import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminDevicesCard } from "./AdminDevicesCard";
import type { Bootstrap, Device } from "../../types";
import { getAdminDevices, updateAdminDevice } from "../../api";

vi.mock("../../api", () => ({
  getAdminDevices: vi.fn(),
  updateAdminDevice: vi.fn().mockResolvedValue(undefined),
  deleteAdminDevice: vi.fn().mockResolvedValue(undefined),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "admin", roleId: "" },
  users: [],
  roles: [
    { id: "audio", name: "Audio" },
    { id: "stage", name: "Stage" },
  ],
  rooms: [],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-10-08" },
};

const pendingDevice: Device = {
  id: "3f6c2a9e-1b7d-4c55-9f1e-0a2b3c4d5e6f",
  name: "stage-left",
  hostname: "stage-left",
  model: "Raspberry Pi 5",
  version: "0.9.0",
  status: "pending",
  roleId: "",
  mode: "ptt",
  lastIp: "192.168.1.50",
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  online: false,
};

describe("AdminDevicesCard", () => {
  it("opens for a waiting station and approves it with name, role and mode", async () => {
    vi.mocked(getAdminDevices).mockResolvedValue([pendingDevice]);
    const user = userEvent.setup();
    render(<AdminDevicesCard token="t" adminPin="1234" appData={appData} />);

    expect(await screen.findByText("Waiting for approval")).toBeVisible();
    expect(screen.getByText("1 new")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Role"), "stage");
    await user.selectOptions(screen.getByLabelText("Talk mode"), "always_on");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(updateAdminDevice).toHaveBeenCalledWith("t", "1234", pendingDevice.id, {
        name: "stage-left",
        roleId: "stage",
        mode: "always_on",
        status: "approved",
      }),
    );
  });

  it("lists approved stations with role and online state", async () => {
    vi.mocked(getAdminDevices).mockResolvedValue([
      { ...pendingDevice, status: "approved", roleId: "audio", online: true },
    ]);
    const user = userEvent.setup();
    render(<AdminDevicesCard token="t" adminPin="1234" appData={appData} />);
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("stage-left")).toBeVisible();
    expect(screen.getByText(/Audio · push to talk/)).toBeVisible();
    expect(screen.getByTitle("connected")).toBeInTheDocument();
  });
});
