import { useMemo, useState } from "react";
import { exportAdminLogsText, getAdminLogs } from "../../api";
import type { AdminLogEntry } from "../../types";

type AdminLogsCardProps = {
  token: string;
  adminPin: string;
};

const defaultPageSize = 100;

function formatTimestamp(unixMs: number): string {
  if (!Number.isFinite(unixMs) || unixMs <= 0) return "-";
  return new Date(unixMs).toLocaleString();
}

function toUnixMs(datetimeLocal: string): number | undefined {
  if (!datetimeLocal.trim()) return undefined;
  const parsed = Date.parse(datetimeLocal);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

export function AdminLogsCard({ token, adminPin }: AdminLogsCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<AdminLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [queryText, setQueryText] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");

  const query = useMemo(
    () => ({
      level: level || undefined,
      category: category || undefined,
      q: queryText.trim() || undefined,
      from: toUnixMs(fromLocal),
      to: toUnixMs(toLocal),
      limit: defaultPageSize,
      offset,
    }),
    [category, fromLocal, level, offset, queryText, toLocal],
  );

  async function loadLogs(nextOffset = offset) {
    setLoading(true);
    setError("");
    try {
      const response = await getAdminLogs(token, adminPin, {
        ...query,
        offset: nextOffset,
      });
      setEntries(response.entries);
      setTotal(response.total);
      setOffset(nextOffset);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "failed to load logs");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleOpen() {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen && entries.length === 0) {
      await loadLogs(0);
    }
  }

  async function handleApplyFilters() {
    await loadLogs(0);
  }

  function handleResetFilters() {
    setLevel("");
    setCategory("");
    setQueryText("");
    setFromLocal("");
    setToLocal("");
  }

  async function handleDownload() {
    setDownloading(true);
    setError("");
    try {
      const text = await exportAdminLogsText(token, adminPin, {
        ...query,
        offset: 0,
      });
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:]/g, "-").replace(/[.]/g, "_");
      anchor.href = url;
      anchor.download = `kesher-admin-logs-${timestamp}.txt`;
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "export failed");
    } finally {
      setDownloading(false);
    }
  }

  const canPrev = offset > 0;
  const canNext = offset + entries.length < total;

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Logs · Request / Audit / Errors</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => void handleToggleOpen()}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-logs-filters">
            <label>
              <span>Level</span>
              <select value={level} onChange={(event) => setLevel(event.target.value)}>
                <option value="">All</option>
                <option value="INFO">INFO</option>
                <option value="WARN">WARN</option>
                <option value="ERROR">ERROR</option>
              </select>
            </label>
            <label>
              <span>Category</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All</option>
                <option value="request">request</option>
                <option value="audit">audit</option>
                <option value="error">error</option>
              </select>
            </label>
            <label>
              <span>Search</span>
              <input
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder="message, path, user..."
              />
            </label>
            <label>
              <span>From</span>
              <input
                type="datetime-local"
                value={fromLocal}
                onChange={(event) => setFromLocal(event.target.value)}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="datetime-local"
                value={toLocal}
                onChange={(event) => setToLocal(event.target.value)}
              />
            </label>
          </div>

          <div className="admin-form-actions">
            <button onClick={() => void handleApplyFilters()} disabled={loading}>
              {loading ? "Loading..." : "Apply filters"}
            </button>
            <button
              className="secondary"
              onClick={handleResetFilters}
              disabled={loading || downloading}
            >
              Reset filters
            </button>
            <button onClick={() => void handleDownload()} disabled={downloading}>
              {downloading ? "Exporting..." : "Download TXT"}
            </button>
          </div>

          <div className="admin-logs-meta">
            <span>Total: {total}</span>
            <span>Showing: {entries.length}</span>
            <span>Offset: {offset}</span>
          </div>

          <div className="admin-logs-table-wrap">
            <table className="admin-logs-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Category</th>
                  <th>Request</th>
                  <th>User</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="admin-logs-empty">
                      No log entries found.
                    </td>
                  </tr>
                ) : (
                  entries.map((entry, idx) => (
                    <tr key={`${entry.timestampUnixMs}-${entry.category}-${idx}`}>
                      <td>{formatTimestamp(entry.timestampUnixMs)}</td>
                      <td>{entry.level}</td>
                      <td>{entry.category}</td>
                      <td>
                        {entry.method || entry.path
                          ? `${entry.method ?? ""} ${entry.path ?? ""} ${
                              entry.status ? `(${entry.status})` : ""
                            }`.trim()
                          : "-"}
                      </td>
                      <td>
                        {entry.username
                          ? `${entry.username}${entry.roleId ? ` (${entry.roleId})` : ""}`
                          : "-"}
                      </td>
                      <td>{entry.error ? `${entry.message} (${entry.error})` : entry.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="admin-form-actions">
            <button
              className="secondary"
              onClick={() => void loadLogs(Math.max(0, offset - defaultPageSize))}
              disabled={!canPrev || loading}
            >
              Previous
            </button>
            <button
              className="secondary"
              onClick={() => void loadLogs(offset + defaultPageSize)}
              disabled={!canNext || loading}
            >
              Next
            </button>
            <button className="secondary" onClick={() => void loadLogs(offset)} disabled={loading}>
              Refresh
            </button>
          </div>

          {error ? <p className="admin-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
