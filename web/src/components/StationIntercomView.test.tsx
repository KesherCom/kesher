import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StationIntercomView } from "./StationIntercomView";
const baseProps: ComponentProps<typeof StationIntercomView> = {
  connectionState: "connected",
  appData: {
    self: { id: "u1", username: "tim", roleId: "op" },
    users: [{ id: "u1", username: "tim", roleId: "op" }],
    roles: [{ id: "op", name: "Operator" }],
    rooms: [
      {
        id: "room-1",
        name: "Party Line 1",
        senderRoleIds: ["op"],
        receiverRoleIds: ["op"],
        forcedListenRoleIds: [],
      },
    ],
    broadcastGroups: [],
    ackEnabled: true,
    appVersion: { version: "dev", buildTimestamp: "2026-03-10" },
  },
  doLogout: vi.fn(),
  listenRoomIds: ["room-1"],
  talkRoomIds: ["room-1"],
  canRoleSendToRoom: () => true,
  canRoleReceiveFromRoom: () => true,
  toggleTalkRoom: vi.fn(),
  toggleListenRoom: vi.fn(),
  isReceivingRoom: () => false,
  isReceivingBroadcast: () => false,
  isReceivingDirect: () => false,
  broadcastPttPressed: null,
  startBroadcastPtt: vi.fn(),
  stopBroadcastPtt: vi.fn(),
  broadcastGroups: [],
  presence: [],
  roomListenerCounts: {},
  roleNameById: new Map([["op", "Operator"]]),
  lastDirectCallerUserId: null,
  directPttPressedUserId: null,
  startDirectPtt: vi.fn(),
  stopDirectPtt: vi.fn(),
  sendScopedSignal: vi.fn(),
  pttPressed: false,
  startPtt: vi.fn(),
  stopPtt: vi.fn(),
  voiceMode: "ptt",
  setAlwaysOn: vi.fn(),
  chatAndSignalPanel: null,
  showDebug: false,
  realtimeDebugBlock: null,
  enableDirectPpt: false,
  onEnableDirectPptChange: vi.fn(),
  enableDirectTabs: false,
  onEnableDirectTabsChange: vi.fn(),
  swapPttAndReplyButtons: false,
  onSwapPttAndReplyButtonsChange: vi.fn(),
  enableBackgroundAudioRecovery: true,
  onEnableBackgroundAudioRecoveryChange: vi.fn(),
  keepScreenAwake: false,
  onKeepScreenAwakeChange: vi.fn(),
  showVolumeControls: true,
  onShowVolumeControlsChange: vi.fn(),
  mediaSessionSupported: true,
  wakeLockSupported: true,
  wakeLockActive: false,
  isStandaloneDisplayMode: false,
  onChannelPptStart: vi.fn(),
  onChannelPptStop: vi.fn(),
  pptPressedChannelId: null,
  pinnedRoomIds: [],
  pinnedUserIds: [],
  showPinnedOnly: false,
  onTogglePinnedRoom: vi.fn(),
  onTogglePinnedUser: vi.fn(),
  onShowPinnedOnlyChange: vi.fn(),
  isUserSettingsOpen: false,
  setIsUserSettingsOpen: vi.fn(),
  roomGainById: {},
  directGainByUserId: {},
  onRoomGainChange: vi.fn(),
  onDirectGainChange: vi.fn(),
  keyboardShortcuts: { ptt: null, toggleAlwaysOn: null },
  onKeyboardShortcutsChange: vi.fn(),
  onRecordingShortcutChange: vi.fn(),
  inputDevices: [],
  selectedInputDeviceId: "",
  selectedMicLabel: "Default input",
  setSelectedInputDeviceId: vi.fn(),
  inputLevelDbFs: -60,
  inputGain: 1,
  inputClipping: false,
  onInputGainChange: vi.fn(),
  outputDevices: [],
  selectedOutputDeviceId: "",
  selectedOutputLabel: "Default output",
  outputSelectionSupported: false,
  setSelectedOutputDeviceId: vi.fn(),
  streamDeckSettings: {
    version: 1,
    gridColumns: 5,
    gridRows: 3,
    selectedPage: 0,
    pages: [{ page: 0, buttons: Array.from({ length: 15 }, (_, i) => ({ index: i })) }],
  },
  streamDeckBusy: false,
  streamDeckError: "",
  onStreamDeckSettingsChange: vi.fn(),
  onSaveStreamDeckSettings: vi.fn(),
  onResetStreamDeckSettings: vi.fn(),
  streamDeckBridgeConnected: false,
  streamDeckBridgeLastEvent: "",
};

