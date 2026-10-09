import { useEffect, useMemo, useState } from "react";
import type {
  Bootstrap,
  BroadcastGroup,
  CompanionProfileResponse,
  Presence,
  StreamDeckSettings,
} from "../types";
import type { KeyboardShortcutSettings } from "../app/settings";
import { formatBinding } from "../app/settings";
import { createHoldButtonProps } from "../lib/holdButton";
import { sortDirectUsersByRoleAndUsername } from "../lib/users";
import { UserSettingsDialog } from "./settings/UserSettingsDialog";
import {
  MUTE_POS,
  OUTPUT_DB_MAX,
  gainToDbLabel,
  gainToSlider,
  meterDbFsToPercent,
  sliderFillPercent,
  sliderToGain,
} from "../lib/gain";
import { Icon } from "./Icon";
import type { PerformanceAudioControls } from "../hooks/useIntercomSession";
import type { AutosaveState } from "../hooks/useAutosave";

type StationIntercomViewProps = {
  token: string;
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
  /** Who is talking into a party line right now (names). */
  roomTalkers?: (roomId: string) => string[];
  /** Microphone/audio problem to show in the header ("" when fine). */
  audioError?: string;
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
  setSelectedInputDeviceId: (value: string) => void;
  inputLevelDbFs: number;
  inputGain: number;
  inputClipping: boolean;
  isLocalMonitorActive: boolean;
  onToggleLocalMonitor: () => void;
  onInputGainChange: (deviceId: string, gain: number) => void;
  audioGateEnabled: boolean;
  onAudioGateEnabledChange: (enabled: boolean) => void;
  audioGateThresholdDb: number;
  onAudioGateThresholdDbChange: (db: number) => void;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  outputSelectionSupported: boolean;
  setSelectedOutputDeviceId: (value: string) => void;
  /** Desktop performance engine controls; null in the browser. */
  performanceAudio?: PerformanceAudioControls | null;
  streamDeckSettings: StreamDeckSettings | null;
  streamDeckBusy: boolean;
  streamDeckError: string;
  onStreamDeckSettingsChange: (next: StreamDeckSettings) => void;
  /** Layout edits save themselves; this is where that stands. */
  streamDeckSaveState: AutosaveState;
  /** Save now: the retry after a failed save. */
  onSaveStreamDeckSettings: () => void;
  onResetStreamDeckSettings: () => void;
  /** A Companion Stream Deck was paired with or released from this place. */
  onStreamDeckPlaceChanged?: () => void;
  onPublishCompanionProfile: () => Promise<CompanionProfileResponse>;
  streamDeckWebHidSupported: boolean;
  streamDeckWebHidActive: boolean;
  streamDeckWebHidBusy: boolean;
  onConnectStreamDeckWebHid: () => void;
  onDisconnectStreamDeckWebHid: () => void;
  streamDeckBridgeConnected: boolean;
  streamDeckBridgeLastEvent: string;
  lastCompanionCommand: {
    command: string;
    status: "executing" | "executed" | "rejected" | "failed";
    error?: string;
    at: number;
  } | null;
  onStreamDeckTestButtonEvent: (event: {
    page: number;
    buttonIndex: number;
    state: "down" | "up";
  }) => void;
};

