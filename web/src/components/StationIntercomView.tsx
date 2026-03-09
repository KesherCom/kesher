import { useEffect, useMemo, useRef, useState } from "react";
import type { Bootstrap, BroadcastGroup, Presence } from "../types";
import type { KeyboardShortcutSettings } from "../app/settings";
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
}: StationIntercomViewProps) {
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [isOutputMenuOpen, setIsOutputMenuOpen] = useState(false);
  const micMenuRef = useRef<HTMLDivElement>(null);
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const [isAudioOpen, setIsAudioOpen] = useState(true);
  const [activeDirectTab, setActiveDirectTab] = useState<string>("all");

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
  const mainPttButton = (
    <button
      key="ptt"
      className={`station-ptt ${pttPressed ? "active" : ""}`}
      onPointerDown={startPtt}
      onPointerUp={stopPtt}
      onPointerLeave={stopPtt}
      onPointerCancel={stopPtt}
    >
      Hold to talk
    </button>
  );
  const replyButton = (
    <button
      key="reply"
      className={`station-reply ${replyTargetUserId ? "" : "disabled"} ${
        replyTargetUserId && directPttPressedUserId === replyTargetUserId
          ? "active"
          : ""
      }`}
      disabled={!replyTargetUserId}
      onPointerDown={() =>
        replyTargetUserId ? startDirectPtt(replyTargetUserId) : undefined
      }
      onPointerUp={() =>
        replyTargetUserId ? stopDirectPtt(replyTargetUserId) : undefined
      }
      onPointerLeave={() =>
        replyTargetUserId ? stopDirectPtt(replyTargetUserId) : undefined
      }
      onPointerCancel={() =>
        replyTargetUserId ? stopDirectPtt(replyTargetUserId) : undefined
      }
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

                const listenerCount = roomListenerCounts[room.id] ?? 0;

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
                          ? "Unpin channel"
                          : "Pin channel"
                      }
                    >
                      ★
                    </button>
                    <button
                      className={`station-card-head ${
                        enableDirectPpt
                          ? isPttPressed && canTalk
                            ? "ppt-active"
                            : ""
                          : ""
                      } ${canTalk ? "" : "disabled"}${!enableDirectPpt && talking && canTalk ? " talk-armed" : ""}${!enableDirectPpt && talking && canTalk && isSendingOnTalkRooms ? " talk-live" : ""}`}
                      onPointerDown={
                        canTalk && enableDirectPpt
                          ? handleTalkPointerDown
                          : undefined
                      }
                      onPointerUp={
                        canTalk && enableDirectPpt
                          ? handleTalkPointerUp
                          : undefined
                      }
                      onPointerLeave={
                        canTalk && enableDirectPpt && isPttPressed
                          ? handleTalkPointerUp
                          : undefined
                      }
                      onPointerCancel={
                        canTalk && enableDirectPpt && isPttPressed
                          ? handleTalkPointerUp
                          : undefined
                      }
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
                              ? "Unpin user"
                              : "Pin user"
                          }
                        >
                          ★
                        </button>
                        <button
                          className={`station-card-head direct-ptt ${directPttPressedUserId === p.userId ? "active" : ""}`}
                          onPointerDown={() => startDirectPtt(p.userId)}
                          onPointerUp={() => stopDirectPtt(p.userId)}
                          onPointerLeave={() => stopDirectPtt(p.userId)}
                          onPointerCancel={() => stopDirectPtt(p.userId)}
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
                  ? "No pinned users online."
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
                          ? "Unpin user"
                          : "Pin user"
                      }
                    >
                      ★
                    </button>
                    <button
                      className={`station-card-head direct-ptt ${directPttPressedUserId === p.userId ? "active" : ""}`}
                      onPointerDown={() => startDirectPtt(p.userId)}
                      onPointerUp={() => stopDirectPtt(p.userId)}
                      onPointerLeave={() => stopDirectPtt(p.userId)}
                      onPointerCancel={() => stopDirectPtt(p.userId)}
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
                      className={`station-broadcast-button ${broadcastPttPressed === group.id ? "active" : ""} ${
                        canSend ? "" : "disabled"
                      }`}
                      onPointerDown={() =>
                        canSend ? startBroadcastPtt(group.id) : undefined
                      }
                      onPointerUp={() =>
                        canSend ? stopBroadcastPtt(group.id) : undefined
                      }
                      onPointerLeave={() =>
                        canSend ? stopBroadcastPtt(group.id) : undefined
                      }
                      onPointerCancel={() =>
                        canSend ? stopBroadcastPtt(group.id) : undefined
                      }
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
              <label className="station-setting">
                <input
                  type="checkbox"
                  checked={showPinnedOnly}
                  onChange={(e) => onShowPinnedOnlyChange(e.target.checked)}
                />
                <span>Show only pinned</span>
              </label>
              <label className="station-setting">
                <input
                  type="checkbox"
                  checked={enableDirectPpt}
                  onChange={(e) => onEnableDirectPptChange(e.target.checked)}
                />
                <span>Direct PTT Mode (press channel to talk)</span>
              </label>
              <label className="station-setting">
                <input
                  type="checkbox"
                  checked={enableDirectTabs}
                  onChange={(e) => onEnableDirectTabsChange(e.target.checked)}
                />
                <span>Show direct communication as tabs</span>
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
              <label className="station-setting">
                <input
                  type="checkbox"
                  checked={showVolumeControls}
                  onChange={(e) => onShowVolumeControlsChange(e.target.checked)}
                />
                <span>Show volume controls</span>
              </label>
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <small>
                  Media controls:{" "}
                  {mediaSessionSupported ? "supported" : "not supported"} · Wake
                  lock:{" "}
                  {wakeLockSupported
                    ? wakeLockActive
                      ? "active"
                      : "available"
                    : "not supported"}{" "}
                  · Install mode:{" "}
                  {isStandaloneDisplayMode ? "installed app" : "browser tab"}
                </small>
                <small>
                  For best mobile reliability, keep background audio assist
                  enabled and install the app to your home screen.
                </small>
              </div>

              <KeyboardShortcutsSettings
                shortcuts={keyboardShortcuts}
                onShortcutsChange={onKeyboardShortcutsChange}
                onRecordingChange={onRecordingShortcutChange}
              />

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
