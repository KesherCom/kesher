import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Bootstrap,
  BroadcastGroup,
  Presence,
  StreamDeckActionType,
  StreamDeckSettings,
} from "../types";
import type { KeyboardShortcutSettings } from "../app/settings";
import { createHoldButtonProps } from "../lib/holdButton";
import { sortDirectUsersByRoleAndUsername } from "../lib/users";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";

const DB_MIN = -60;
const DB_MAX = 6; // +6 dB ≈ gain 2.0
const MUTE_POS = DB_MIN - 1; // sentinel slider position for mute

/** Slider position (dB) → linear gain. Bottom-of-slider = mute. */
function sliderToGain(sliderDb: number): number {
  if (sliderDb <= MUTE_POS) return 0;
  return Math.pow(10, Math.max(DB_MIN, Math.min(DB_MAX, sliderDb)) / 20);
}

/** Linear gain → slider position (dB). */
function gainToSlider(gain: number): number {
  if (gain <= 0) return MUTE_POS;
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return MUTE_POS;
  return Math.round(Math.max(DB_MIN, Math.min(DB_MAX, db)));
}

/** Gain → display label like "+6 db", "0 db", "-∞". */
function gainToDbLabel(gain: number): string {
  if (gain <= 0) return "-\u221E";
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return "-\u221E";
  const r = Math.round(db);
  if (r === 0) return "0 db";
  return `${r > 0 ? "+" : ""}${r} db`;
}

/** Slider fill percentage for CSS background gradient. */
function sliderFillPercent(gain: number): number {
  const pos = gainToSlider(gain);
  return ((pos - MUTE_POS) / (DB_MAX - MUTE_POS)) * 100;
}

const METER_DBFS_MIN = -60;

function meterDbFsToPercent(dbFs: number): number {
  const clamped = Math.max(METER_DBFS_MIN, Math.min(0, dbFs));
  return ((clamped - METER_DBFS_MIN) / (0 - METER_DBFS_MIN)) * 100;
}

function formatDbFs(dbFs: number): string {
  if (!Number.isFinite(dbFs) || dbFs <= METER_DBFS_MIN) return "-∞ dBFS";
  if (Math.abs(dbFs) < 0.05) return "0.0 dBFS";
  return `${dbFs.toFixed(1)} dBFS`;
}

type StationIntercomViewProps = {
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  appData: Bootstrap;
  doLogout: () => void;
  listenRoomIds: string[];
  talkRoomIds: string[];
  canRoleSendToRoom: (roomId: string, currentRoleId: string) => boolean;
  canRoleReceiveFromRoom: (roomId: string, currentRoleId: string) => boolean;
  toggleTalkRoom: (roomId: string) => void;
  toggleListenRoom: (roomId: string) => void;
  isReceivingRoom: (roomId: string) => boolean;
  isReceivingBroadcast: (groupId: string) => boolean;
  isReceivingDirect: (userId: string) => boolean;
  broadcastPttPressed: string | null;
  startBroadcastPtt: (groupId: string) => void;
  stopBroadcastPtt: (groupId: string) => void;
  broadcastGroups: BroadcastGroup[];
  presence: Presence[];
  roomListenerCounts: Record<string, number>;
  roleNameById: Map<string, string>;
  lastDirectCallerUserId: string | null;
  directPttPressedUserId: string | null;
  startDirectPtt: (userId: string) => void;
  stopDirectPtt: (userId: string) => void;
  sendScopedSignal: (
    scopeValue: "direct" | "room" | "broadcast",
    scopedTargetId: string,
    signal: string,
  ) => void;
  pttPressed: boolean;
  startPtt: () => void;
  stopPtt: () => void;
  voiceMode: "always_on" | "ptt";
  setAlwaysOn: (enabled: boolean) => void;
  chatAndSignalPanel: React.ReactNode;
  showDebug: boolean;
  realtimeDebugBlock: React.ReactNode;
  enableDirectPpt: boolean;
  onEnableDirectPptChange: (enabled: boolean) => void;
  enableDirectTabs: boolean;
  onEnableDirectTabsChange: (enabled: boolean) => void;
  swapPttAndReplyButtons: boolean;
  onSwapPttAndReplyButtonsChange: (enabled: boolean) => void;
  enableBackgroundAudioRecovery: boolean;
  onEnableBackgroundAudioRecoveryChange: (enabled: boolean) => void;
  keepScreenAwake: boolean;
  onKeepScreenAwakeChange: (enabled: boolean) => void;
  showVolumeControls: boolean;
  onShowVolumeControlsChange: (enabled: boolean) => void;
  mediaSessionSupported: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  isStandaloneDisplayMode: boolean;
  onChannelPptStart: (channelId: string) => void;
  onChannelPptStop: (channelId: string) => void;
  pptPressedChannelId: string | null;
  pinnedRoomIds: string[];
  pinnedUserIds: string[];
  showPinnedOnly: boolean;
  onTogglePinnedRoom: (roomId: string) => void;
  onTogglePinnedUser: (userId: string) => void;
  onShowPinnedOnlyChange: (value: boolean) => void;
  isUserSettingsOpen: boolean;
  setIsUserSettingsOpen: (value: boolean) => void;
  roomGainById: Record<string, number>;
  directGainByUserId: Record<string, number>;
  onRoomGainChange: (roomId: string, gain: number) => void;
  onDirectGainChange: (userId: string, gain: number) => void;
  // Keyboard shortcuts
  keyboardShortcuts: KeyboardShortcutSettings;
  onKeyboardShortcutsChange: (next: KeyboardShortcutSettings) => void;
  onRecordingShortcutChange: (recording: boolean) => void;
  // Audio device props
  inputDevices: MediaDeviceInfo[];
  selectedInputDeviceId: string;
  selectedMicLabel: string;
  setSelectedInputDeviceId: (value: string) => void;
  inputLevelDbFs: number;
  inputGain: number;
  inputClipping: boolean;
  onInputGainChange: (deviceId: string, gain: number) => void;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  selectedOutputLabel: string;
  outputSelectionSupported: boolean;
  setSelectedOutputDeviceId: (value: string) => void;
  streamDeckSettings: StreamDeckSettings | null;
  streamDeckBusy: boolean;
  streamDeckError: string;
  onStreamDeckSettingsChange: (next: StreamDeckSettings) => void;
  onSaveStreamDeckSettings: () => void;
  onResetStreamDeckSettings: () => void;
  streamDeckWebHidSupported: boolean;
  streamDeckWebHidActive: boolean;
  streamDeckWebHidBusy: boolean;
  onConnectStreamDeckWebHid: () => void;
  onDisconnectStreamDeckWebHid: () => void;
  streamDeckBridgeConnected: boolean;
  streamDeckBridgeLastEvent: string;
};