export function StationIntercomView(props: StationIntercomViewProps) {
  const {
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
    roomTalkers,
    audioError = "",
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
    enableDirectTabs,
    swapPttAndReplyButtons,
    showVolumeControls,
    onChannelPptStart,
    onChannelPptStop,
    pptPressedChannelId,
    pinnedRoomIds,
    pinnedUserIds,
    showPinnedOnly,
    onTogglePinnedRoom,
    onTogglePinnedUser,
    isUserSettingsOpen,
    setIsUserSettingsOpen,
    roomGainById,
    directGainByUserId,
    onRoomGainChange,
    onDirectGainChange,
    keyboardShortcuts,
    inputDevices,
    selectedInputDeviceId,
    inputLevelDbFs,
  } = props;
  // The card whose volume fader is open (its dB value opens it).
  const [openGainId, setOpenGainId] = useState<string | null>(null);

  /** Priority marker (L / H / C) of a party line, channel or person. */
  const renderPriorityBadge = (level: number | null | undefined) => {
    const p = level ?? 1;
    if (p === 1) return null;
    const labels: Record<number, string> = { 0: "L", 2: "H", 3: "C" };
    return (
      <span className={`priority-badge priority-${p}`}>{labels[p] || "?"}</span>
    );
  };

  const renderPinButton = (
    pinned: boolean,
    label: string,
    toggle: () => void,
  ) => (
    <button
      type="button"
      className={`station-card-icon pin ${pinned ? "active" : ""}`}
      aria-pressed={pinned}
      aria-label={
        pinned ? `Remove ${label} from favorites` : `Add ${label} to favorites`
      }
      title={pinned ? "Favorite" : "Add to favorites"}
      onClick={toggle}
    >
      <Icon name="pin" />
    </button>
  );

  /** A card's volume value; it opens the fader below the card. */
  const renderGainValue = (id: string, label: string, gain: number) =>
    showVolumeControls ? (
      <button
        type="button"
        className={`station-card-gain ${openGainId === id ? "open" : ""}`}
        aria-expanded={openGainId === id}
        aria-label={`Volume ${label}: ${gainToDbLabel(gain)}`}
        onClick={() => setOpenGainId(openGainId === id ? null : id)}
      >
        {gainToDbLabel(gain)}
      </button>
    ) : null;

  /** The fader itself; double-click resets to 0 dB, like a mixer (#11). */
  const renderGainFader = (
    id: string,
    label: string,
    gain: number,
    onChange: (gain: number) => void,
  ) =>
    showVolumeControls && openGainId === id ? (
      <div className="station-gain-control">
        <input
          id={id}
          type="range"
          aria-label={`Volume ${label}`}
          title="Double-click: 0 dB"
          min={MUTE_POS}
          max={OUTPUT_DB_MAX}
          step={1}
          value={gainToSlider(gain)}
          style={
            { "--fill": `${sliderFillPercent(gain)}%` } as React.CSSProperties
          }
          onDoubleClick={() => onChange(1)}
          onChange={(event) =>
            onChange(sliderToGain(Number(event.currentTarget.value)))
          }
        />
      </div>
    ) : null;

  /** A person: hold the card to talk to them directly. */
  const renderDirectCard = (p: Presence) => {
    const pressed = directPttPressedUserId === p.userId;
    const receiving = isReceivingDirect(p.userId);
    const gainId = `direct-gain-${p.userId}`;
    const gain = directGainByUserId[p.userId] ?? 1;
    const roleName = roleNameById.get(p.roleId) || p.roleId || "Unknown role";
    return (
      <article
        key={`station-direct-${p.userId}`}
        className={`station-card station-direct-card ${pressed ? "is-on-air" : receiving ? "is-receiving" : ""}`}
      >
        <button
          className={`station-card-head direct-ptt hold-button ${pressed ? "active" : ""}`}
          {...createHoldButtonProps<HTMLButtonElement>({
            onStart: () => startDirectPtt(p.userId),
            onStop: () => stopDirectPtt(p.userId),
          })}
        >
          <span className="station-card-title">
            <strong>{p.username}</strong>
            {renderPriorityBadge(getMaxUserChannelPriority(p))}
          </span>
          <span className="station-card-status">
            {pressed ? "On air" : receiving ? "Talking to you" : roleName}
          </span>
        </button>
        <div className="station-card-row">
          <button
            type="button"
            className="station-card-icon call"
            aria-label={`Call ${p.username}`}
            title="Call"
            onClick={() => sendScopedSignal("direct", p.userId, "call")}
          >
            <Icon name="bell" />
          </button>
          {renderPinButton(pinnedUserIds.includes(p.userId), p.username, () =>
            onTogglePinnedUser(p.userId),
          )}
          {renderGainValue(gainId, p.username, gain)}
        </div>
        {renderGainFader(gainId, p.username, gain, (next) =>
          onDirectGainChange(p.userId, next),
        )}
      </article>
    );
  };
  const [activeDirectTab, setActiveDirectTab] = useState<string>("all");

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

  // Helper: get max priority for a user based on their active talk rooms and broadcasts
  const getMaxUserChannelPriority = (user: Presence): number | null => {
    let maxPriority: number | null = null;

    // Check talk rooms
    for (const roomId of user.talkRooms) {
      const room = appData.rooms.find((r) => r.id === roomId);
      if (room) {
        const p = room.priorityLevel ?? 1;
        if (maxPriority === null || p > maxPriority) {
          maxPriority = p;
        }
      }
    }

    // Check broadcast active
    if (user.broadcastActive) {
      for (const group of appData.broadcastGroups) {
        // User is broadcast active if they're in the broadcast group or an admin
        const p = group.priorityLevel ?? 1;
        if (maxPriority === null || p > maxPriority) {
          maxPriority = p;
        }
      }
    }

    return maxPriority;
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
      <Icon name="mic" size={22} />
      Hold to talk
      {keyboardShortcuts.ptt ? (
        // The assigned key (#8); aria-hidden keeps the button name "Hold to talk".
        <kbd
          className="ptt-key-hint"
          aria-hidden="true"
          title="Keyboard shortcut"
        >
          {formatBinding(keyboardShortcuts.ptt)}
        </kbd>
      ) : null}
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
      <Icon name="reply" />
      Reply to caller
      <small>
        {replyTarget
          ? `${replyTarget.username} (${roleNameById.get(replyTarget.roleId) || replyTarget.roleId || "Unknown role"})`
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
            ? "Reconnecting..."
            : connectionState === "connecting"
              ? "Connecting..."
              : "Offline"}
        </div>
      )}
      <div className="station-header">
        <div className="station-topbar">
          <div className="station-live">
            <div className="station-live-name">
              <span
                className={`station-live-dot ${
                  connectionState === "connected" ? "connected" : "disconnected"
                }`}
              />
              {appData.self.username}
            </div>
            <div className="station-live-role">
              {roleNameById.get(appData.self.roleId) || appData.self.roleId}
              {" · "}
              {connectionState === "connected" ? "connected" : connectionState}
            </div>
          </div>
          {(() => {
            // Microphone at a glance: level, device, whether we are sending,
            // and problems that used to stay invisible. Opens sound settings.
            const micOpen =
              pttPressed ||
              voiceMode === "always_on" ||
              !!directPttPressedUserId ||
              !!broadcastPttPressed;
            const inputLabel =
              inputDevices.find((d) => d.deviceId === selectedInputDeviceId)
                ?.label || "Default microphone";
            const problem =
              audioError ||
              (inputDevices.length === 0 ? "No microphone found" : "");
            return (
              <button
                type="button"
                className={`station-mic-status ${micOpen ? "on-air" : ""} ${problem ? "has-problem" : ""}`}
                onClick={() => {
                  setIsUserSettingsOpen(true);
                }}
                title="Sound settings"
                aria-label={`Microphone: ${problem || (micOpen ? "on air" : "off")}, ${inputLabel}. Open sound settings`}
              >
                <span className="station-mic-state">
                  {problem ? "Mic problem" : micOpen ? "On air" : "Mic off"}
                </span>
                <span className="station-mic-meter" aria-hidden="true">
                  <span
                    style={{
                      width: `${problem ? 0 : meterDbFsToPercent(inputLevelDbFs)}%`,
                    }}
                  />
                </span>
                <span className="station-mic-device">
                  {problem || inputLabel}
                </span>
              </button>
            );
          })()}
          <div className="station-top-actions">
            <button
              type="button"
              className="k-icon-button"
              aria-label="User settings"
              title="Settings"
              onClick={() => setIsUserSettingsOpen(true)}
            >
              <Icon name="settings" />
            </button>
            <button
              type="button"
              className="k-icon-button station-top-logout"
              aria-label="Log out and lock"
              title="Log out and lock"
              onClick={doLogout}
            >
              <Icon name="lock" />
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

                const talkers = roomTalkers?.(room.id) ?? [];
                const onAir =
                  (isPttPressed && canTalk) ||
                  (!enableDirectPpt &&
                    talking &&
                    canTalk &&
                    isSendingOnTalkRooms);
                const receiving =
                  talkers.length > 0 || isReceivingRoom(room.id);
                const status = onAir
                  ? "On air"
                  : talkers.length > 1
                    ? `${talkers.join(", ")} are talking`
                    : talkers.length === 1
                      ? `${talkers[0]} is talking`
                      : receiving
                        ? "Someone is talking"
                        : !enableDirectPpt && talking && canTalk
                          ? "Selected for talk"
                          : listening && canListen
                            ? `${isForced ? "Always listening" : "Listening"} · ${listenerCount}`
                            : canListen
                              ? "Not listening"
                              : canTalk
                                ? "Talk only"
                                : "No access";
                const armed =
                  !onAir &&
                  !receiving &&
                  !enableDirectPpt &&
                  talking &&
                  canTalk;
                const gainId = `room-gain-${room.id}`;
                const gain = roomGainById[room.id] ?? 1;
                return (
                  <article
                    key={`station-room-${room.id}`}
                    className={`station-card ${onAir ? "is-on-air" : receiving ? "is-receiving" : armed ? "is-armed" : listening && canListen ? "is-hearing" : ""}`}
                  >
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
                      <span className="station-card-title">
                        <strong>{room.name}</strong>
                        {renderPriorityBadge(room.priorityLevel)}
                      </span>
                      <span className="station-card-status">{status}</span>
                    </button>
                    <div className="station-card-row">
                      <button
                        type="button"
                        className={`station-card-icon listen ${listening && canListen ? "on" : ""} ${isForced ? "forced" : ""}`}
                        aria-pressed={listening && canListen}
                        aria-label={
                          isForced
                            ? `${room.name}: always listening (set by the admin)`
                            : `Listen to ${room.name}`
                        }
                        title={
                          isForced
                            ? "Always listening, set by the admin"
                            : canListen
                              ? "Listen"
                              : "Your role is not allowed to receive from this party line"
                        }
                        onClick={() => toggleListenRoom(room.id)}
                        disabled={!canListen || isForced}
                      >
                        <Icon name="headphones" />
                      </button>
                      <button
                        type="button"
                        className="station-card-icon call"
                        aria-label={`Call ${room.name}`}
                        title={
                          canTalk
                            ? "Call"
                            : "Your role is not allowed to send to this party line"
                        }
                        onClick={() =>
                          sendScopedSignal("room", room.id, "call")
                        }
                        disabled={!canTalk}
                      >
                        <Icon name="bell" />
                      </button>
                      {renderPinButton(
                        pinnedRoomIds.includes(room.id),
                        room.name,
                        () => onTogglePinnedRoom(room.id),
                      )}
                      {renderGainValue(gainId, room.name, gain)}
                    </div>
                    {renderGainFader(gainId, room.name, gain, (next) =>
                      onRoomGainChange(room.id, next),
                    )}
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
                    {displayedDirectUsers.map((p) => renderDirectCard(p))}
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
                {directOnlineTargets.map((p) => renderDirectCard(p))}
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
                        <span className="station-broadcast-receiving">RX</span>
                      ) : null}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: "0.15rem",
                        }}
                      >
                        <span>{group.name}</span>
                        {renderPriorityBadge(group.priorityLevel)}
                      </div>
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
        <UserSettingsDialog
          {...props}
          onlineUsers={allDirectOnlineTargets}
          onClose={() => setIsUserSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
