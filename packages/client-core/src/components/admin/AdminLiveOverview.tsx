import { useState } from "react";
import { interveneAdminUser } from "../../api";
import type { Bootstrap } from "../../types";
import type { AdminSection } from "./AdminMenu";
import { serverWarnings, type AdminLiveData } from "./useAdminLiveData";

type AdminLiveOverviewProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  live: AdminLiveData;
  reload: () => Promise<void>;
  onNavigate: (section: AdminSection) => void;
};

/**
 * The admin console's start page: who is online, what needs attention
 * (stations waiting, unpaired Stream Decks, server warnings) and quick
 * intervention (mute, kick). Everything else is one click away.
 */
export function AdminLiveOverview({
  token,
  adminPin,
  appData,
  live,
  reload,
  onNavigate,
}: AdminLiveOverviewProps) {
  const [busyUserId, setBusyUserId] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const roleName = (id: string) => appData.roles.find((r) => r.id === id)?.name ?? id;
  const online = live.users.filter((u) => u.online);
  const stationsApproved = live.devices.filter((d) => d.status === "approved");
  const stationsOnline = stationsApproved.filter((d) => d.online).length;
  const stationsPending = live.devices.filter((d) => d.status === "pending").length;
  const decksConnected = live.decks.filter((d) => d.connected).length;
  const decksUnpaired = live.decks.filter((d) => !d.placeId).length;
  const warnings = serverWarnings(live.stats);

  async function intervene(userId: string, username: string, action: "mute" | "kick") {
    if (action === "kick" && !window.confirm(`Log ${username} out on all devices?`)) return;
    setBusyUserId(userId);
    setActionError("");
    setNotice("");
    try {
      await interveneAdminUser(token, adminPin, userId, action);
      setNotice(action === "mute" ? `${username}'s microphone is off.` : `${username} was logged out.`);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusyUserId("");
    }
  }

  return (
    <div className="admin-live">
      {live.error ? <p className="admin-error">{live.error}</p> : null}

      <div className="admin-live-tiles">
        <button type="button" className="admin-live-tile" onClick={() => onNavigate("setup")}>
          <span className="admin-live-tile-value">{online.length}</span>
          <span className="admin-live-tile-label">people online</span>
          <span className="admin-live-tile-detail">{live.users.length} known</span>
        </button>
        <button
          type="button"
          className={`admin-live-tile ${stationsPending > 0 ? "attention" : ""}`}
          onClick={() => onNavigate("devices")}
        >
          <span className="admin-live-tile-value">
            {stationsOnline}/{stationsApproved.length}
          </span>
          <span className="admin-live-tile-label">stations online</span>
          <span className="admin-live-tile-detail">
            {stationsPending > 0 ? `${stationsPending} waiting for approval` : "Raspberry Pi"}
          </span>
        </button>
        <button
          type="button"
          className={`admin-live-tile ${decksUnpaired > 0 ? "attention" : ""}`}
          onClick={() => onNavigate("devices")}
        >
          <span className="admin-live-tile-value">
            {decksConnected}/{live.decks.length}
          </span>
          <span className="admin-live-tile-label">Stream Decks connected</span>
          <span className="admin-live-tile-detail">
            {decksUnpaired > 0 ? `${decksUnpaired} not paired` : "Companion"}
          </span>
        </button>
        <button
          type="button"
          className={`admin-live-tile ${warnings.length > 0 ? "warning" : "ok"}`}
          onClick={() => onNavigate("system")}
        >
          <span className="admin-live-tile-value">{warnings.length > 0 ? "Check" : "OK"}</span>
          <span className="admin-live-tile-label">server</span>
          <span className="admin-live-tile-detail">
            {warnings[0] ?? `${live.stats?.hub.connectedClients ?? 0} connections`}
          </span>
        </button>
      </div>

      <div className="admin-live-columns">
        <section className="admin-card admin-live-panel" aria-label="Online now">
          <div className="admin-card-header">
            <div className="admin-card-title">Online now</div>
          </div>
          <div className="admin-card-body">
            {actionError ? <p className="admin-error">{actionError}</p> : null}
            {notice ? <p className="admin-live-notice">{notice}</p> : null}
            {online.length === 0 ? (
              <p className="admin-empty">{live.loaded ? "Nobody is logged in." : "Loading…"}</p>
            ) : (
              <ul className="admin-list">
                {online.map((u) => (
                  <li key={u.id}>
                    <span>
                      <span className="admin-device-dot online" />
                      <strong>{u.username}</strong> <small>{roleName(u.roleId)}</small>
                    </span>
                    <span className="admin-device-actions">
                      <button
                        className="secondary"
                        disabled={busyUserId === u.id}
                        title="Turn the microphone off now; the next press talks again"
                        onClick={() => void intervene(u.id, u.username, "mute")}
                      >
                        Mute mic
                      </button>
                      <button
                        className="secondary danger"
                        disabled={busyUserId === u.id}
                        title="Log out on all devices"
                        onClick={() => void intervene(u.id, u.username, "kick")}
                      >
                        Kick
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="admin-card admin-live-panel" aria-label="Party lines">
          <div className="admin-card-header">
            <div className="admin-card-title">Party lines</div>
          </div>
          <div className="admin-card-body">
            <ul className="admin-list">
              {appData.rooms.map((room) => {
                const listeners = live.roomListenerCounts[room.id] ?? 0;
                return (
                  <li key={room.id}>
                    <span>{room.name}</span>
                    <small>
                      {listeners} {listeners === 1 ? "listener" : "listeners"}
                    </small>
                  </li>
                );
              })}
            </ul>
            {warnings.length > 1 ? (
              <ul className="admin-live-warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
