import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminMenu } from "./AdminMenu";
import type { Bootstrap } from "../../types";
import type { AdminLiveData } from "./useAdminLiveData";

const live: AdminLiveData = {
  users: [
    { id: "u2", username: "anna", roleId: "op", online: true },
    { id: "u3", username: "ben", roleId: "op", online: false },
  ],
  devices: [
    {
      id: "d1",
      name: "stage-left",
      hostname: "pi",
      model: "Raspberry Pi 5",
      version: "1.0",
      status: "pending",
      roleId: "",
      mode: "ptt",
      lastIp: "10.0.0.9",
      createdAt: 0,
      lastSeenAt: 0,
      online: false,
    },
  ],
  decks: [],
  stats: null,
  roomListenerCounts: { r1: 2 },
  error: "",
  loaded: true,
};

vi.mock("./useAdminLiveData", () => ({
  useAdminLiveData: () => ({ data: live, reload: vi.fn() }),
  serverWarnings: () => [],
}));

// The cards have their own tests; here only which section shows which card.
vi.mock("./AdminPinCard", () => ({ AdminPinCard: () => <div data-testid="admin-pin-card" /> }));
vi.mock("./AdminMonitoringCard", () => ({ AdminMonitoringCard: () => <div data-testid="admin-monitoring-card" /> }));
vi.mock("./AdminRolesCard", () => ({ AdminRolesCard: () => <div data-testid="admin-roles-card" /> }));
vi.mock("./AdminRoomsCard", () => ({ AdminRoomsCard: () => <div data-testid="admin-rooms-card" /> }));
vi.mock("./AdminChannelsCard", () => ({ AdminChannelsCard: () => <div data-testid="admin-channels-card" /> }));
vi.mock("./AdminUsersCard", () => ({ AdminUsersCard: () => <div data-testid="admin-users-card" /> }));
vi.mock("./AdminRoutingMatrixCard", () => ({ AdminRoutingMatrixCard: () => <div data-testid="admin-matrix-card" /> }));
vi.mock("./AdminDevicesCard", () => ({ AdminDevicesCard: () => <div data-testid="admin-devices-card" /> }));
vi.mock("./AdminStreamDecksCard", () => ({ AdminStreamDecksCard: () => <div data-testid="admin-decks-card" /> }));
vi.mock("./AdminCompanionCard", () => ({ AdminCompanionCard: () => <div /> }));
vi.mock("./AdminStreamDeckCard", () => ({ AdminStreamDeckCard: () => <div /> }));
vi.mock("./AdminCompanionPageConfigCard", () => ({ AdminCompanionPageConfigCard: () => <div /> }));
vi.mock("./AdminShowfileCard", () => ({ AdminShowfileCard: () => <div data-testid="admin-showfile-card" /> }));
vi.mock("./AdminTelegramCard", () => ({ AdminTelegramCard: () => <div /> }));
vi.mock("./AdminTelegramUsersCard", () => ({ AdminTelegramUsersCard: () => <div /> }));
vi.mock("./AdminLogsCard", () => ({ AdminLogsCard: () => <div /> }));
vi.mock("./AdminChatHistoryCard", () => ({ AdminChatHistoryCard: () => <div /> }));

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
  broadcastGroups: [],
  ackEnabled: true,
  appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
};

const props = {
  appData,
  refreshBootstrapData: vi.fn(),
  adminPin: "1234",
  onUpdateAdminPin: vi.fn().mockResolvedValue(undefined),
  audioStats: { inKbps: 1, outKbps: 2, jitterMs: 3, roundTripMs: 4, playoutDelayMs: 5 },
  activeRoutesCount: 0,
};

describe("AdminMenu", () => {
  beforeEach(() => localStorage.clear());

  it("renders nothing without token", () => {
    const { container } = render(<AdminMenu token={null} {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts on Live with who is online and what needs attention", () => {
    render(<AdminMenu token="token-123" {...props} />);
    expect(screen.getByRole("button", { name: /Live/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("anna")).toBeVisible();
    expect(screen.getByRole("button", { name: "Mute mic" })).toBeVisible();
    expect(screen.getByText("1 waiting for approval")).toBeVisible();
    expect(screen.getByText("2 listeners")).toBeVisible();
    // A pending station shows as a badge on Devices.
    expect(screen.getByRole("button", { name: /Devices\s*1/ })).toBeVisible();
  });

  it("switches sections and remembers the choice", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AdminMenu token="token-123" {...props} />);
    await user.click(screen.getByRole("button", { name: /Setup/ }));
    expect(screen.getByTestId("admin-matrix-card")).toBeVisible();
    expect(screen.getByTestId("admin-roles-card")).toBeVisible();
    expect(screen.queryByTestId("admin-devices-card")).not.toBeInTheDocument();
    unmount();

    render(<AdminMenu token="token-123" {...props} />);
    expect(screen.getByTestId("admin-rooms-card")).toBeVisible();
  });

  it("opens Devices from the stations tile", async () => {
    const user = userEvent.setup();
    render(<AdminMenu token="token-123" {...props} />);
    await user.click(screen.getByRole("button", { name: /stations online/ }));
    expect(screen.getByTestId("admin-devices-card")).toBeVisible();
    expect(screen.getByTestId("admin-decks-card")).toBeVisible();
  });
});
