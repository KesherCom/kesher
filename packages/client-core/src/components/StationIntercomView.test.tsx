import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StationIntercomView } from "./StationIntercomView";
import type { StreamDeckSettings } from "../types";
const baseProps: ComponentProps<typeof StationIntercomView> = {
  token: "test-token",
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
  isLocalMonitorActive: false,
  onToggleLocalMonitor: vi.fn(),
  onInputGainChange: vi.fn(),
  audioGateEnabled: false,
  onAudioGateEnabledChange: vi.fn(),
  audioGateThresholdDb: -52,
  onAudioGateThresholdDbChange: vi.fn(),
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
  onPublishCompanionProfile: vi.fn().mockResolvedValue({
    roleId: "op",
    username: "tim",
    profileVersion: 1,
    profileStatus: "active",
  }),
  streamDeckWebHidSupported: true,
  streamDeckWebHidActive: false,
  streamDeckWebHidBusy: false,
  onConnectStreamDeckWebHid: vi.fn(),
  onDisconnectStreamDeckWebHid: vi.fn(),
  streamDeckBridgeConnected: false,
  streamDeckBridgeLastEvent: "",
  lastCompanionCommand: null,
  onStreamDeckTestButtonEvent: vi.fn(),
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

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

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

  it("allows assigning select+listen channel action in stream deck settings", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    await user.selectOptions(
      screen.getByLabelText("Stream Deck function"),
      "select_listen_room",
    );

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "select_listen_room",
    );
  });

  it("offers stream deck navigation and folder functions in user settings", async () => {
    const user = userEvent.setup();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.getByRole("option", { name: "Volume +/-" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Page up" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Page down" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Open page / folder" }),
    ).toBeInTheDocument();
  });

  it("copies and pastes a stream deck button configuration", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const streamDeckSettings: StreamDeckSettings = {
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [
        {
          page: 0,
          buttons: Array.from({ length: 15 }, (_, i) =>
            i === 0
              ? { index: 0, action: { type: "reply_to_caller" as const } }
              : { index: i },
          ),
        },
      ],
    };
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={streamDeckSettings}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(screen.getByRole("button", { name: "Deck key 2" }));
    await user.click(screen.getByRole("button", { name: "Paste" }));

    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[1]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("undoes the last stream deck button change", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const { rerender } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.selectOptions(
      screen.getByLabelText("Stream Deck function"),
      "reply_to_caller",
    );

    const changedSettings = onStreamDeckSettingsChange.mock.calls[0]?.[0];
    rerender(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={changedSettings}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    const undoCallArg = onStreamDeckSettingsChange.mock.calls[1]?.[0];
    expect(undoCallArg?.pages?.[0]?.buttons?.[0]?.action).toBeUndefined();
  });

  it("swaps stream deck buttons via drag and drop", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const streamDeckSettings: StreamDeckSettings = {
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [
        {
          page: 0,
          buttons: Array.from({ length: 15 }, (_, i) => {
            if (i === 0) {
              return { index: 0, action: { type: "reply_to_caller" as const } };
            }
            if (i === 1) {
              return { index: 1, action: { type: "page_up" as const } };
            }
            return { index: i };
          }),
        },
      ],
    };
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={streamDeckSettings}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    const keyOne = screen.getByRole("button", { name: "Deck key 1" });
    const keyTwo = screen.getByRole("button", { name: "Deck key 2" });

    fireEvent.dragStart(keyOne, {
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
        getData: vi.fn(),
      },
    });
    fireEvent.dragOver(keyTwo, {
      dataTransfer: {
        dropEffect: "",
      },
    });
    fireEvent.drop(keyTwo);

    const calls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe("page_up");
    expect(lastCallArg?.pages?.[0]?.buttons?.[1]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("adds and removes stream deck pages from toolbar buttons", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const { rerender } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    await user.click(screen.getByRole("button", { name: "+ Page" }));

    const addArg = onStreamDeckSettingsChange.mock.calls[0]?.[0];
    expect(addArg?.pages?.length).toBe(2);
    expect(addArg?.selectedPage).toBe(1);

    rerender(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSettings={addArg}
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "- Page" }));

    const removeArg = onStreamDeckSettingsChange.mock.calls[1]?.[0];
    expect(removeArg?.pages?.length).toBe(1);
    expect(removeArg?.selectedPage).toBe(0);

    expect(onStreamDeckSettingsChange).toHaveBeenCalledTimes(2);
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

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaveStreamDeckSettings).toHaveBeenCalledTimes(1);
  });

  it("exports stream deck settings as a JSON file", async () => {
    const user = userEvent.setup();
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:streamdeck-export");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    render(<StationIntercomView {...baseProps} isUserSettingsOpen />);

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:streamdeck-export");

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("imports stream deck settings from JSON and applies them", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckSettingsChange={onStreamDeckSettingsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    const input = container.querySelector(
      '[data-testid="streamdeck-import-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    const importedSettings = {
      meta: {
        format: "kesher-user-streamdeck",
        schemaVersion: 1,
        exportedAt: "2026-03-16T10:00:00Z",
        username: "tim",
      },
      settings: {
        version: 1,
        gridColumns: 5,
        gridRows: 3,
        selectedPage: 0,
        pages: [
          {
            page: 0,
            buttons: Array.from({ length: 15 }, (_, i) =>
              i === 0
                ? { index: 0, action: { type: "reply_to_caller" } }
                : { index: i },
            ),
          },
        ],
      },
    };

    const file = new File([JSON.stringify(importedSettings)], "streamdeck.json", {
      type: "application/json",
    });

    await user.upload(input!, file);

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const streamDeckCalls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = streamDeckCalls[streamDeckCalls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("collapses and expands stream deck settings", async () => {
    const user = userEvent.setup();

    render(<StationIntercomView {...baseProps} isUserSettingsOpen />);

    expect(
      screen.queryByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.getByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.queryByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).not.toBeInTheDocument();
  });

  it("emits down and up events in stream deck browser test mode", async () => {
    const user = userEvent.setup();
    const onStreamDeckTestButtonEvent = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        onStreamDeckTestButtonEvent={onStreamDeckTestButtonEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    await user.click(screen.getByRole("button", { name: "Test mode off" }));

    const key = screen.getByRole("button", {
      name: "Deck key 1",
    });

    fireEvent.pointerDown(key);
    fireEvent.pointerUp(key);

    expect(onStreamDeckTestButtonEvent).toHaveBeenNthCalledWith(1, {
      page: 0,
      buttonIndex: 0,
      state: "down",
    });
    expect(onStreamDeckTestButtonEvent).toHaveBeenNthCalledWith(2, {
      page: 0,
      buttonIndex: 0,
      state: "up",
    });
  });

  it("renders audio gate controls and dispatches changes", async () => {
    const user = userEvent.setup();
    const onAudioGateEnabledChange = vi.fn();
    const onAudioGateThresholdDbChange = vi.fn();

    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        audioGateEnabled
        onAudioGateEnabledChange={onAudioGateEnabledChange}
        onAudioGateThresholdDbChange={onAudioGateThresholdDbChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Sound settings/ }));
    await user.click(screen.getByRole("checkbox", { name: "Noise gate" }));
    fireEvent.change(
      screen.getByRole("slider", { name: "Microphone gate threshold" }),
      { target: { value: "-40" } },
    );

    expect(onAudioGateEnabledChange).toHaveBeenCalledWith(false);
    expect(onAudioGateThresholdDbChange).toHaveBeenCalledWith(-40);
  });
});
