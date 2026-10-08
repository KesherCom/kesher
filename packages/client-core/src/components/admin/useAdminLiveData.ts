import { useCallback, useEffect, useState } from "react";
import {
  fetchAdminUsers,
  getAdminDevices,
  getAdminStreamDecks,
  getRealtimeStats,
  getStatus,
} from "../../api";
import type {
  Device,
  RealtimeStatsResponse,
  StreamDeckDevice,
  UserWithOnlineStatus,
} from "../../types";

export type AdminLiveData = {
  users: UserWithOnlineStatus[];
  devices: Device[];
  decks: StreamDeckDevice[];
  stats: RealtimeStatsResponse | null;
  roomListenerCounts: Record<string, number>;
  error: string;
  loaded: boolean;
};

const emptyLiveData: AdminLiveData = {
  users: [],
  devices: [],
  decks: [],
  stats: null,
  roomListenerCounts: {},
  error: "",
  loaded: false,
};

const POLL_MS = 3000;

/**
 * What is happening right now, for the admin console's Live page and its
 * navigation badges. Each source fails on its own, so one broken endpoint
 * does not blank the whole page.
 */
export function useAdminLiveData(token: string, adminPin: string) {
  const [data, setData] = useState<AdminLiveData>(emptyLiveData);

  const load = useCallback(async () => {
    const [users, devices, decks, stats, status] = await Promise.allSettled([
      fetchAdminUsers(token, adminPin),
      getAdminDevices(token, adminPin),
      getAdminStreamDecks(token, adminPin),
      getRealtimeStats(token, adminPin),
      getStatus(token),
    ]);
    setData((prev) => ({
      users:
        users.status === "fulfilled"
          ? users.value.filter((u) => u.id !== "admin" && u.username.toLowerCase() !== "admin")
          : prev.users,
      devices: devices.status === "fulfilled" ? devices.value : prev.devices,
      decks: decks.status === "fulfilled" ? decks.value.decks ?? [] : prev.decks,
      stats: stats.status === "fulfilled" ? stats.value : prev.stats,
      roomListenerCounts:
        status.status === "fulfilled" ? status.value.roomListenerCounts ?? {} : prev.roomListenerCounts,
      error: users.status === "rejected" ? "The server does not answer." : "",
      loaded: true,
    }));
  }, [token, adminPin]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { data, reload: load };
}

/** Problems an admin should look at, with the section that fixes them. */
export function serverWarnings(stats: RealtimeStatsResponse | null): string[] {
  if (!stats) return [];
  const warnings: string[] = [];
  const dropped = stats.hub.droppedCriticalMessages + stats.hub.droppedNormalMessages;
  if (dropped > 0) warnings.push(`${dropped} messages dropped (slow clients)`);
  if (stats.hub.priorityQueueDepthMax > 64 || stats.hub.normalQueueDepthMax > 256) {
    warnings.push("Message queues are filling up");
  }
  if (stats.media.syncRunMaxMs > 50) {
    warnings.push(`Audio routing slow (up to ${Math.round(stats.media.syncRunMaxMs)} ms)`);
  }
  return warnings;
}