describe("StationIntercomView", () => {
  it("toggles always-on from the switch control", async () => {
    const user = userEvent.setup();
    const setAlwaysOn = vi.fn();

    render(<StationIntercomView {...baseProps} setAlwaysOn={setAlwaysOn} />);

    const alwaysOnSwitch = screen.getByRole("switch", { name: "Always on" });
    expect(alwaysOnSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(alwaysOnSwitch);

    expect(setAlwaysOn).toHaveBeenCalledWith(true);
    expect(setAlwaysOn).toHaveBeenCalledTimes(1);
  });

  it("turns always-on off from the same switch without double-toggling", async () => {
    const user = userEvent.setup();
    const setAlwaysOn = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        voiceMode="always_on"
        setAlwaysOn={setAlwaysOn}
      />,
    );

    const alwaysOnSwitch = screen.getByRole("switch", { name: "Always on" });
    expect(alwaysOnSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(alwaysOnSwitch);

    expect(setAlwaysOn).toHaveBeenCalledWith(false);
    expect(setAlwaysOn).toHaveBeenCalledTimes(1);
  });

  it("renders hold to talk before reply when swapping is enabled", () => {
    const { container } = render(
      <StationIntercomView {...baseProps} swapPttAndReplyButtons />,
    );

    const controls = container.querySelector(".station-controls");
    expect(controls).not.toBeNull();

    const buttonTexts = Array.from(
      controls!.querySelectorAll("button"),
      (button) => button.textContent ?? "",
    );

    expect(buttonTexts[0]).toContain("Hold to talk");
    expect(buttonTexts[1]).toContain("Reply to caller");
  });

  it("renders reply before hold to talk by default", () => {
    const { container } = render(<StationIntercomView {...baseProps} />);

    const controls = container.querySelector(".station-controls");
    expect(controls).not.toBeNull();

    const buttonTexts = Array.from(
      controls!.querySelectorAll("button"),
      (button) => button.textContent ?? "",
    );

    expect(buttonTexts[0]).toContain("Reply to caller");
    expect(buttonTexts[1]).toContain("Hold to talk");
  });

  it("renders the action controls inside the top header", () => {
    const { container } = render(<StationIntercomView {...baseProps} />);

    const header = container.querySelector(".station-header");
    const controls = container.querySelector(".station-controls");
    const contentGrid = container.querySelector(".station-content-grid");

    expect(header).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(contentGrid).not.toBeNull();
    expect(header!.contains(controls!)).toBe(true);
    expect(
      header!.compareDocumentPosition(contentGrid!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("updates the swap setting from the user settings modal", async () => {
    const user = userEvent.setup();
    const onSwapPttAndReplyButtonsChange = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSwapPttAndReplyButtonsChange={onSwapPttAndReplyButtonsChange}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Swap PTT and reply buttons" }),
    );

    expect(onSwapPttAndReplyButtonsChange).toHaveBeenCalledWith(true);
  });

  it("renders chat content in a dedicated secondary column when provided", () => {
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        chatAndSignalPanel={<div>Chat content</div>}
      />,
    );

    const secondaryColumn = container.querySelector(
      ".station-secondary-column",
    );

    expect(secondaryColumn).not.toBeNull();
    expect(secondaryColumn).toHaveTextContent("Chat");
    expect(secondaryColumn).toHaveTextContent("Chat content");
  });

  it("keeps hold-to-talk active when the pointer moves away before release", () => {
    const startPtt = vi.fn();
    const stopPtt = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        startPtt={startPtt}
        stopPtt={stopPtt}
      />,
    );

    const holdButton = screen.getByRole("button", { name: "Hold to talk" });
    let capturedPointerId: number | null = null;

    Object.defineProperties(holdButton, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          capturedPointerId = pointerId;
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointerId === pointerId,
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          if (capturedPointerId === pointerId) {
            capturedPointerId = null;
          }
        },
      },
    });

    fireEvent.pointerDown(holdButton, {
      button: 0,
      pointerId: 12,
      pointerType: "touch",
    });
    fireEvent.pointerLeave(holdButton, { pointerId: 12, pointerType: "touch" });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).not.toHaveBeenCalled();

    fireEvent.pointerUp(holdButton, { pointerId: 12, pointerType: "touch" });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("allows assigning reply-to-caller in stream deck settings", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("Stream Deck function"),
      "reply_to_caller",
    );

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("triggers save from stream deck settings header", async () => {
    const user = userEvent.setup();
    const onSaveStreamDeckSettings = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveStreamDeckSettings).toHaveBeenCalledTimes(1);
  });
});
