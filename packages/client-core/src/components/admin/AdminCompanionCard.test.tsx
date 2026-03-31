import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminCompanionCard } from "./AdminCompanionCard";
import type { Bootstrap } from "../../types";
import {
  getCompanionAdminSummary,
  publishCompanionProfile,
} from "../../api";

vi.mock("../../api", () => ({
  getCompanionAdminSummary: vi.fn(),
  publishCompanionProfile: vi.fn(),
}));

const appData: Bootstrap = {
  self: { id: "u1", username: "regie", roleId: "regie" },
  users: [{ id: "u1", username: "regie", roleId: "regie" }],
  roles: [
    { id: "regie", name: "Regie" },
    { id: "stage", name: "Stage" },
  ],
  rooms: [],
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-20" },
};

describe("AdminCompanionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads summary and shows published profile info", async () => {
    vi.mocked(getCompanionAdminSummary).mockResolvedValue({
      sharedSecret: "topsecret",
      publishedProfiles: [
        {
          roleId: "regie",
          username: "regie",
          profileVersion: 3,
          profileStatus: "published",
          profileUpdatedAt: 1742460000000,
        },
      ],
    });
    const user = userEvent.setup();

    render(
      <AdminCompanionCard token="token-123" adminPin="1234" appData={appData} />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));

    await waitFor(() => {
      expect(getCompanionAdminSummary).toHaveBeenCalledWith("token-123", "1234");
    });

    expect(screen.getByDisplayValue("topsecret")).toBeVisible();
    expect(screen.getByText(/Published profiles \(1\)/)).toBeVisible();
    expect(
      screen.getByText(/Selected role regie is currently on version 3\./),
    ).toBeVisible();
  });

  it("publishes the selected role", async () => {
    vi.mocked(getCompanionAdminSummary)
      .mockResolvedValueOnce({ sharedSecret: "", publishedProfiles: [] })
      .mockResolvedValueOnce({
        sharedSecret: "",
        publishedProfiles: [
          {
            roleId: "stage",
            username: "stage-op",
            profileVersion: 1,
            profileStatus: "published",
            profileUpdatedAt: 1742460000000,
          },
        ],
      });
    vi.mocked(publishCompanionProfile).mockResolvedValue({
      roleId: "stage",
      username: "stage-op",
      profileVersion: 1,
      profileStatus: "published",
      profileUpdatedAt: 1742460000000,
    });
    const user = userEvent.setup();

    render(
      <AdminCompanionCard token="token-123" adminPin="1234" appData={appData} />,
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => {
      expect(getCompanionAdminSummary).toHaveBeenCalled();
    });

    await user.selectOptions(
      screen.getByLabelText("Companion target role"),
      "stage",
    );
    await user.click(screen.getByRole("button", { name: "Publish to Companion" }));

    await waitFor(() => {
      expect(publishCompanionProfile).toHaveBeenCalledWith(
        "token-123",
        "1234",
        "stage",
      );
    });
    expect(screen.getByText("Published stage as version 1.")).toBeVisible();
  });
});