import React from "react";
import { getRealtimeStats } from "../../api";
import type { RealtimeStatsResponse } from "../../types";

type AdminMonitoringCardProps = {
  token: string;
  adminPin: string;
  audioStats: {
    inKbps: number;
    outKbps: number;
    jitterMs: number;
    roundTripMs: number;
    playoutDelayMs: number;
  };
  activeRoutesCount: number;
};
const runtimeStatsPollIntervalMs = 2000;

function formatHitRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total <= 0) return "n/a";
  return `${Math.round((hits / total) * 100)}%`;
}

export function AdminMonitoringCard({
  token,
  adminPin,
  audioStats,
  activeRoutesCount,
}: AdminMonitoringCardProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [stats, setStats] = React.useState<RealtimeStatsResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    let inFlight = false;

    async function pollStats() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getRealtimeStats(token, adminPin);
        if (cancelled) return;
        setStats(next);
        setError("");
      } catch (pollError) {
        if (cancelled) return;
        setError(
          pollError instanceof Error
            ? pollError.message
            : "failed to load realtime stats",
        );
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    void pollStats();
    const intervalId = window.setInterval(() => {
      void pollStats();
    }, runtimeStatsPollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isOpen, token, adminPin]);

  const droppedByType = stats
    ? Object.entries(stats.hub.droppedMessagesByType).sort(
        (a, b) => b[1] - a[1],
      )
    : [];

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Monitoring · Audio / RTP</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body admin-metrics">
          <div className="admin-metric">
            <div className="admin-metric-label">Inbound</div>
            <div className="admin-metric-value">{audioStats.inKbps} kbps</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Outbound</div>
            <div className="admin-metric-value">{audioStats.outKbps} kbps</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">RTP jitter</div>
            <div className="admin-metric-value">{audioStats.jitterMs} ms</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">RTT</div>
            <div className="admin-metric-value">{audioStats.roundTripMs} ms</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Playout delay</div>
            <div className="admin-metric-value">{audioStats.playoutDelayMs} ms</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Active routes</div>
            <div className="admin-metric-value">{activeRoutesCount}</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Connected clients</div>
            <div className="admin-metric-value">
              {stats ? stats.hub.connectedClients : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Queue normal (total/max)</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.hub.normalQueueDepthTotal} / ${stats.hub.normalQueueDepthMax}`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Queue priority (total/max)</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.hub.priorityQueueDepthTotal} / ${stats.hub.priorityQueueDepthMax}`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Dropped critical</div>
            <div className="admin-metric-value">
              {stats ? stats.hub.droppedCriticalMessages : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Dropped normal</div>
            <div className="admin-metric-value">
              {stats ? stats.hub.droppedNormalMessages : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Presence broadcasts/merged</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.hub.presenceBroadcasts} / ${stats.hub.presenceBroadcastsMerged}`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Media peers/sources</div>
            <div className="admin-metric-value">
              {stats ? `${stats.media.peers} / ${stats.media.sources}` : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Routing sync req/runs</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.media.syncRequests} / ${stats.media.syncRuns}`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Sync requests coalesced</div>
            <div className="admin-metric-value">
              {stats ? stats.media.syncRequestsCoalesced : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Sync run avg/max</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.media.syncRunAvgMs} / ${stats.media.syncRunMaxMs} ms`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Voice state to sync avg/max</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.media.voiceStateToSyncAvgMs} / ${stats.media.voiceStateToSyncMaxMs} ms`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Renegotiations</div>
            <div className="admin-metric-value">
              {stats ? stats.media.renegotiations : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Renegotiation avg/max</div>
            <div className="admin-metric-value">
              {stats
                ? `${stats.media.renegotiationAvgMs} / ${stats.media.renegotiationMaxMs} ms`
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Party line policy cache hit rate</div>
            <div className="admin-metric-value">
              {stats
                ? formatHitRate(
                    stats.storePolicyCache.roomPolicyHits,
                    stats.storePolicyCache.roomPolicyMisses,
                  )
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Broadcast allowed hit rate</div>
            <div className="admin-metric-value">
              {stats
                ? formatHitRate(
                    stats.storePolicyCache.broadcastAllowedHits,
                    stats.storePolicyCache.broadcastAllowedMisses,
                  )
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Broadcast party line hit rate</div>
            <div className="admin-metric-value">
              {stats
                ? formatHitRate(
                    stats.storePolicyCache.broadcastRoomHits,
                    stats.storePolicyCache.broadcastRoomMisses,
                  )
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Forced listen hit rate</div>
            <div className="admin-metric-value">
              {stats
                ? formatHitRate(
                    stats.storePolicyCache.forcedListenHits,
                    stats.storePolicyCache.forcedListenMisses,
                  )
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Last update</div>
            <div className="admin-metric-value">
              {stats
                ? new Date(stats.timestampUnixMs).toLocaleTimeString()
                : "—"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Runtime poll</div>
            <div className="admin-metric-value">
              {loading ? "Loading…" : "Live (2s)"}
            </div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Dropped message types</div>
            <div className="admin-metric-value">
              {droppedByType.length > 0
                ? droppedByType
                    .slice(0, 3)
                    .map(([msgType, count]) => `${msgType}:${count}`)
                    .join(", ")
                : "none"}
            </div>
          </div>
          {error ? (
            <div className="admin-metric">
              <div className="admin-metric-label">Runtime poll error</div>
              <div className="admin-metric-value">{error}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
