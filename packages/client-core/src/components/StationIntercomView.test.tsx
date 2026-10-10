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
  outputSelectionSupported: false,
  setSelectedOutputDeviceId: vi.fn(),
  streamDeckSettings: {
    version: 1,
    gridColumns: 5,
    gridRows: 3,
    selectedPage: 0,
    pages: [
      {
        page: 0,
        buttons: Array.from({ length: 15 }, (_, i) => ({ index: i })),
      },
    ],
  },
  streamDeckBusy: false,
  streamDeckError: "",
  onStreamDeckSettingsChange: vi.fn(),
  streamDeckSaveState: "saved" as const,
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

    await user.click(screen.getByRole("button", { name: /Controls/ }));
    await user.click(
      screen.getByRole("checkbox", { name: "Talk button first" }),
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
    render(<StationIntercomView {...baseProps} isUserSettingsOpen />);

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.getByRole("option", { name: "Mic gain + / −" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Page up" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Add page" }));

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

    await user.click(screen.getByRole("button", { name: "Remove page" }));

    const removeArg = onStreamDeckSettingsChange.mock.calls[1]?.[0];
    expect(removeArg?.pages?.length).toBe(1);
    expect(removeArg?.selectedPage).toBe(0);

    expect(onStreamDeckSettingsChange).toHaveBeenCalledTimes(2);
  });

  it("shows that the layout saves itself and offers a retry after an error", async () => {
    const user = userEvent.setup();
    const onSaveStreamDeckSettings = vi.fn();
    const { rerender } = render(
      <StationIntercomView {...baseProps} isUserSettingsOpen />,
    );

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));
    expect(screen.getByText("All changes saved")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();

    rerender(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        streamDeckSaveState="error"
        streamDeckError="server unreachable"
        onSaveStreamDeckSettings={onSaveStreamDeckSettings}
      />,
    );
    expect(screen.getByText("Not saved")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onSaveStreamDeckSettings).toHaveBeenCalledTimes(1);
  });

  it("edits a key's second line and frame color, keeping the automatic name", async () => {
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
              ? {
                  index: 0,
                  action: { type: "ptt_room" as const, roomId: "room-1" },
                }
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

    const name = screen.getByRole("textbox", { name: "Key name" });
    expect(name).toHaveAttribute("placeholder", "Automatic: Party Line 1");

    await user.type(
      screen.getByRole("textbox", { name: "Key second line" }),
      "S",
    );
    const typed = onStreamDeckSettingsChange.mock.calls.at(-1)?.[0];
    expect(typed?.pages[0].buttons[0].label).toBe("\nS");

    await user.click(screen.getByRole("radio", { name: "Violet" }));
    const colored = onStreamDeckSettingsChange.mock.calls.at(-1)?.[0];
    expect(colored?.pages[0].buttons[0].color).toBe("#8b5cf6");
  });

  it("switches pages with the page tabs", async () => {
    const user = userEvent.setup();
    const onStreamDeckSettingsChange = vi.fn();
    const streamDeckSettings: StreamDeckSettings = {
      version: 1,
      gridColumns: 5,
      gridRows: 3,
      selectedPage: 0,
      pages: [0, 1].map((page) => ({
        page,
        title: page === 1 ? "Cameras" : "",
        buttons: Array.from({ length: 15 }, (_, i) => ({ index: i })),
      })),
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

    expect(screen.getByRole("tab", { name: "Page 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Cameras" }));
    expect(onStreamDeckSettingsChange.mock.calls.at(-1)?.[0].selectedPage).toBe(
      1,
    );
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
    await user.click(screen.getByText("More"));
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

    const file = new File(
      [JSON.stringify(importedSettings)],
      "streamdeck.json",
      {
        type: "application/json",
      },
    );

    await user.upload(input!, file);

    expect(onStreamDeckSettingsChange).toHaveBeenCalled();
    const streamDeckCalls = onStreamDeckSettingsChange.mock.calls;
    const lastCallArg = streamDeckCalls[streamDeckCalls.length - 1]?.[0];
    expect(lastCallArg?.pages?.[0]?.buttons?.[0]?.action?.type).toBe(
      "reply_to_caller",
    );
  });

  it("shows the stream deck editor on its own settings page", async () => {
    const user = userEvent.setup();

    render(<StationIntercomView {...baseProps} isUserSettingsOpen />);

    // Sound is the first page.
    expect(screen.getByRole("button", { name: /Sound/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Stream Deck/ }));

    expect(
      screen.getByRole("grid", { name: "Stream Deck 5x3 grid" }),
    ).toBeInTheDocument();
  });

  it("closes the settings with Escape", async () => {
    const user = userEvent.setup();
    const setIsUserSettingsOpen = vi.fn();
    render(
      <StationIntercomView
        {...baseProps}
        isUserSettingsOpen
        setIsUserSettingsOpen={setIsUserSettingsOpen}
      />,
    );
    await user.keyboard("{Escape}");
    expect(setIsUserSettingsOpen).toHaveBeenCalledWith(false);
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
    await user.click(screen.getByRole("button", { name: "Try keys here" }));

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

    await user.click(screen.getByRole("checkbox", { name: "Noise gate" }));
    fireEvent.change(
      screen.getByRole("slider", { name: "Microphone gate threshold" }),
      { target: { value: "-40" } },
    );

    expect(onAudioGateEnabledChange).toHaveBeenCalledWith(false);
    expect(onAudioGateThresholdDbChange).toHaveBeenCalledWith(-40);
  });

  it("shows who is talking on a party line", () => {
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        roomTalkers={(roomId) => (roomId === "room-1" ? ["Ben", "Tom"] : [])}
      />,
    );
    expect(screen.getByText("Ben, Tom are talking")).toBeVisible();
    expect(
      container.querySelector(".station-card.is-receiving"),
    ).not.toBeNull();
  });

  it("shows microphone problems in the header and opens sound settings", async () => {
    const user = userEvent.setup();
    const setIsUserSettingsOpen = vi.fn();
    const { rerender } = render(
      <StationIntercomView
        {...baseProps}
        audioError="Permission denied"
        setIsUserSettingsOpen={setIsUserSettingsOpen}
      />,
    );
    const mic = screen.getByRole("button", {
      name: /Microphone: Permission denied/,
    });
    expect(mic).toHaveTextContent("Mic problem");
    await user.click(mic);
    expect(setIsUserSettingsOpen).toHaveBeenCalledWith(true);
    rerender(
      <StationIntercomView
        {...baseProps}
        audioError="Permission denied"
        isUserSettingsOpen
        setIsUserSettingsOpen={setIsUserSettingsOpen}
      />,
    );
    // Settings open on the sound page.
    expect(screen.getByRole("button", { name: /Sound/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens a party line fader from its dB value; double-click resets to 0 dB", async () => {
    const user = userEvent.setup();
    const onRoomGainChange = vi.fn();
    const { container } = render(
      <StationIntercomView
        {...baseProps}
        onRoomGainChange={onRoomGainChange}
      />,
    );
    expect(container.querySelector("#room-gain-room-1")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Volume Party Line 1: 0 dB" }),
    );
    const fader =
      container.querySelector<HTMLInputElement>("#room-gain-room-1");
    expect(fader).not.toBeNull();
    fireEvent.doubleClick(fader!);
    expect(onRoomGainChange).toHaveBeenCalledWith("room-1", 1);
  });
});
