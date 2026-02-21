import { useMemo } from "react";
import type { Bootstrap, Presence } from "../types";
import { AdminPanel } from "./admin/AdminPanel";

type StationIntercomViewProps = {
  appData: Bootstrap;
  token: string;
  doLogout: () => void;
  isAdminModalOpen: boolean;
  setIsAdminModalOpen: (value: boolean) => void;
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
  audioPanel: React.ReactNode;
  chatAndSignalPanel: React.ReactNode;
  showDebug: boolean;
  realtimeDebugBlock: React.ReactNode;
  refreshBootstrapData: () => Promise<void>;
};

export function StationIntercomView({
  appData,
  token,
  doLogout,
  isAdminModalOpen,
  setIsAdminModalOpen,
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
  audioPanel,
  chatAndSignalPanel,
  showDebug,
  realtimeDebugBlock,
  refreshBootstrapData
}: StationIntercomViewProps) {
  const directOnlineTargets = useMemo(
    () =>
      presence
        .filter((p) => p.userId !== appData.self.id)
        .slice()
        .sort((a, b) => {
          const roleA = (roleNameById.get(a.roleId) || a.roleId || "").toLowerCase();
          const roleB = (roleNameById.get(b.roleId) || b.roleId || "").toLowerCase();
          const byRole = roleA.localeCompare(roleB, undefined, { sensitivity: "base" });
          if (byRole !== 0) return byRole;
          return a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
        }),
    [appData.self.id, presence, roleNameById]
  );

  const replyTarget = directOnlineTargets.find((p) => p.userId === lastDirectCallerUserId) || null;

  return (
    <div className="root app station-shell">
      <div className="station-topbar">
        <div className="station-live">
          <span className="station-live-dot" />
          Live: {appData.self.username.toUpperCase()}
        </div>
        <div className="station-top-actions">
          <button className="station-top-admin" onClick={() => setIsAdminModalOpen(true)}>
            Configuration
          </button>
          <button className="station-top-logout" onClick={doLogout}>
            Logout / Lock
          </button>
        </div>
      </div>

      <section className="station-block">
        <h3>Talk channels</h3>
        <div className="station-talk-grid">
          {appData.rooms.map((room) => {
            const listening = listenRoomIds.includes(room.id);
            const talking = talkRoomIds.includes(room.id);
            const canTalk = canRoleSendToRoom(room.id, appData.self.roleId);
            const canListen = canRoleReceiveFromRoom(room.id, appData.self.roleId);
            return (
              <article key={`station-room-${room.id}`} className="station-card">
                <button
                  className={`station-card-head ${talking ? "selected" : ""}`}
                  onClick={() => toggleTalkRoom(room.id)}
                  disabled={!canTalk}
                  title={canTalk ? "" : "Your role is not allowed to send to this room"}
                >
                  {isReceivingRoom(room.id) ? <span className="station-receiving-badge">🔊</span> : null}
                  <small>Talk</small>
                  <strong>{room.name}</strong>
                </button>
                <div className="station-card-actions">
                  <button
                    className={listening ? "on listen" : "listen"}
                    onClick={() => toggleListenRoom(room.id)}
                    disabled={!canListen}
                    title={canListen ? "" : "Your role is not allowed to receive from this room"}
                  >
                    Listen
                  </button>
                  <button className="call placeholder" disabled title="Reserved for upcoming feature">
                    Call
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="station-block">
        <h3>Direct communication</h3>
        <div className="station-direct-grid">
          {directOnlineTargets.map((p) => (
            <article key={`station-direct-${p.userId}`} className="station-card station-direct-card">
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
                <button className="signal" onClick={() => sendScopedSignal("direct", p.userId, "attention")}>
                  Signal
                </button>
              </div>
            </article>
          ))}
          {directOnlineTargets.length === 0 ? <p className="station-empty">No other users online.</p> : null}
        </div>
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

      {appData.broadcastGroups.length > 0 ? (
        <section className="station-block">
          <h3>Broadcast channels</h3>
          <div className="station-broadcast-grid">
            {appData.broadcastGroups.map((group) => (
              <button
                key={group.id}
                className={`station-broadcast-button ${broadcastPttPressed === group.id ? "active" : ""}`}
                onPointerDown={() => startBroadcastPtt(group.id)}
                onPointerUp={() => stopBroadcastPtt(group.id)}
                onPointerLeave={() => stopBroadcastPtt(group.id)}
                onPointerCancel={() => stopBroadcastPtt(group.id)}
              >
                {isReceivingBroadcast(group.id) ? <span className="station-broadcast-receiving">🔊</span> : null}
                {group.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="station-utility">
        <div className="panel">{audioPanel}</div>
        <div className="panel">{chatAndSignalPanel}</div>
      </section>
      {isAdminModalOpen ? (
        <div className="station-modal-backdrop" onClick={() => setIsAdminModalOpen(false)}>
          <section className="station-modal panel" onClick={(event) => event.stopPropagation()}>
            <div className="station-modal-header">
              <h3>Configuration</h3>
              <button className="station-modal-close" onClick={() => setIsAdminModalOpen(false)}>
                Close
              </button>
            </div>
            <AdminPanel token={token} appData={appData} refreshBootstrapData={refreshBootstrapData} />
          </section>
        </div>
      ) : null}
      {showDebug ? <section className="panel">{realtimeDebugBlock}</section> : null}
    </div>
  );
}

