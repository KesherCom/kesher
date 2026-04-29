/**
 * Pure utility functions for presence list normalisation and audio metering.
 */
import { toStringArray } from "./normalize";
import { sameStringArray } from "../app/utils";
import type { Presence } from "../types";

// ── Audio level constants ─────────────────────────────────────────────────────

export const meterDbFsFloor = -60;

export function peakAmplitudeToDbFs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return meterDbFsFloor;
  if (value >= 1) return 0;
  return Math.max(meterDbFsFloor, 20 * Math.log10(value));
}

// ── Presence helpers ──────────────────────────────────────────────────────────

export function normalizePresenceList(value: unknown): Presence[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const voiceMode = record.voiceMode === "always_on" ? "always_on" : "ptt";
    return {
      ...record,
      userId: typeof record.userId === "string" ? record.userId : "",
      username: typeof record.username === "string" ? record.username : "",
      roleId: typeof record.roleId === "string" ? record.roleId : "",
      listenRooms: toStringArray(record.listenRooms),
      talkRooms: toStringArray(record.talkRooms),
      voiceMode,
      micEnabled: Boolean(record.micEnabled),
      broadcastActive: Boolean(record.broadcastActive),
    };
  });
}

export function samePresenceList(a: Presence[], b: Presence[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.userId !== right.userId ||
      left.username !== right.username ||
      left.roleId !== right.roleId ||
      left.voiceMode !== right.voiceMode ||
      left.micEnabled !== right.micEnabled ||
      left.broadcastActive !== right.broadcastActive
    )
      return false;
    if (
      !sameStringArray(left.listenRooms ?? [], right.listenRooms ?? []) ||
      !sameStringArray(left.talkRooms ?? [], right.talkRooms ?? [])
    )
      return false;
  }
  return true;
}
