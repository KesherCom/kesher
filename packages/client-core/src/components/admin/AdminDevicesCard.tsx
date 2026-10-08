import { useCallback, useEffect, useRef, useState } from "react";
import { deleteAdminDevice, getAdminDevices, updateAdminDevice } from "../../api";
import type { Bootstrap, Device } from "../../types";
import { useAdminCardDefaultOpen } from "./adminCardOpen";

type AdminDevicesCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

type DeviceDraft = { name: string; roleId: string; mode: Device["mode"] };

const POLL_MS = 5000;

function timeAgo(ms: number): string {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Hardware stations (Raspberry Pi with kesher-node). A new station shows up
 * here by itself; approving it with a name and a role is all the setup it
 * needs. See docs/hardware/raspberry-pi.md.
 */
export function AdminDevicesCard({ token, adminPin, appData }: AdminDevicesCardProps) {
  const [isOpen, setIsOpen] = useState(useAdminCardDefaultOpen());
  const [devices, setDevices] = useState<Device[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DeviceDraft>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const openedForPending = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await getAdminDevices(token, adminPin);
      setDevices(list);
      setError("");
      // A station waiting for approval opens the card once.
      if (!openedForPending.current && list.some((d) => d.status === "pending")) {
        openedForPending.current = true;
        setIsOpen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load devices");
    }
  }, [token, adminPin]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  function draftFor(device: Device): DeviceDraft {
    return (
      drafts[device.id] ?? {
        name: device.name,
        roleId: device.roleId || appData.roles[0]?.id || "",
        mode: device.mode || "ptt",
      }
    );
  }

  function setDraft(device: Device, patch: Partial<DeviceDraft>) {
    setDrafts((prev) => ({ ...prev, [device.id]: { ...draftFor(device), ...patch } }));
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  function save(device: Device, status: Device["status"]) {
    const draft = draftFor(device);
    void run(async () => {
      await updateAdminDevice(token, adminPin, device.id, { ...draft, status });
      setEditing(null);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[device.id];
        return next;
      });
    });
  }

  function remove(device: Device) {
    if (!window.confirm(`Remove station "${device.name}"? It has to be approved again to rejoin.`)) return;
    void run(() => deleteAdminDevice(token, adminPin, device.id));
  }

  const roleName = (id: string) => appData.roles.find((r) => r.id === id)?.name ?? id;
  const pending = devices.filter((d) => d.status === "pending");
  const others = devices.filter((d) => d.status !== "pending");

  function settingsForm(device: Device, primaryLabel: string) {
    const draft = draftFor(device);
    const nameInvalid = !draft.name.trim() || /\s/.test(draft.name);
    return (
      <div className="admin-edit-panel">
        <div className="admin-grid">
          <label>
            <span>Name in the user list</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft(device, { name: e.target.value.replace(/\s+/g, "-") })}
              disabled={busy}
            />
          </label>
          <label>
            <span>Role</span>
            <select value={draft.roleId} onChange={(e) => setDraft(device, { roleId: e.target.value })} disabled={busy}>
              {appData.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Talk mode</span>
            <select
              value={draft.mode}
              onChange={(e) => setDraft(device, { mode: e.target.value as Device["mode"] })}
              disabled={busy}
            >
              <option value="ptt">Push to talk (button)</option>
              <option value="always_on">Always on (button mutes)</option>
            </select>
          </label>
        </div>
        <div className="admin-form-actions">
          <button onClick={() => save(device, "approved")} disabled={busy || nameInvalid || !draft.roleId}>
            {primaryLabel}
          </button>
          {device.status === "pending" ? (
            <button className="secondary" onClick={() => save(device, "rejected")} disabled={busy || nameInvalid}>
              Reject
            </button>
          ) : (
            <button className="secondary" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">
          Stations (Raspberry Pi)
          {pending.length > 0 ? <span className="admin-device-badge">{pending.length} new</span> : null}
        </div>
        <div className="admin-card-actions">
          <button className="admin-toggle-button" onClick={() => setIsOpen((v) => !v)} aria-expanded={isOpen}>
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <p>
            A new station appears here by itself after it is switched on in the same network. Give it a name and a
            role and approve it; it connects within a few seconds.
          </p>
          {error ? <p className="admin-error">{error}</p> : null}

          {pending.length > 0 ? (
            <div className="admin-block">
              <div className="admin-block-header">
                <h4>Waiting for approval</h4>
              </div>
              {pending.map((device) => (
                <div key={device.id} className="admin-device">
                  <div className="admin-device-head">
                    <strong>{device.hostname || device.name}</strong>
                    <small>
                      {device.model || "unknown model"} · {device.lastIp} · kesher-node {device.version || "?"} · seen{" "}
                      {timeAgo(device.lastSeenAt)}
                    </small>
                  </div>
                  {settingsForm(device, "Approve")}
                </div>
              ))}
            </div>
          ) : null}

          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Stations</h4>
            </div>
            <ul className="admin-list">
              {others.length === 0 ? (
                <li>
                  <span className="admin-empty">No stations yet.</span>
                </li>
              ) : (
                others.map((device) => (
                  <li key={device.id} className="admin-device-row">
                    {editing === device.id ? (
                      <div className="admin-device">{settingsForm(device, "Save")}</div>
                    ) : (
                      <>
                        <span>
                          <span
                            className={`admin-device-dot ${device.online ? "online" : ""}`}
                            title={device.online ? "connected" : "not connected"}
                          />
                          <strong>{device.name}</strong>
                          {device.status === "rejected" ? (
                            <> · rejected</>
                          ) : (
                            <>
                              {" "}
                              · {roleName(device.roleId)} · {device.mode === "always_on" ? "always on" : "push to talk"}
                            </>
                          )}{" "}
                          <small>
                            {device.model} · {device.lastIp} · {device.version} ·{" "}
                            {device.online ? "online" : `seen ${timeAgo(device.lastSeenAt)}`}
                          </small>
                        </span>
                        <span className="admin-device-actions">
                          <button className="secondary" onClick={() => setEditing(device.id)} disabled={busy}>
                            {device.status === "rejected" ? "Approve…" : "Edit"}
                          </button>
                          <button className="secondary" onClick={() => remove(device)} disabled={busy}>
                            Remove
                          </button>
                        </span>
                      </>
                    )}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