export function StationIntercomView({
  connectionState,
  appData,
  doLogout,
  listenRoomIds,
  talkRoomIds,
  canRoleSendToRoom,
  canRoleReceiveFromRoom,
  toggleTalkRoom,
  toggleListenRoom,
  isReceivingRoom,
  isReceivingBroadcast,
  isReceivingDirect,
  broadcastPttPressed,
  startBroadcastPtt,
  stopBroadcastPtt,
  broadcastGroups,
  presence,
  roomListenerCounts,
  roleNameById,
  lastDirectCallerUserId,
  directPttPressedUserId,
  startDirectPtt,
  stopDirectPtt,
  sendScopedSignal,
  pttPressed,
  startPtt,
  stopPtt,
  voiceMode,
  setAlwaysOn,
  chatAndSignalPanel,
  showDebug,
  realtimeDebugBlock,
  enableDirectPpt,
  onEnableDirectPptChange,
  enableDirectTabs,
  onEnableDirectTabsChange,
  swapPttAndReplyButtons,
  onSwapPttAndReplyButtonsChange,
  enableBackgroundAudioRecovery,
  onEnableBackgroundAudioRecoveryChange,
  keepScreenAwake,
  onKeepScreenAwakeChange,
  showVolumeControls,
  onShowVolumeControlsChange,
  mediaSessionSupported,
  wakeLockSupported,
  wakeLockActive,
  isStandaloneDisplayMode,
  onChannelPptStart,
  onChannelPptStop,
  pptPressedChannelId,
  pinnedRoomIds,
  pinnedUserIds,
  showPinnedOnly,
  onTogglePinnedRoom,
  onTogglePinnedUser,
  onShowPinnedOnlyChange,
  isUserSettingsOpen,
  setIsUserSettingsOpen,
  roomGainById,
  directGainByUserId,
  onRoomGainChange,
  onDirectGainChange,
  keyboardShortcuts,
  onKeyboardShortcutsChange,
  onRecordingShortcutChange,
  inputDevices,
  selectedInputDeviceId,
  selectedMicLabel,
  setSelectedInputDeviceId,
  inputLevelDbFs,
  inputGain,
  inputClipping,
  onInputGainChange,
  outputDevices,
  selectedOutputDeviceId,
  selectedOutputLabel,
  outputSelectionSupported,
  setSelectedOutputDeviceId,
  streamDeckSettings,
  streamDeckBusy,
  streamDeckError,
  onStreamDeckSettingsChange,
  onSaveStreamDeckSettings,
  onResetStreamDeckSettings,
  streamDeckWebHidSupported,
  streamDeckWebHidActive,
  streamDeckWebHidBusy,
  onConnectStreamDeckWebHid,
  onDisconnectStreamDeckWebHid,
  streamDeckBridgeConnected,
  streamDeckBridgeLastEvent,
}: StationIntercomViewProps) {
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [isOutputMenuOpen, setIsOutputMenuOpen] = useState(false);
  const micMenuRef = useRef<HTMLDivElement>(null);
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const [isAudioOpen, setIsAudioOpen] = useState(false);
  const [isStreamDeckOpen, setIsStreamDeckOpen] = useState(false);
  const [activeDirectTab, setActiveDirectTab] = useState<string>("all");
  const [streamDeckSelectedButtonIndex, setStreamDeckSelectedButtonIndex] =
    useState(0);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        micMenuRef.current &&
        !micMenuRef.current.contains(event.target as Node)
      ) {
        setIsMicMenuOpen(false);
      }
      if (
        outputMenuRef.current &&
        !outputMenuRef.current.contains(event.target as Node)
      ) {
        setIsOutputMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const allDirectOnlineTargets = useMemo(() => {
    const directCandidates = presence.filter(
      (p) =>
        p.userId !== appData.self.id && p.username.toLowerCase() !== "admin",
    );
    return sortDirectUsersByRoleAndUsername(directCandidates, roleNameById);
  }, [appData.self.id, presence, roleNameById]);

  const directOnlineTargets = useMemo(
    () =>
      showPinnedOnly
        ? allDirectOnlineTargets.filter((p) => pinnedUserIds.includes(p.userId))
        : allDirectOnlineTargets,
    [allDirectOnlineTargets, pinnedUserIds, showPinnedOnly],
  );

  const directGroups = useMemo(() => {
    if (!enableDirectTabs) return [];

    const groups: Array<{
      tabId: string;
      label: string;
      count: number;
      users: typeof allDirectOnlineTargets;
    }> = [];

    // When tabs are enabled, always use allDirectOnlineTargets (ignore showPinnedOnly)

    // Favorites tab
    const favorites = allDirectOnlineTargets.filter((p) =>
      pinnedUserIds.includes(p.userId),
    );
    groups.push({
      tabId: "favorites",
      label: "Favorites",
      count: favorites.length,
      users: favorites,
    });

    // Role-based tabs
    const roleGroups = new Map<string, typeof allDirectOnlineTargets>();
    for (const p of allDirectOnlineTargets) {
      if (!roleGroups.has(p.roleId)) {
        roleGroups.set(p.roleId, []);
      }
      roleGroups.get(p.roleId)!.push(p);
    }
    for (const [roleId, users] of roleGroups) {
      const roleLabel = roleNameById.get(roleId) || roleId || "Unknown";
      groups.push({
        tabId: roleId,
        label: roleLabel,
        count: users.length,
        users,
      });
    }

    // All tab
    groups.push({
      tabId: "all",
      label: "All",
      count: allDirectOnlineTargets.length,
      users: allDirectOnlineTargets,
    });

    return groups;
  }, [enableDirectTabs, allDirectOnlineTargets, pinnedUserIds, roleNameById]);

  const displayedDirectUsers = useMemo(() => {
    if (!enableDirectTabs) return directOnlineTargets;
    const group = directGroups.find((g) => g.tabId === activeDirectTab);
    return group ? group.users : [];
  }, [enableDirectTabs, directGroups, activeDirectTab, directOnlineTargets]);

  // Reset active tab if it no longer exists
  useEffect(() => {
    if (enableDirectTabs && directGroups.length > 0) {
      const tabExists = directGroups.some((g) => g.tabId === activeDirectTab);
      if (!tabExists) {
        setActiveDirectTab("all");
      }
    }
  }, [enableDirectTabs, directGroups, activeDirectTab]);

  const visibleRooms = useMemo(
    () =>
      showPinnedOnly
        ? appData.rooms.filter((room) => pinnedRoomIds.includes(room.id))
        : appData.rooms,
    [appData.rooms, pinnedRoomIds, showPinnedOnly],
  );

  const streamDeckPageOrder = useMemo(
    () =>
      (streamDeckSettings?.pages || [])
        .map((page) => page.page)
        .sort((a, b) => a - b),
    [streamDeckSettings],
  );

  const streamDeckCurrentPage = useMemo(() => {
    if (!streamDeckSettings || streamDeckSettings.pages.length === 0) {
      return null;
    }
    return (
      streamDeckSettings.pages.find(
        (page) => page.page === streamDeckSettings.selectedPage,
      ) || streamDeckSettings.pages[0]
    );
  }, [streamDeckSettings]);

  const streamDeckCurrentButtons = useMemo(
    () =>
      [...(streamDeckCurrentPage?.buttons || [])].sort(
        (a, b) => a.index - b.index,
      ),
    [streamDeckCurrentPage],
  );

  const streamDeckSelectedButton = useMemo(
    () =>
      streamDeckCurrentButtons.find(
        (button) => button.index === streamDeckSelectedButtonIndex,
      ) || streamDeckCurrentButtons[0] || null,
    [streamDeckCurrentButtons, streamDeckSelectedButtonIndex],
  );

  useEffect(() => {
    if (!streamDeckCurrentButtons.length) return;
    const exists = streamDeckCurrentButtons.some(
      (button) => button.index === streamDeckSelectedButtonIndex,
    );
    if (!exists) {
      setStreamDeckSelectedButtonIndex(streamDeckCurrentButtons[0].index);
    }
  }, [streamDeckCurrentButtons, streamDeckSelectedButtonIndex]);

  const updateStreamDeckSelectedButton = (
    updater: (button: NonNullable<typeof streamDeckSelectedButton>) => {
      index: number;
      label?: string;
      color?: string;
      action?: {
        type: StreamDeckActionType;
        roomId?: string;
        userId?: string;
        roleId?: string;
        broadcastGroupId?: string;
        volumeDelta?: number;
      };
    },
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage || !streamDeckSelectedButton) {
      return;
    }
    const nextSelected = updater(streamDeckSelectedButton);
    onStreamDeckSettingsChange({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page !== streamDeckCurrentPage.page
          ? page
          : {
              ...page,
              buttons: page.buttons.map((button) =>
                button.index === streamDeckSelectedButton.index
                  ? nextSelected
                  : button,
              ),
            },
      ),
    });
  };

  const setStreamDeckActionType = (type: StreamDeckActionType) => {
    updateStreamDeckSelectedButton((button) => {
      if (type === "none") {
        return { ...button, action: undefined };
      }
      if (type === "ptt_room") {
        return {
          ...button,
          action: {
            type,
            roomId:
              button.action?.type === "ptt_room"
                ? button.action.roomId
                : appData.rooms[0]?.id,
          },
        };
      }
      if (type === "direct_role") {
        return {
          ...button,
          action: {
            type,
            roleId:
              button.action?.type === "direct_role"
                ? button.action.roleId
                : appData.roles[0]?.id,
          },
        };
      }
      if (type === "broadcast_ptt") {
        return {
          ...button,
          action: {
            type,
            broadcastGroupId:
              button.action?.type === "broadcast_ptt"
                ? button.action.broadcastGroupId
                : broadcastGroups[0]?.id,
          },
        };
      }
      if (type === "volume_delta") {
        return {
          ...button,
          action: {
            type,
            volumeDelta:
              button.action?.type === "volume_delta"
                ? button.action.volumeDelta || 1
                : 1,
          },
        };
      }
      return { ...button, action: { type } };
    });
  };

  const goToStreamDeckPage = (direction: -1 | 1) => {
    if (!streamDeckSettings || streamDeckPageOrder.length === 0) return;
    const currentPageIndex = streamDeckPageOrder.findIndex(
      (pageNo) => pageNo === streamDeckSettings.selectedPage,
    );
    const safeCurrentIndex = currentPageIndex >= 0 ? currentPageIndex : 0;
    const nextIndex = Math.max(
      0,
      Math.min(streamDeckPageOrder.length - 1, safeCurrentIndex + direction),
    );
    const nextPage = streamDeckPageOrder[nextIndex];
    if (nextPage === undefined || nextPage === streamDeckSettings.selectedPage) {
      return;
    }
    onStreamDeckSettingsChange({
      ...streamDeckSettings,
      selectedPage: nextPage,
    });
  };

  const replyTarget =
    allDirectOnlineTargets.find((p) => p.userId === lastDirectCallerUserId) ||
    null;
  const replyTargetUserId = lastDirectCallerUserId;

  // Is user actively sending audio on their main talk rooms?
  // Not when direct PTT or broadcast PTT is active (audio goes there instead).
  const isSendingOnTalkRooms =
    (pttPressed || voiceMode === "always_on") &&
    !directPttPressedUserId &&
    !broadcastPttPressed;
  const mainPttButtonProps = createHoldButtonProps<HTMLButtonElement>({
    onStart: startPtt,
    onStop: stopPtt,
  });
  const replyButtonProps = createHoldButtonProps<HTMLButtonElement>({
    disabled: !replyTargetUserId,
    onStart: () => {
      if (replyTargetUserId) {
        startDirectPtt(replyTargetUserId);
      }
    },
    onStop: () => {
      if (replyTargetUserId) {
        stopDirectPtt(replyTargetUserId);
      }
    },
  });
  const mainPttButton = (
    <button
      key="ptt"
      className={`station-ptt hold-button ${pttPressed ? "active" : ""}`}
      {...mainPttButtonProps}
    >
      Hold to talk
    </button>
  );
  const replyButton = (
    <button
      key="reply"
      className={`station-reply hold-button ${replyTargetUserId ? "" : "disabled"} ${
        replyTargetUserId && directPttPressedUserId === replyTargetUserId
          ? "active"
          : ""
      }`}
      disabled={!replyTargetUserId}
      {...replyButtonProps}
    >
      Reply to caller
      <small>
        {replyTarget
          ? replyTarget.username
          : replyTargetUserId
            ? "Recent caller"
            : "No active caller"}
      </small>
    </button>
  );
  const footerButtons = swapPttAndReplyButtons
    ? [mainPttButton, replyButton]
    : [replyButton, mainPttButton];
  const hasChatAndSignalPanel = Boolean(chatAndSignalPanel);

  return (
    <div className="root app station-shell">
      {connectionState !== "connected" && (
        <div className="connection-offline-banner">
          <span className="connection-offline-icon" />
          {connectionState === "reconnecting"
            ? "Reconnecting…"
            : connectionState === "connecting"
              ? "Connecting…"
              : "Offline"}
        </div>
      )}
      <div className="station-header">
        <div className="station-topbar">
          <div className="station-live">
            <span
              className={`station-live-dot ${
                connectionState === "connected" ? "connected" : "disconnected"
              }`}
            />
            Live: {appData.self.username.toUpperCase()}
          </div>
          <div className="station-top-actions">
            <button
              className="station-top-admin"
              onClick={() => setIsUserSettingsOpen(true)}
            >
              User settings
            </button>
            <button className="station-top-logout" onClick={doLogout}>
              Logout / Lock
            </button>
          </div>
        </div>

        <section
          className={`station-controls ${
            isUserSettingsOpen ? "station-controls-hidden-mobile" : ""
          }`}
        >
          {footerButtons}
          <button
            type="button"
            role="switch"
            aria-checked={voiceMode === "always_on"}
            className={`station-always-on ${voiceMode === "always_on" ? "active" : ""}`}
            onClick={() => setAlwaysOn(voiceMode !== "always_on")}
          >
            <span className="station-always-on-indicator" aria-hidden="true" />
            <span className="station-always-on-text">Always on</span>
          </button>
        </section>
      </div>

      <div className="station-content-grid">
        <div className="station-primary-column">
          <section className="station-block station-talk-section">
            <h3>Talk channels</h3>
            <div className="station-filter-bar small">
              <span className="station-filter-hint">
                Pin party lines or users to keep focus when things get busy.
              </span>
            </div>
            {visibleRooms.length === 0 ? (
              <p className="station-empty">No channels to show.</p>
            ) : null}
            <div className="station-talk-grid">
              {visibleRooms.map((room) => {
                const listening = listenRoomIds.includes(room.id);
                const talking = talkRoomIds.includes(room.id);
                const canTalk = canRoleSendToRoom(room.id, appData.self.roleId);
                const canListen = canRoleReceiveFromRoom(
                  room.id,
                  appData.self.roleId,
                );
                const isForced = (room.forcedListenRoleIds ?? []).includes(
                  appData.self.roleId,
                );
                const isPttPressed =
                  enableDirectPpt && pptPressedChannelId === room.id;

                const handleTalkPointerDown = () => {
                  if (enableDirectPpt) {
                    onChannelPptStart(room.id);
                  }
                };

                const handleTalkPointerUp = () => {
                  if (enableDirectPpt) {
                    onChannelPptStop(room.id);
                  }
                };
                const talkButtonHoldProps =
                  canTalk && enableDirectPpt
                    ? createHoldButtonProps<HTMLButtonElement>({
                        onStart: handleTalkPointerDown,
                        onStop: handleTalkPointerUp,
                      })
                    : {};

                const listenerCount = roomListenerCounts[room.id] ?? 0;
                const talkButtonClassName = `station-card-head ${
                  enableDirectPpt ? "hold-button " : ""
                }${
                  enableDirectPpt
                    ? isPttPressed && canTalk
                      ? "ppt-active"
                      : ""
                    : ""
                } ${canTalk ? "" : "disabled"}${
                  !enableDirectPpt && talking && canTalk ? " talk-armed" : ""
                }${
                  !enableDirectPpt && talking && canTalk && isSendingOnTalkRooms
                    ? " talk-live"
                    : ""
                }`;

                return (
                  <article
                    key={`station-room-${room.id}`}
                    className="station-card"
                  >
                    {listenerCount > 0 ? (
                      <span
                        className="station-presence-badge"
                        title={`${listenerCount} listener(s)`}
                      >
                        <span className="station-presence-dot" />
                        {listenerCount}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={`station-pin-top ${pinnedRoomIds.includes(room.id) ? "active" : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePinnedRoom(room.id);
                      }}
                      title={
                        pinnedRoomIds.includes(room.id)
                          ? "Remove channel from favorites"
                          : "Add channel to favorites"
                      }
                    >
                      ★
                    </button>
                    <button
                      className={talkButtonClassName}
                      {...talkButtonHoldProps}
                      onClick={
                        !enableDirectPpt && canTalk
                          ? () => toggleTalkRoom(room.id)
                          : undefined
                      }
                      disabled={!canTalk}
                      title={
                        canTalk
                          ? ""
                          : "Your role is not allowed to send to this party line"
                      }
                    >
                      {isReceivingRoom(room.id) ? (
                        <span className="station-receiving-badge">🔊</span>
                      ) : null}
                      <small>Talk</small>
                      <strong>{room.name}</strong>
                    </button>
                    {showVolumeControls ? (
                      <div className="station-gain-control">
                        <label htmlFor={`room-gain-${room.id}`}>
                          {gainToDbLabel(roomGainById[room.id] ?? 1)}
                        </label>
                        <input
                          id={`room-gain-${room.id}`}
                          type="range"
                          min={MUTE_POS}
                          max={DB_MAX}
                          step={1}
                          value={gainToSlider(roomGainById[room.id] ?? 1)}
                          style={
                            {
                              "--fill": `${sliderFillPercent(roomGainById[room.id] ?? 1)}%`,
                            } as React.CSSProperties
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onRoomGainChange(
                              room.id,
                              sliderToGain(Number(event.currentTarget.value)),
                            )
                          }
                        />
                      </div>
                    ) : null}
                    <div className="station-card-actions">
                      <button
                        className={`listen ${listening && canListen ? "on" : ""} ${canListen ? "" : "disabled"} ${isForced ? "forced" : ""}`}
                        onClick={() => toggleListenRoom(room.id)}
                        disabled={!canListen || isForced}
                        title={
                          isForced
                            ? "Forced listen — cannot be deselected"
                            : canListen
                              ? ""
                              : "Your role is not allowed to receive from this party line"
                        }
                      >
                        {isForced ? "🔒 Listen" : "Listen"}
                      </button>
                      <button
                        className={`call ${canTalk ? "" : "disabled"}`}
                        onClick={() =>
                          sendScopedSignal("room", room.id, "call")
                        }
                        disabled={!canTalk}
                        title={
                          canTalk
                            ? ""
                            : "Your role is not allowed to send to this room"
                        }
                      >
                        Call
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="station-block station-direct-section">
            <h3>Direct communication</h3>
            {enableDirectTabs && directGroups.length > 0 ? (
              <>
                <div
                  className="station-direct-tabs"
                  role="tablist"
                  aria-label="Direct communication tabs"
                >
                  {directGroups.map((group) => (
                    <button
                      key={`direct-tab-${group.tabId}`}
                      role="tab"
                      className={`station-direct-tab ${activeDirectTab === group.tabId ? "active" : ""}`}
                      aria-selected={activeDirectTab === group.tabId}
                      onClick={() => setActiveDirectTab(group.tabId)}
                    >
                      <span>{group.label}</span>
                      <small>{group.count}</small>
                    </button>
                  ))}
                </div>
                {displayedDirectUsers.length === 0 ? (
                  <p className="station-empty">No users in this tab.</p>
                ) : (
                  <div className="station-direct-grid">
                    {displayedDirectUsers.map((p) => (
                      <article
                        key={`station-direct-${p.userId}`}
                        className="station-card station-direct-card"
                      >
                        <button
                          type="button"
                          className={`station-pin-top ${pinnedUserIds.includes(p.userId) ? "active" : ""}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onTogglePinnedUser(p.userId);
                          }}
                          title={
                            pinnedUserIds.includes(p.userId)
                              ? "Remove user from favorites"
                              : "Add user to favorites"
                          }
                        >
                          ★
                        </button>
                        <button
                          className={`station-card-head direct-ptt hold-button ${directPttPressedUserId === p.userId ? "active" : ""}`}
                          {...createHoldButtonProps<HTMLButtonElement>({
                            onStart: () => startDirectPtt(p.userId),
                            onStop: () => stopDirectPtt(p.userId),
                          })}
                        >
                          {isReceivingDirect(p.userId) ? (
                            <span className="station-receiving-badge">🔊</span>
                          ) : null}
                          <small>Direct</small>
                          <strong>{p.username}</strong>
                          <em>
                            {roleNameById.get(p.roleId) ||
                              p.roleId ||
                              "Unknown role"}
                          </em>
                        </button>
                        {showVolumeControls ? (
                          <div className="station-gain-control">
                            <label htmlFor={`direct-gain-${p.userId}`}>
                              {gainToDbLabel(directGainByUserId[p.userId] ?? 1)}
                            </label>
                            <input
                              id={`direct-gain-${p.userId}`}
                              type="range"
                              min={MUTE_POS}
                              max={DB_MAX}
                              step={1}
                              value={gainToSlider(
                                directGainByUserId[p.userId] ?? 1,
                              )}
                              style={
                                {
                                  "--fill": `${sliderFillPercent(directGainByUserId[p.userId] ?? 1)}%`,
                                } as React.CSSProperties
                              }
                              onPointerDown={(event) => event.stopPropagation()}
                              onPointerUp={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                onDirectGainChange(
                                  p.userId,
                                  sliderToGain(Number(event.currentTarget.value)),
                                )
                              }
                            />
                          </div>
                        ) : null}
                        <div className="station-card-actions single">
                          <button
                            className={`call ${/* disabled handled by class */ ""}`}
                            onClick={() =>
                              sendScopedSignal("direct", p.userId, "call")
                            }
                            title="Call user"
                          >
                            Call
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            ) : directOnlineTargets.length === 0 ? (
              <p className="station-empty">
                {showPinnedOnly
                  ? "No favorite users online."
                  : "No other users online."}
              </p>
            ) : (
              <div className="station-direct-grid">
                {directOnlineTargets.map((p) => (
                  <article
                    key={`station-direct-${p.userId}`}
                    className="station-card station-direct-card"
                  >
                    <button
                      type="button"
                      className={`station-pin-top ${pinnedUserIds.includes(p.userId) ? "active" : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePinnedUser(p.userId);
                      }}
                      title={
                        pinnedUserIds.includes(p.userId)
                          ? "Remove user from favorites"
                          : "Add user to favorites"
                      }
                    >
                      ★
                    </button>
                    <button
                      className={`station-card-head direct-ptt hold-button ${directPttPressedUserId === p.userId ? "active" : ""}`}
                      {...createHoldButtonProps<HTMLButtonElement>({
                        onStart: () => startDirectPtt(p.userId),
                        onStop: () => stopDirectPtt(p.userId),
                      })}
                    >
                      {isReceivingDirect(p.userId) ? (
                        <span className="station-receiving-badge">🔊</span>
                      ) : null}
                      <small>Direct</small>
                      <strong>{p.username}</strong>
                      <em>
                        {roleNameById.get(p.roleId) ||
                          p.roleId ||
                          "Unknown role"}
                      </em>
                    </button>
                    {showVolumeControls ? (
                      <div className="station-gain-control">
                        <label htmlFor={`direct-gain-${p.userId}`}>
                          {gainToDbLabel(directGainByUserId[p.userId] ?? 1)}
                        </label>
                        <input
                          id={`direct-gain-${p.userId}`}
                          type="range"
                          min={MUTE_POS}
                          max={DB_MAX}
                          step={1}
                          value={gainToSlider(directGainByUserId[p.userId] ?? 1)}
                          style={
                            {
                              "--fill": `${sliderFillPercent(directGainByUserId[p.userId] ?? 1)}%`,
                            } as React.CSSProperties
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onDirectGainChange(
                              p.userId,
                              sliderToGain(Number(event.currentTarget.value)),
                            )
                          }
                        />
                      </div>
                    ) : null}
                    <div className="station-card-actions single">
                      <button
                        className={`call ${/* disabled handled by class */ ""}`}
                        onClick={() =>
                          sendScopedSignal("direct", p.userId, "call")
                        }
                        title="Call user"
                      >
                        Call
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {broadcastGroups.length > 0 ? (
            <section className="station-block station-broadcast-section">
              <h3>Broadcast channels</h3>
              <div className="station-broadcast-grid">
                {broadcastGroups.map((group) => {
                  const allowedRoleIds = Array.isArray(group.allowedRoleIds)
                    ? group.allowedRoleIds
                    : [];
                  const canSend =
                    allowedRoleIds.length === 0 ||
                    allowedRoleIds.includes(appData.self.roleId);
                  return (
                    <button
                      key={group.id}
                      className={`station-broadcast-button hold-button ${broadcastPttPressed === group.id ? "active" : ""} ${
                        canSend ? "" : "disabled"
                      }`}
                      {...createHoldButtonProps<HTMLButtonElement>({
                        disabled: !canSend,
                        onStart: () => {
                          if (canSend) {
                            startBroadcastPtt(group.id);
                          }
                        },
                        onStop: () => {
                          if (canSend) {
                            stopBroadcastPtt(group.id);
                          }
                        },
                      })}
                      disabled={!canSend}
                      title={
                        canSend
                          ? ""
                          : "Your role is not allowed to send to this broadcast channel"
                      }
                    >
                      {isReceivingBroadcast(group.id) ? (
                        <span className="station-broadcast-receiving">🔊</span>
                      ) : null}
                      {group.name}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        {hasChatAndSignalPanel ? (
          <aside className="station-secondary-column">
            <section className="station-block station-utility station-utility-section">
              <h3>Chat</h3>
              <div className="panel station-chat-panel">
                {chatAndSignalPanel}
              </div>
            </section>
          </aside>
        ) : null}
      </div>
      {showDebug ? (
        <section className="panel">{realtimeDebugBlock}</section>
      ) : null}
      {isUserSettingsOpen ? (
        <div
          className="station-modal-backdrop"
          onClick={() => setIsUserSettingsOpen(false)}
        >
          <section
            className="station-modal panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="station-modal-header">
              <h3>User settings</h3>
              <button
                className="station-modal-close"
                onClick={() => setIsUserSettingsOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="station-modal-body">
              <section className="station-settings-section">
                <h4 className="station-settings-section-title">Layout</h4>
                <div className="station-settings-grid">
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={showPinnedOnly}
                      onChange={(e) => onShowPinnedOnlyChange(e.target.checked)}
                    />
                    <span>Show only favorites</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={enableDirectTabs}
                      onChange={(e) =>
                        onEnableDirectTabsChange(e.target.checked)
                      }
                    />
                    <span>Show direct communication as tabs</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={showVolumeControls}
                      onChange={(e) =>
                        onShowVolumeControlsChange(e.target.checked)
                      }
                    />
                    <span>Show volume controls</span>
                  </label>
                </div>
              </section>

              <section className="station-settings-section">
                <h4 className="station-settings-section-title">Interaction</h4>
                <div className="station-settings-grid">
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={enableDirectPpt}
                      onChange={(e) =>
                        onEnableDirectPptChange(e.target.checked)
                      }
                    />
                    <span>Direct PTT Mode (press channel to talk)</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={swapPttAndReplyButtons}
                      onChange={(e) =>
                        onSwapPttAndReplyButtonsChange(e.target.checked)
                      }
                    />
                    <span>Swap PTT and reply buttons</span>
                  </label>
                </div>
              </section>

              <section className="station-settings-section">
                <h4 className="station-settings-section-title">System</h4>
                <div className="station-settings-grid">
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={enableBackgroundAudioRecovery}
                      onChange={(e) =>
                        onEnableBackgroundAudioRecoveryChange(e.target.checked)
                      }
                    />
                    <span>Background audio assist</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={keepScreenAwake}
                      disabled={!wakeLockSupported}
                      onChange={(e) => onKeepScreenAwakeChange(e.target.checked)}
                    />
                    <span>Keep device awake while connected</span>
                  </label>
                </div>
              </section>

              <section className="station-settings-section station-settings-status">
                <small className="station-settings-meta">
                  Media controls: {mediaSessionSupported ? "supported" : "not supported"} · Wake
                  lock: {wakeLockSupported ? (wakeLockActive ? "active" : "available") : "not supported"} · Install mode: {isStandaloneDisplayMode ? "installed app" : "browser tab"}
                </small>
                <small className="station-settings-meta">
                  For best mobile reliability, keep background audio assist
                  enabled and install the app to your home screen.
                </small>
              </section>

              <KeyboardShortcutsSettings
                shortcuts={keyboardShortcuts}
                onShortcutsChange={onKeyboardShortcutsChange}
                onRecordingChange={onRecordingShortcutChange}
              />

              <section className="station-settings-section streamdeck-settings-section">
                <div className={`audio-box ${isStreamDeckOpen ? "" : "collapsed"}`}>
                  <div className="audio-box-header">
                    <button
                      type="button"
                      className="audio-box-toggle"
                      onClick={() => setIsStreamDeckOpen((value) => !value)}
                      aria-expanded={isStreamDeckOpen}
                    >
                      Stream Deck
                      <span className={`chev ${isStreamDeckOpen ? "open" : ""}`}>
                        ▾
                      </span>
                    </button>
                  </div>
                  {isStreamDeckOpen ? (
                    <div className="audio-box-body">
                      <div className="streamdeck-settings-header">
                        <h4 className="station-settings-section-title">
                          Configuration
                        </h4>
                        <div className="streamdeck-settings-actions">
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={
                              streamDeckWebHidActive
                                ? onDisconnectStreamDeckWebHid
                                : onConnectStreamDeckWebHid
                            }
                            disabled={streamDeckWebHidBusy || !streamDeckWebHidSupported}
                          >
                            {streamDeckWebHidBusy
                              ? "Working..."
                              : streamDeckWebHidActive
                                ? "Disconnect device"
                                : "Connect device"}
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={onSaveStreamDeckSettings}
                            disabled={streamDeckBusy || !streamDeckSettings}
                          >
                            {streamDeckBusy ? "Saving..." : "Save"}
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-clear"
                            onClick={onResetStreamDeckSettings}
                            disabled={streamDeckBusy}
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    {streamDeckError ? (
                      <small className="streamdeck-error">{streamDeckError}</small>
                    ) : null}
                    <small className="station-settings-meta">
                      WebHID: {
                        streamDeckWebHidSupported
                          ? streamDeckWebHidActive
                            ? "connected"
                            : "ready"
                          : "not supported"
                      }
                      {" · "}
                      Input: {streamDeckBridgeConnected ? "connected" : "waiting"}
                      {streamDeckBridgeLastEvent
                        ? ` · Last event: ${streamDeckBridgeLastEvent}`
                        : ""}
                    </small>
                    {showDebug ? (
                      <small className="station-settings-meta">
                        Debug: use window.__kesherStreamDeckDev.buttonTap(0, 0)
                        or buttonDown/buttonUp in browser console. Use
                        window.__kesherStreamDeckDev.listHidDevices() to show
                        granted HID devices or
                        window.__kesherStreamDeckDev.requestAndListHidDevices()
                        to re-open the device picker.
                      </small>
                    ) : null}
                    {!streamDeckSettings ? (
                      <small className="station-settings-meta">
                        Loading Stream Deck settings...
                      </small>
                    ) : (
                      <>
                        <div className="streamdeck-toolbar">
                          <label className="streamdeck-control">
                            <span>Profile</span>
                            <select value="default" disabled>
                              <option value="default">Default</option>
                            </select>
                          </label>
                          <div className="streamdeck-page-nav" aria-label="Page selector">
                            <button
                              type="button"
                              className="shortcut-btn"
                              onClick={() => goToStreamDeckPage(-1)}
                              disabled={
                                streamDeckBusy ||
                                streamDeckPageOrder[0] ===
                                  streamDeckSettings.selectedPage
                              }
                            >
                              ◀
                            </button>
                            <span>
                              Page {streamDeckSettings.selectedPage + 1}
                            </span>
                            <button
                              type="button"
                              className="shortcut-btn"
                              onClick={() => goToStreamDeckPage(1)}
                              disabled={
                                streamDeckBusy ||
                                streamDeckPageOrder[streamDeckPageOrder.length - 1] ===
                                  streamDeckSettings.selectedPage
                              }
                            >
                              ▶
                            </button>
                          </div>
                        </div>

                        <div className="streamdeck-layout">
                          <div className="streamdeck-grid" role="grid" aria-label="Stream Deck 5x3 grid">
                            {streamDeckCurrentButtons.map((button) => {
                              const actionType = button.action?.type || "none";
                              const displayLabel =
                                button.label ||
                                (actionType === "reply_to_caller"
                                  ? "Reply"
                                  : actionType.replace(/_/g, " "));
                              return (
                                <button
                                  type="button"
                                  key={`streamdeck-button-${button.index}`}
                                  className={`streamdeck-button ${
                                    streamDeckSelectedButton?.index === button.index
                                      ? "active"
                                      : ""
                                  }`}
                                  onClick={() =>
                                    setStreamDeckSelectedButtonIndex(button.index)
                                  }
                                  style={
                                    button.color
                                      ? ({
                                          "--streamdeck-button-color": button.color,
                                        } as React.CSSProperties)
                                      : undefined
                                  }
                                >
                                  <strong>{displayLabel || `Button ${button.index + 1}`}</strong>
                                  <small>{actionType === "none" ? "unassigned" : actionType}</small>
                                </button>
                              );
                            })}
                          </div>

                          <div className="streamdeck-editor panel">
                        <h5>
                          Button {(streamDeckSelectedButton?.index || 0) + 1}
                        </h5>
                        <label className="streamdeck-control">
                          <span>Label</span>
                          <input
                            type="text"
                            value={streamDeckSelectedButton?.label || ""}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                label: event.target.value,
                              }))
                            }
                            placeholder="Optional label"
                          />
                        </label>
                        <label className="streamdeck-control">
                          <span>Color</span>
                          <input
                            type="text"
                            value={streamDeckSelectedButton?.color || ""}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                color: event.target.value,
                              }))
                            }
                            placeholder="#1f3f5f"
                          />
                        </label>
                        <label className="streamdeck-control">
                          <span>Function</span>
                          <select
                            aria-label="Stream Deck function"
                            value={streamDeckSelectedButton?.action?.type || "none"}
                            onChange={(event) =>
                              setStreamDeckActionType(
                                event.target.value as StreamDeckActionType,
                              )
                            }
                          >
                            <option value="none">None</option>
                            <option value="ptt_room">PTT channel</option>
                            <option value="direct_role">Direct role</option>
                            <option value="reply_to_caller">Reply to caller</option>
                            <option value="broadcast_ptt">Broadcast PTT</option>
                            <option value="mute_toggle">Mute / unmute mic</option>
                            <option value="volume_delta">Volume +/-</option>
                          </select>
                        </label>

                        {streamDeckSelectedButton?.action?.type === "ptt_room" ? (
                          <label className="streamdeck-control">
                            <span>Channel</span>
                            <select
                              aria-label="Stream Deck channel target"
                              value={streamDeckSelectedButton.action.roomId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "ptt_room",
                                    roomId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {appData.rooms.map((room) => (
                                <option key={`streamdeck-room-${room.id}`} value={room.id}>
                                  {room.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "direct_role" ? (
                          <label className="streamdeck-control">
                            <span>Direct role</span>
                            <select
                              aria-label="Stream Deck direct role target"
                              value={streamDeckSelectedButton.action.roleId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "direct_role",
                                    roleId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {appData.roles.map((role) => {
                                const onlineRoleUsers = allDirectOnlineTargets
                                  .filter((entry) => entry.roleId === role.id)
                                  .map((entry) => entry.username);
                                const onlineHint =
                                  onlineRoleUsers.length > 0
                                    ? ` (${onlineRoleUsers.join(", ")})`
                                    : "";
                                return (
                                  <option key={`streamdeck-role-${role.id}`} value={role.id}>
                                    {role.name}{onlineHint}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "broadcast_ptt" ? (
                          <label className="streamdeck-control">
                            <span>Broadcast group</span>
                            <select
                              aria-label="Stream Deck broadcast target"
                              value={streamDeckSelectedButton.action.broadcastGroupId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "broadcast_ptt",
                                    broadcastGroupId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {broadcastGroups.map((group) => (
                                <option key={`streamdeck-group-${group.id}`} value={group.id}>
                                  {group.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "volume_delta" ? (
                          <label className="streamdeck-control">
                            <span>Volume step</span>
                            <select
                              aria-label="Stream Deck volume delta"
                              value={String(
                                streamDeckSelectedButton.action.volumeDelta || 1,
                              )}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "volume_delta",
                                    volumeDelta: Number(event.target.value),
                                  },
                                }))
                              }
                            >
                              <option value="-2">-2</option>
                              <option value="-1">-1</option>
                              <option value="1">+1</option>
                              <option value="2">+2</option>
                            </select>
                          </label>
                        ) : null}
                          </div>
                        </div>
                      </>
                    )}
                    </div>
                  ) : null}
                </div>
              </section>

              <div className="audio-section">
                <div className={`audio-box ${isAudioOpen ? "" : "collapsed"}`}>
                  <div className="audio-box-header">
                    <button
                      type="button"
                      className="audio-box-toggle"
                      onClick={() => setIsAudioOpen((v) => !v)}
                      aria-expanded={isAudioOpen}
                    >
                      Sound settings
                      <span className={`chev ${isAudioOpen ? "open" : ""}`}>
                        ▾
                      </span>
                    </button>
                  </div>
                  {isAudioOpen ? (
                    <div className="audio-box-body">
                      <div className="audio-left">
                        <h4>Microphone</h4>
                        <div className="audio-row audio-row-mic">
                          <div className="mic-dropdown" ref={micMenuRef}>
                            <button
                              type="button"
                              className="mic-dropdown-trigger"
                              onClick={() => setIsMicMenuOpen((v) => !v)}
                              disabled={inputDevices.length === 0}
                              aria-haspopup="listbox"
                              aria-expanded={isMicMenuOpen}
                            >
                              <span>{selectedMicLabel}</span>
                              <span>▾</span>
                            </button>
                            {isMicMenuOpen ? (
                              <div className="mic-dropdown-menu" role="listbox">
                                {inputDevices.map((d) => (
                                  <button
                                    type="button"
                                    key={d.deviceId}
                                    className={`mic-dropdown-item ${d.deviceId === selectedInputDeviceId ? "active" : ""}`}
                                    onClick={() => {
                                      setSelectedInputDeviceId(d.deviceId);
                                      setIsMicMenuOpen(false);
                                    }}
                                    title={
                                      d.label || `Mic ${d.deviceId.slice(0, 6)}`
                                    }
                                  >
                                    {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="input-level-row" aria-live="polite">
                          <div className="input-level-head">
                            <small>Input level</small>
                            <strong>{formatDbFs(inputLevelDbFs)}</strong>
                          </div>
                          <div className="meter">
                            <div
                              className="meter-bar"
                              style={{
                                width: `${meterDbFsToPercent(inputLevelDbFs)}%`,
                              }}
                            />
                          </div>
                          <small
                            className={`input-level-status ${inputClipping ? "is-clipping" : "is-ok"}`}
                          >
                            {inputClipping
                              ? "audio clipping"
                              : "audio level ok"}
                          </small>
                        </div>
                        {showVolumeControls ? (
                          <div className="station-gain-control input-gain-control">
                            <label htmlFor="input-gain">
                              {gainToDbLabel(inputGain)}
                            </label>
                            <input
                              id="input-gain"
                              type="range"
                              min={MUTE_POS}
                              max={DB_MAX}
                              step={1}
                              value={gainToSlider(inputGain)}
                              style={
                                {
                                  "--fill": `${sliderFillPercent(inputGain)}%`,
                                } as React.CSSProperties
                              }
                              onChange={(event) =>
                                onInputGainChange(
                                  selectedInputDeviceId,
                                  sliderToGain(Number(event.currentTarget.value)),
                                )
                              }
                              aria-label="Input gain"
                            />
                          </div>
                        ) : null}
                      </div>
                      <div className="audio-right">
                        <h4>Speaker output</h4>
                        <div className="mic-dropdown" ref={outputMenuRef}>
                          <button
                            type="button"
                            className="mic-dropdown-trigger"
                            onClick={() => setIsOutputMenuOpen((v) => !v)}
                            disabled={outputDevices.length === 0}
                            aria-haspopup="listbox"
                            aria-expanded={isOutputMenuOpen}
                          >
                            <span>{selectedOutputLabel}</span>
                            <span>▾</span>
                          </button>
                          {isOutputMenuOpen ? (
                            <div className="mic-dropdown-menu" role="listbox">
                              <button
                                type="button"
                                className={`mic-dropdown-item ${selectedOutputDeviceId === "" ? "active" : ""}`}
                                onClick={() => {
                                  setSelectedOutputDeviceId("");
                                  setIsOutputMenuOpen(false);
                                }}
                                title="System default"
                              >
                                System default
                              </button>
                              {outputDevices.map((d) => (
                                <button
                                  type="button"
                                  key={d.deviceId}
                                  className={`mic-dropdown-item ${d.deviceId === selectedOutputDeviceId ? "active" : ""}`}
                                  onClick={() => {
                                    setSelectedOutputDeviceId(d.deviceId);
                                    setIsOutputMenuOpen(false);
                                  }}
                                  title={
                                    d.label ||
                                    `Output ${d.deviceId.slice(0, 6)}`
                                  }
                                >
                                  {d.label ||
                                    `Output ${d.deviceId.slice(0, 6)}`}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {!outputSelectionSupported ? (
                          <small
                            style={{ display: "block", marginTop: "0.5rem" }}
                          >
                            Explicit speaker selection is not supported by this
                            browser; using system default output.
                          </small>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <section className="station-settings-section station-settings-version">
                <h4 className="station-settings-section-title">App Version</h4>
                <small>{appData.appVersion.version}</small>
                <small className="station-settings-build">
                  Built: {appData.appVersion.buildTimestamp}
                </small>
              </section>

              <p className="station-modal-hint">
                Preferences apply only to you on this device.
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
