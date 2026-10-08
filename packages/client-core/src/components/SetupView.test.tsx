import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SetupView } from "./SetupView";
import { completeSetup } from "../api";
import type { PublicBootstrap } from "../types";

vi.mock("../api", () => ({
  completeSetup: vi.fn().mockResolvedValue(undefined),
}));

const publicData: PublicBootstrap = {
  roles: [{ id: "audio", name: "Audio" }],
  rooms: [{ id: "foh", name: "FOH", senderRoleIds: [], receiverRoleIds: [], forcedListenRoleIds: [] }],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "" },
  setupRequired: true,
};

describe("SetupView", () => {
  it("needs a matching PIN of at least 4 characters", async () => {
    const user = userEvent.setup();
    render(<SetupView publicData={publicData} onDone={vi.fn()} />);
    const finish = screen.getByRole("button", { name: "Finish setup" });
    await user.type(screen.getByLabelText("Admin PIN"), "12");
    expect(screen.getByText("At least 4 characters, no spaces.")).toBeVisible();
    await user.type(screen.getByLabelText("Admin PIN"), "34");
    await user.type(screen.getByLabelText("Repeat the PIN"), "1235");
    expect(screen.getByText("The two PINs differ.")).toBeVisible();
    expect(finish).toBeDisabled();
  });

  it("submits PIN and start choice, then hands the PIN on", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<SetupView publicData={publicData} onDone={onDone} />);
    expect(screen.getByText(/Roles: Audio\. Party lines: FOH\./)).toBeVisible();
    await user.type(screen.getByLabelText("Admin PIN"), "4711");
    await user.type(screen.getByLabelText("Repeat the PIN"), "4711");
    await user.click(screen.getByRole("radio", { name: /Empty/ }));
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(completeSetup).toHaveBeenCalledWith("4711", "empty"));
    expect(onDone).toHaveBeenCalledWith("4711");
  });
});
