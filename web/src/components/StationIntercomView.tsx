import { useEffect, useMemo, useRef, useState } from "react";
import type { Bootstrap, BroadcastGroup, Presence } from "../types";

type StationIntercomViewProps = {
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
  roleNameById: Map<string, string>;
  lastDirectCallerUserId: string | null;
  directPttPressedUserId: string | null;
  startDirectPtt: (userId: string) => void;
  stopDirectPtt: (userId: string) => void;
  sendScopedSignal: (scopeValue: "direct" | "room" | "broadcast", scopedTargetId: string, signal: string) => void;
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
  availableChannels: Array<{ id: string; label: string }>;
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
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
  // Audio device props
  inputDevices: MediaDeviceInfo[];
  selectedInputDeviceId: string;
  selectedMicLabel: string;
  setSelectedInputDeviceId: (value: string) => void;
  inputLevel: number;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  selectedOutputLabel: string;
  outputSelectionSupported: boolean;
  setSelectedOutputDeviceId: (value: string) => void;
};

export function StationIntercomView({
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
  availableChannels,
  selectedChannelId,
  onSelectChannel,
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
  inputDevices,
  selectedInputDeviceId,
  selectedMicLabel,
  setSelectedInputDeviceId,
  inputLevel,
  outputDevices,
  selectedOutputDeviceId,
  selectedOutputLabel,
  outputSelectionSupported,
  setSelectedOutputDeviceId
}: StationIntercomViewProps) {
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [isOutputMenuOpen, setIsOutputMenuOpen] = useState(false);
  const micMenuRef = useRef<HTMLDivElement>(null);
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const [isAudioOpen, setIsAudioOpen] = useState(true);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (micMenuRef.current && !micMenuRef.current.contains(event.target as Node)) {
        setIsMicMenuOpen(false);
      }
      if (outputMenuRef.current && !outputMenuRef.current.contains(event.target as Node)) {
        setIsOutputMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const allDirectOnlineTargets = useMemo(() => {
    return presence
      .filter((p) => p.userId !== appData.self.id && p.username.toLowerCase() !== "admin")
      .slice()
      .sort((a, b) => {
        const roleA = (roleNameById.get(a.roleId) || a.roleId || "").toLowerCase();
        const roleB = (roleNameById.get(b.roleId) || b.roleId || "").toLowerCase();
        const byRole = roleA.localeCompare(roleB, undefined, { sensitivity: "base" });
        if (byRole !== 0) return byRole;
        return a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
      });
  }, [appData.self.id, presence, roleNameById]);

  const directOnlineTargets = useMemo(
    () => (showPinnedOnly ? allDirectOnlineTargets.filter((p) => pinnedUserIds.includes(p.userId)) : allDirectOnlineTargets),
    [allDirectOnlineTargets, pinnedUserIds, showPinnedOnly]
  );

  const visibleRooms = useMemo(
    () => (showPinnedOnly ? appData.rooms.filter((room) => pinnedRoomIds.includes(room.id)) : appData.rooms),
    [appData.rooms, pinnedRoomIds, showPinnedOnly]
  );

  const replyTarget = allDirectOnlineTargets.find((p) => p.userId === lastDirectCallerUserId) || null;

  return (
    <div className="root app station-shell">
      <div className="station-topbar">
        <div className="station-live">
          <span className="station-live-dot" />
          Live: {appData.self.username.toUpperCase()}
        </div>
        <div className="station-top-actions">
          <button className="station-top-admin" onClick={() => setIsUserSettingsOpen(true)}>
            User settings
          </button>
          <button className="station-top-logout" onClick={doLogout}>
            Logout / Lock
          </button>
        </div>
      </div>

      <section className="station-block station-talk-section">
        <h3>Talk channels</h3>
        <div className="station-filter-bar small">
          <span className="station-filter-hint">Pin rooms or users to keep focus when things get busy.</span>
        </div>
        {visibleRooms.length === 0 ? <p className="station-empty">No channels to show.</p> : null}
        <div className="station-talk-grid">
              {visibleRooms.map((room) => {
            const listening = listenRoomIds.includes(room.id);
            const talking = talkRoomIds.includes(room.id);
            const canTalk = canRoleSendToRoom(room.id, appData.self.roleId);
            const canListen = canRoleReceiveFromRoom(room.id, appData.self.roleId);
            const isPttPressed = enableDirectPpt && pptPressedChannelId === room.id;
            
            const handleTalkPointerDown = () => {
              if (enableDirectPpt) {
                onChannelPptStart(room.id);
              } else {
                toggleTalkRoom(room.id);
              }
            };
            
            const handleTalkPointerUp = () => {
              if (enableDirectPpt) {
                onChannelPptStop(room.id);
              }
            };
            
            return (
              <article key={`station-room-${room.id}`} className="station-card">
                <button
                  type="button"
                  className={`station-pin-top ${pinnedRoomIds.includes(room.id) ? "active" : ""}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinnedRoom(room.id);
                  }}
                  title={pinnedRoomIds.includes(room.id) ? "Unpin channel" : "Pin channel"}
                >
                  ★
                </button>
                <button
                  className={`station-card-head ${
                    enableDirectPpt ? (isPttPressed ? "ppt-active" : "") : talking ? "selected" : ""
                  } ${canTalk ? "" : "disabled"}`}
                  onPointerDown={canTalk ? handleTalkPointerDown : undefined}
                  onPointerUp={canTalk ? handleTalkPointerUp : undefined}
                  onPointerLeave={canTalk && enableDirectPpt && isPttPressed ? handleTalkPointerUp : undefined}
                  onPointerCancel={canTalk && enableDirectPpt && isPttPressed ? handleTalkPointerUp : undefined}
                  onClick={!enableDirectPpt && canTalk ? () => toggleTalkRoom(room.id) : undefined}
                  disabled={!canTalk}
                  title={canTalk ? "" : "Your role is not allowed to send to this room"}
                >
                  {isReceivingRoom(room.id) ? <span className="station-receiving-badge">🔊</span> : null}
                  <small>Talk</small>
                  <strong>{room.name}</strong>
                </button>
                <div className="station-card-actions">
                  <button
                    className={`listen ${listening ? "on" : ""} ${canListen ? "" : "disabled"}`}
                    onClick={() => toggleListenRoom(room.id)}
                    disabled={!canListen}
                    title={canListen ? "" : "Your role is not allowed to receive from this room"}
                  >
                    Listen
                  </button>
                  <button
                    className={`call ${canTalk ? "" : "disabled"}`}
                    onClick={() => sendScopedSignal("room", room.id, "call")}
                    disabled={!canTalk}
                    title={canTalk ? "" : "Your role is not allowed to send to this room"}
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
        {directOnlineTargets.length === 0 ? (
          <p className="station-empty">{showPinnedOnly ? "No pinned users online." : "No other users online."}</p>
        ) : (
          <div className="station-direct-grid">
            {directOnlineTargets.map((p) => (
              <article key={`station-direct-${p.userId}`} className="station-card station-direct-card">
                <button
                  type="button"
                  className={`station-pin-top ${pinnedUserIds.includes(p.userId) ? "active" : ""}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinnedUser(p.userId);
                  }}
                  title={pinnedUserIds.includes(p.userId) ? "Unpin user" : "Pin user"}
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
                  {isReceivingDirect(p.userId) ? <span className="station-receiving-badge">🔊</span> : null}
                  <small>Direct</small>
                  <strong>{p.username}</strong>
                  <em>{roleNameById.get(p.roleId) || p.roleId || "Unknown role"}</em>
                </button>
                <div className="station-card-actions single">
                  <button
                    className={`call ${/* disabled handled by class */ ""}`}
                    onClick={() => sendScopedSignal("direct", p.userId, "call")}
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

      <section className="station-controls">
        <button
          className={`station-ptt ${pttPressed ? "active" : ""}`}
          onPointerDown={startPtt}
          onPointerUp={stopPtt}
          onPointerLeave={stopPtt}
          onPointerCancel={stopPtt}
        >
          Hold to talk
        </button>
        <label className={`station-always-on ${voiceMode === "always_on" ? "active" : ""}`}>
          <input type="checkbox" checked={voiceMode === "always_on"} onChange={(e) => setAlwaysOn(e.target.checked)} />
          <span>Always on</span>
        </label>

        <button
          className={`station-reply ${replyTarget ? "" : "disabled"} ${
            replyTarget && directPttPressedUserId === replyTarget.userId ? "active" : ""
          }`}
          disabled={!replyTarget}
          onPointerDown={() => (replyTarget ? startDirectPtt(replyTarget.userId) : undefined)}
          onPointerUp={() => (replyTarget ? stopDirectPtt(replyTarget.userId) : undefined)}
          onPointerLeave={() => (replyTarget ? stopDirectPtt(replyTarget.userId) : undefined)}
          onPointerCancel={() => (replyTarget ? stopDirectPtt(replyTarget.userId) : undefined)}
        >
          Reply to caller
          <small>{replyTarget ? replyTarget.username : "No active caller"}</small>
        </button>
      </section>

      {broadcastGroups.length > 0 ? (
        <section className="station-block station-broadcast-section">
          <h3>Broadcast channels</h3>
          <div className="station-broadcast-grid">
            {broadcastGroups.map((group) => {
              const allowedRoleIds = Array.isArray(group.allowedRoleIds) ? group.allowedRoleIds : [];
              const canSend = allowedRoleIds.length === 0 || allowedRoleIds.includes(appData.self.roleId);
              return (
                <button
                  key={group.id}
                  className={`station-broadcast-button ${broadcastPttPressed === group.id ? "active" : ""} ${
                    canSend ? "" : "disabled"
                  }`}
                  onPointerDown={() => (canSend ? startBroadcastPtt(group.id) : undefined)}
                  onPointerUp={() => (canSend ? stopBroadcastPtt(group.id) : undefined)}
                  onPointerLeave={() => (canSend ? stopBroadcastPtt(group.id) : undefined)}
                  onPointerCancel={() => (canSend ? stopBroadcastPtt(group.id) : undefined)}
                  disabled={!canSend}
                  title={canSend ? "" : "Your role is not allowed to send to this broadcast channel"}
                >
                  {isReceivingBroadcast(group.id) ? <span className="station-broadcast-receiving">🔊</span> : null}
                  {group.name}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="station-utility station-utility-section">
        <div className="panel">{chatAndSignalPanel}</div>
      </section>
      {showDebug ? <section className="panel">{realtimeDebugBlock}</section> : null}
      {isUserSettingsOpen ? (
        <div className="station-modal-backdrop" onClick={() => setIsUserSettingsOpen(false)}>
          <section className="station-modal panel" onClick={(event) => event.stopPropagation()}>
            <div className="station-modal-header">
              <h3>User settings</h3>
              <button className="station-modal-close" onClick={() => setIsUserSettingsOpen(false)}>
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
                    <span className={`chev ${isAudioOpen ? "open" : ""}`}>▾</span>
                  </button>
                </div>
                {isAudioOpen ? (
                  <div className="audio-box-body">
                    <div className="audio-left">
                <h4>Microphone</h4>
                <div className="audio-row">
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
                            title={d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                          >
                            {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="meter">
                      <div className="meter-bar" style={{ width: `${inputLevel}%` }} />
                    </div>
                </div>
                <small>Input level</small>
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
                          title={d.label || `Output ${d.deviceId.slice(0, 6)}`}
                        >
                          {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                      {!outputSelectionSupported ? (
                        <small style={{ display: "block", marginTop: "0.5rem" }}>
                          Explicit speaker selection is not supported by this browser; using system default output.
                        </small>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              </div>

              <p className="station-modal-hint">Preferences gelten nur für dich auf diesem Gerät.</p>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

