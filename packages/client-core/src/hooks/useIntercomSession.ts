import { useCallback, useEffect, useRef, useState } from "react";
import { bootstrap, buildWebSocketUrl, normalizePublicBootstrap } from "../api";
import {
  matrixAnchorRoomId,
  mergeForcedListenRooms,
  resolveChatTargetRoomId,
  roleAllowed,
  toggleRoomSelectionState,
} from "../lib/intercom";
import { normalizePresenceList, samePresenceList } from "../lib/presence";
import {
  clampGainValue,
  clampInputGainValue,
  micInputBaseBoost,
} from "../app/settings";
import { gainWithDbDelta } from "../lib/streamDeckBridge";
import {
  sameStringArray,
  sameStringSet,
  sourceUserIDFromRemoteSDPMid,
  sourceUserIDFromTrackID,
} from "../app/utils";
import type {
  Bootstrap,
  ChatAckUpdate,
  Presence,
  PublicBootstrap,
  RoutedEvent,
  SessionRevokedEvent,
} from "../types";
import { useLocalMic } from "./useLocalMic";
import { useRemoteAudio } from "./useRemoteAudio";
import { useRtpStats } from "./useRtpStats";
import type { RtpStats } from "./useRtpStats";
import type { NativeAudioHook } from "./useNativeAudio";

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (
    type: "release",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
};

type NavigatorWithAudioSession = Navigator & {
  audioSession?: {
    type?: string;
  };
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

// ── WS message types ───────────────────────────────────────────────────────────────────────────────

type WsMessage =
  | { type: "presence"; data: Presence[] }
  | { type: "chat"; data: RoutedEvent }
  | { type: "chat_ack"; data: ChatAckUpdate }
  | { type: "chat_history_cleared"; data: { timestamp?: number } }
  | { type: "signal"; data: RoutedEvent }
  | { type: "voice_state"; data: RoutedEvent }
  | {
      type: "companion_command";
      data: {
        commandId?: string;
        command: string;
        mode?: "always_on" | "ptt";
        scope?: "direct" | "room" | "broadcast";
        targetId?: string;
        state?: "ptt_start" | "ptt_stop";
        signal?: string;
        volumeDelta?: number;
        listenRoomIds?: string[];
        talkRoomIds?: string[];
        brightness?: number;
        pageNumber?: number;
      };
    }
  | { type: "webrtc_offer"; data: { sdp: string } }
  | {
      type: "webrtc_ice_candidate";
      data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number };
    }
  | { type: "session_revoked"; data: SessionRevokedEvent }
  | { type: "config_updated"; data: unknown };
const opusMaxBitrateBps = 24000;

// Opus ptime/minptime can be overridden at runtime via localStorage for A/B
// latency testing.  Set `localStorage.setItem('opus_ptime', '2.5')` and reload.
// Valid values: "2.5", "5", "10", "20".  Default is "2.5".
function getOpusPtime(): string {
  try {
    const v = localStorage.getItem("opus_ptime");
    if (v && ["2.5", "5", "10", "20"].includes(v)) return v;
  } catch {
    /* ignore */
  }
  return "2.5";
}
function getOpusMinPtime(): string {
  try {
    const v = localStorage.getItem("opus_minptime");
    if (v && ["2.5", "5", "10", "20"].includes(v)) return v;
  } catch {
    /* ignore */
  }
  return "2.5";
}

const opusSpeechFmtpParams: ReadonlyArray<readonly [string, string]> = [
  ["stereo", "0"],
  ["sprop-stereo", "0"],
  ["useinbandfec", "1"],
  ["usedtx", "0"],
  ["cbr", "1"],
  ["ptime", getOpusPtime()],
  ["minptime", getOpusMinPtime()],
  ["maxaveragebitrate", `${opusMaxBitrateBps}`],
];

const directRoutePriorityLevel = 3;
const defaultRoutePriorityLevel = 1;
const duckingGainLinear = 0.1;

function getRoomMatrixSyncDebounceMs(): number {
  try {
    const raw = localStorage.getItem("room_matrix_debounce_ms");
    if (raw != null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.max(5, Math.min(60, Math.trunc(parsed)));
      }
    }
  } catch {
    /* ignore */
  }
  return 20;
}

const roomMatrixSyncDebounceMs = getRoomMatrixSyncDebounceMs();

function clampPriorityLevel(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultRoutePriorityLevel;
  }
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

type GainRoute = {
  senderUserID: string;
  scope: "direct" | "room" | "broadcast";
  targetID: string;
};

type GainPresence = {
  userId: string;
  voiceMode?: "ptt" | "always_on";
  micEnabled?: boolean;
  talkRooms?: string[];
};

type ResolveUnknownSourceGainOptions = {
  routes: GainRoute[];
  selfUserID: string;
  listenRoomIDs: string[];
  talkRoomIDs: string[];
  roomGainById: Record<string, number>;
  directGainByUserId: Record<string, number>;
  presence: GainPresence[];
  clampGain: (value: number) => number;
};

export function resolveUnknownSourceGain({
  routes,
  selfUserID,
  listenRoomIDs,
  talkRoomIDs,
  roomGainById,
  directGainByUserId,
  presence,
  clampGain,
}: ResolveUnknownSourceGainOptions): number {
  const directToSelfRoutes = routes.filter(
    (route) => route.scope === "direct" && route.targetID === selfUserID,
  );
  if (directToSelfRoutes.length > 0) {
    let maxDirectGain = 0;
    for (const route of directToSelfRoutes) {
      maxDirectGain = Math.max(
        maxDirectGain,
        clampGain(directGainByUserId[route.senderUserID] ?? 1),
      );
    }
    if (maxDirectGain > 0) return maxDirectGain;
  }

  let maxRoomGain = 0;
  let sawRoomCandidate = false;
  for (const route of routes) {
    if (route.scope !== "room") continue;
    if (!listenRoomIDs.includes(route.targetID)) continue;
    sawRoomCandidate = true;
    maxRoomGain = Math.max(
      maxRoomGain,
      clampGain(roomGainById[route.targetID] ?? 1),
    );
  }
  if (sawRoomCandidate) return maxRoomGain;

  for (const p of presence) {
    if (p.userId === selfUserID) continue;
    if (p.voiceMode !== "always_on" || !p.micEnabled) continue;
    for (const roomId of p.talkRooms || []) {
      if (!listenRoomIDs.includes(roomId)) continue;
      sawRoomCandidate = true;
      maxRoomGain = Math.max(maxRoomGain, clampGain(roomGainById[roomId] ?? 1));
    }
  }
  if (sawRoomCandidate) return maxRoomGain;

  const anchorRoomID = matrixAnchorRoomId(listenRoomIDs, talkRoomIDs);
  if (anchorRoomID) {
    return clampGain(roomGainById[anchorRoomID] ?? 1);
  }

  if (listenRoomIDs.length > 0) {
    let fallbackRoomGain = 0;
    for (const roomID of listenRoomIDs) {
      fallbackRoomGain = Math.max(
        fallbackRoomGain,
        clampGain(roomGainById[roomID] ?? 1),
      );
    }
    if (fallbackRoomGain > 0) return fallbackRoomGain;
  }

  return 1;
}

export function upsertFmtpParams(existing: string): string {
  const desired = Object.fromEntries(opusSpeechFmtpParams) as Record<
    string,
    string
  >;
  const parts = existing
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const next = parts.map((part) => {
    const [rawKey] = part.split("=");
    const key = rawKey.trim().toLowerCase();
    if (!(key in desired)) return part;
    seen.add(key);
    return `${key}=${desired[key] || ""}`;
  });
  for (const [key, value] of Object.entries(desired)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  return next.join(";");
}

export function tuneOpusSdpForSpeech(sdp: string): string {
  if (!sdp) return sdp;
  const lines = sdp.split("\r\n");
  const opusPayloadTypes = lines.flatMap((line) => {
    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?$/i);
    return match ? [match[1]] : [];
  });
  if (opusPayloadTypes.length === 0) return sdp;
  for (const payloadType of opusPayloadTypes) {
    const fmtpPrefix = `a=fmtp:${payloadType}`;
    const fmtpIndex = lines.findIndex(
      (line) => line === fmtpPrefix || line.startsWith(`${fmtpPrefix} `),
    );
    if (fmtpIndex >= 0) {
      const currentParams = lines[fmtpIndex].slice(fmtpPrefix.length).trim();
      lines[fmtpIndex] = `${fmtpPrefix} ${upsertFmtpParams(currentParams)}`;
      continue;
    }
    const rtpmapIndex = lines.findIndex((line) =>
      new RegExp(`^a=rtpmap:${payloadType}\\s+`, "i").test(line),
    );
    const nextFmtpLine = `${fmtpPrefix} ${upsertFmtpParams("")}`;
    if (rtpmapIndex >= 0) {
      lines.splice(rtpmapIndex + 1, 0, nextFmtpLine);
    } else {
      lines.push(nextFmtpLine);
    }
  }
  return lines.join("\r\n");
}

type ReceiverWithPlayoutDelayHint = {
  playoutDelayHint?: number;
};

export function trySetReceiverPlayoutDelayHint(
  receiver: unknown,
  delayHint: number,
): boolean {
  if (
    !receiver ||
    typeof receiver !== "object" ||
    typeof delayHint !== "number" ||
    !Number.isFinite(delayHint) ||
    !("playoutDelayHint" in receiver)
  ) {
    return false;
  }
  try {
    (receiver as ReceiverWithPlayoutDelayHint).playoutDelayHint = delayHint;
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate adaptive playout delay hint based on network RTT and jitter.
 * - LAN (RTT < 5ms, jitter < 5ms): 0 ms (aggressive)
 * - Good network: 20-50 ms
 * - Moderate: 50-100 ms  
 * - Poor: up to 150 ms
 * Returns hint in seconds (0.0–0.15) for setReceiverPlayoutDelayHint().
 */
export function getAdaptivePlayoutDelayHint(
  roundTripMs: number,
  jitterMs: number,
): number {
  if (roundTripMs < 5 && jitterMs < 5) {
    // LAN: aggressive
    return 0;
  }
  if (roundTripMs < 20 && jitterMs < 10) {
    // Good network: minimal buffer
    return 0.02; // 20 ms
  }
  if (roundTripMs < 50) {
    // Moderate RTT: moderate buffer
    return 0.05; // 50 ms
  }
  if (roundTripMs < 100) {
    // Higher RTT: increase buffer
    return 0.1; // 100 ms
  }
  // Poor network: maximum buffer
  return 0.15; // 150 ms
}

function isMobileClient(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const isMobileUserAgent = /Android|iPhone|iPad|iPod|Mobi/i.test(ua);
  const isCoarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return isMobileUserAgent || isCoarsePointer;
}

async function applyOutgoingAudioSenderBitrate(pc: RTCPeerConnection) {
  const audioSender = pc
    .getSenders()
    .find((sender) => sender.track?.kind === "audio");
  if (!audioSender) return;
  const params = audioSender.getParameters();
  const encodings = params.encodings?.length ? params.encodings : [{}];
  const firstEncoding = encodings[0] ?? {};
  params.encodings = [
    {
      ...firstEncoding,
      maxBitrate: opusMaxBitrateBps,
    },
    ...encodings.slice(1),
  ];
  try {
    await audioSender.setParameters(params);
  } catch (err) {
    console.warn("Failed to tune outgoing audio sender bitrate", err);
  }
}

// ── Exported types ────────────────────────────────────────────────────────────────────────

export type VoiceRoute = {
  senderUserID: string;
  scope: "direct" | "room" | "broadcast";
  targetID: string;
  label: string;
};

export type UseIntercomSessionOptions = {
  token: string | null;
  appData: Bootstrap | null;
  authMode: "operator" | "admin";
  showDebug: boolean;

  // Settings refs (stable across renders)
  selectedInputDeviceId: string;
  selectedInputDeviceIdRef: React.MutableRefObject<string>;
  selectedOutputDeviceId: string;
  selectedOutputDeviceIdRef: React.MutableRefObject<string>;
  inputGainByDeviceId: Record<string, number>;
  inputGainByDeviceIdRef: React.MutableRefObject<Record<string, number>>;
  roomGainById: Record<string, number>;
  roomGainByIdRef: React.MutableRefObject<Record<string, number>>;
  directGainByUserId: Record<string, number>;
  directGainByUserIdRef: React.MutableRefObject<Record<string, number>>;
  enableDirectPpt: boolean;
  enableBackgroundAudioRecovery: boolean;
  keepScreenAwake: boolean;
  isUserSettingsOpen: boolean;
  isUserSettingsOpenRef: React.MutableRefObject<boolean>;
  audioGateEnabled: boolean;
  audioGateThresholdDb: number;
  selectedInputGainFor: (deviceId: string) => number;
  onInputGainChange: (deviceId: string, gain: number) => void;

  // Initial room matrix from session storage
  initialListenRoomIds: string[];
  initialTalkRoomIds: string[];
  hadStoredSessionSettings: boolean;
  initialVoiceMode?: "always_on" | "ptt";

  // Callbacks that update App.tsx state
  onUpdateAppData: React.Dispatch<React.SetStateAction<Bootstrap | null>>;
  onUpdatePublicData: React.Dispatch<
    React.SetStateAction<PublicBootstrap | null>
  >;
  onRefreshAudioDevices: () => Promise<void>;
  onSessionRevoked: () => void;
  onStreamDeckHardwareCommand?: (cmd: {
    command: string;
    brightness?: number;
  }) => void;
  /**
   * Optional native audio engine (Tauri desktop only).
   * When provided and `isNative=true`, WebRTC negotiation and PTT are
   * handled by the Rust audio engine instead of the browser RTCPeerConnection.
   */
  nativeAudio?: NativeAudioHook;
};

export type UseIntercomSessionResult = {
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  presence: Presence[];
  chatMessages: Array<{
    from: string;
    fromUserId: string;
    body: string;
    at: string;
    room: string;
    self: boolean;
    scope: "direct" | "room" | "broadcast";
    targetId: string;
    targetType?: "room" | "user" | "role";
    messageId?: string;
    ackRequired?: boolean;
    acked?: boolean;
    ackedBy?: string;
    ackedAt?: string;
    source?: string;
  }>;
  events: Array<{ label: string; at: string }>;
  rtpStats: RtpStats;
  incomingAudioActive: boolean;
  activeVoiceRoutes: VoiceRoute[];
  incomingAttention: { title: string; detail: string } | null;
  lastCompanionCommand: {
    command: string;
    status: "executing" | "executed" | "rejected" | "failed";
    error?: string;
    at: number;
  } | null;
  attentionFlashKey: number;
  voiceMode: "always_on" | "ptt";
  voiceModeRef: React.RefObject<"always_on" | "ptt">;
  pttPressed: boolean;
  broadcastPttPressed: string | null;
  directPttPressedUserId: string | null;
  pttPressedChannelId: string | null;
  lastDirectCallerUserId: string | null;
  listenRoomIds: string[];
  talkRoomIds: string[];
  listenRoomIdsRef: React.RefObject<string[]>;
  talkRoomIdsRef: React.RefObject<string[]>;
  viewMode: "station" | "simple";
  message: string;
  setMessage: (v: string) => void;
  inputLevelDbFs: number;
  displayedInputClipping: boolean;
  isLocalMonitorActive: boolean;
  toggleLocalMonitor: () => Promise<void>;
  mediaSessionSupported: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  isStandaloneDisplayMode: boolean;

  // Actions
  startPtt: () => void;
  stopPtt: () => void;
  startBroadcastPtt: (groupId: string) => void;
  stopBroadcastPtt: (groupId: string) => void;
  startDirectPtt: (userId: string) => void;
  stopDirectPtt: (userId: string) => void;
  setAlwaysOn: (enabled: boolean) => void;
  handleEnableDirectPptChange: (enabled: boolean) => void;
  sendScopedSignal: (
    scope: "direct" | "room" | "broadcast",
    targetId: string,
    signal: string,
  ) => void;
  sendChat: (ackRequired?: boolean) => void;
  acknowledgeChatMessage: (messageId: string, senderUserId: string) => void;
  handleChannelPttStart: (channelId: string) => void;
  handleChannelPttStop: (channelId: string) => void;
  toggleListenRoom: (roomId: string) => void;
  toggleTalkRoom: (roomId: string) => void;
  applyBootstrapData: (data: Bootstrap, isInitial?: boolean) => void;
};

// ── Hook ────────────────────────────────────────────────────────────────────────────────

export function useIntercomSession({
  token,
  appData,
  authMode,
  showDebug,
  selectedInputDeviceId,
  selectedInputDeviceIdRef,
  selectedOutputDeviceId,
  selectedOutputDeviceIdRef,
  inputGainByDeviceId,
  inputGainByDeviceIdRef,
  roomGainById,
  roomGainByIdRef,
  directGainByUserId,
  directGainByUserIdRef,
  enableDirectPpt,
  enableBackgroundAudioRecovery,
  keepScreenAwake,
  isUserSettingsOpen,
  isUserSettingsOpenRef,
  audioGateEnabled,
  audioGateThresholdDb,
  selectedInputGainFor,
  onInputGainChange,
  initialListenRoomIds,
  initialTalkRoomIds,
  hadStoredSessionSettings,
  initialVoiceMode = "ptt",
  onUpdateAppData,
  onUpdatePublicData,
  onRefreshAudioDevices,
  onSessionRevoked,
  onStreamDeckHardwareCommand,
  nativeAudio,
}: UseIntercomSessionOptions): UseIntercomSessionResult {
  const forcePttOnMobile = isMobileClient();
  const resolveVoiceModeForClient = (
    mode: "always_on" | "ptt",
  ): "always_on" | "ptt" => (forcePttOnMobile ? "ptt" : mode);

  // ── State ──
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "reconnecting" | "offline"
  >("offline");
  const [, setAudioError] = useState("");
  const [, setWebrtcState] = useState("");
  const [presence, setPresence] = useState<Presence[]>([]);
  const [chatMessages, setChatMessages] = useState<
    Array<{
      from: string;
      fromUserId: string;
      body: string;
      at: string;
      room: string;
      self: boolean;
      scope: "direct" | "room" | "broadcast";
      targetId: string;
      targetType?: "room" | "user" | "role";
      messageId?: string;
      ackRequired?: boolean;
      acked?: boolean;
      ackedBy?: string;
      ackedAt?: string;
      source?: string;
    }>
  >([]);
  const [events, setEvents] = useState<Array<{ label: string; at: string }>>(
    [],
  );
  const [activeVoiceRoutes, setActiveVoiceRoutes] = useState<VoiceRoute[]>([]);
  const [incomingAttention, setIncomingAttention] = useState<{
    title: string;
    detail: string;
  } | null>(null);
  const [lastCompanionCommand, setLastCompanionCommand] = useState<{
    command: string;
    status: "executing" | "executed" | "rejected" | "failed";
    error?: string;
    at: number;
  } | null>(null);
  const [attentionFlashKey, setAttentionFlashKey] = useState(0);
  const [voiceMode, setVoiceMode] = useState<"always_on" | "ptt">(
    resolveVoiceModeForClient(initialVoiceMode),
  );
  const [pttPressed, setPttPressed] = useState(false);
  const [broadcastPttPressed, setBroadcastPttPressed] = useState<string | null>(
    null,
  );
  const [directPttPressedUserId, setdirectPttPressedUserId] = useState<
    string | null
  >(null);
  const [pttPressedChannelId, setPttPressedChannelId] = useState<string | null>(
    null,
  );
  const [lastDirectCallerUserId, setLastDirectCallerUserId] = useState<
    string | null
  >(null);
  const [listenRoomIds, setListenRoomIds] =
    useState<string[]>(initialListenRoomIds);
  const [talkRoomIds, setTalkRoomIds] = useState<string[]>(initialTalkRoomIds);
  const [viewMode, setViewMode] = useState<"station" | "simple">("station");
  const [message, setMessage] = useState("");
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [isStandaloneDisplayMode, setIsStandaloneDisplayMode] = useState(() => {
    if (typeof window === "undefined") return false;
    const navigatorWithStandalone = navigator as Navigator & {
      standalone?: boolean;
    };
    return (
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      navigatorWithStandalone.standalone === true
    );
  });
  const mediaSessionSupported =
    typeof navigator !== "undefined" && "mediaSession" in navigator;
  const wakeLockSupported =
    typeof navigator !== "undefined" &&
    "wakeLock" in (navigator as NavigatorWithAudioSession);

  // ── Refs ──
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const connectRealtimeRef = useRef<(() => Promise<void>) | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const enableBackgroundAudioRecoveryRef = useRef(
    enableBackgroundAudioRecovery,
  );
  const keepScreenAwakeRef = useRef(keepScreenAwake);
  const wakeLockSentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const pendingICERef = useRef<
    Array<{ candidate: string; sdpMid?: string; sdpMLineIndex?: number }>
  >([]);
  const activeVoiceRoutesRef = useRef<Map<string, VoiceRoute>>(new Map());
  const observedVoiceSendersRef = useRef<Set<string>>(new Set());
  const incomingAttentionTimeoutRef = useRef<number | null>(null);
  const roomSwitchTimerRef = useRef<number | null>(null);
  const pendingRoomMatrixEchoKeyRef = useRef<string | null>(null);
  const voiceModeRef = useRef<"always_on" | "ptt">(
    resolveVoiceModeForClient(initialVoiceMode),
  );
  const restoreAlwaysOnAfterDirectPttRef = useRef(false);
  const prevChannelRef = useRef<string>("");
  const pendingInitialRoomRestoreRef = useRef(hadStoredSessionSettings);
  const appDataRef = useRef(appData);
  const listenRoomIdsRef = useRef<string[]>(initialListenRoomIds);
  const talkRoomIdsRef = useRef<string[]>(initialTalkRoomIds);
  const seenChatKeysRef = useRef<Set<string>>(new Set());

  // Sync refs
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
  useEffect(() => {
    listenRoomIdsRef.current = listenRoomIds;
  }, [listenRoomIds]);
  useEffect(() => {
    talkRoomIdsRef.current = talkRoomIds;
  }, [talkRoomIds]);
  useEffect(() => {
    appDataRef.current = appData;
  }, [appData]);
  useEffect(() => {
    enableBackgroundAudioRecoveryRef.current = enableBackgroundAudioRecovery;
  }, [enableBackgroundAudioRecovery]);
  useEffect(() => {
    keepScreenAwakeRef.current = keepScreenAwake;
  }, [keepScreenAwake]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const navigatorWithStandalone = navigator as Navigator & {
      standalone?: boolean;
    };
    const updateDisplayMode = () => {
      setIsStandaloneDisplayMode(
        mediaQuery.matches || navigatorWithStandalone.standalone === true,
      );
    };
    updateDisplayMode();
    mediaQuery.addEventListener?.("change", updateDisplayMode);
    return () => mediaQuery.removeEventListener?.("change", updateDisplayMode);
  }, []);

  // ── Presence ref (read inside callbacks without stale closure) ──
  const presenceRef = useRef<Presence[]>([]);
  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

  // ── Debug events ──
  const pushDebugEvent = useCallback(
    (label: string) => {
      if (!showDebug) return;
      setEvents((old) =>
        [{ label, at: new Date().toLocaleTimeString() }, ...old].slice(0, 200),
      );
    },
    [showDebug],
  );

  // ── Gain resolver (reads only refs → always-fresh; wrapped in ref for sub-hooks) ──
  function resolveGainForSourceUser(sourceUserID: string): number {
    const ad = appDataRef.current;
    if (!ad) return 1;
    const routes = Array.from(activeVoiceRoutesRef.current.values());

    const roomPriorityByID = (roomID: string): number => {
      const room = ad.rooms.find((entry) => entry.id === roomID);
      return clampPriorityLevel(room?.priorityLevel);
    };

    const broadcastPriorityByID = (groupID: string): number => {
      const group = ad.broadcastGroups.find((entry) => entry.id === groupID);
      return clampPriorityLevel(group?.priorityLevel);
    };

    const isRouteAudibleToSelf = (route: VoiceRoute): boolean => {
      if (route.scope === "direct") {
        return route.targetID === ad.self.id;
      }
      if (route.scope === "room") {
        return listenRoomIdsRef.current.includes(route.targetID);
      }
      const group = ad.broadcastGroups.find((entry) => entry.id === route.targetID);
      if (!group) return false;
      return (group.roomIds || []).some((roomID) =>
        listenRoomIdsRef.current.includes(roomID),
      );
    };

    const routePriority = (route: VoiceRoute): number => {
      if (route.scope === "direct" && route.targetID === ad.self.id) {
        return directRoutePriorityLevel;
      }
      if (route.scope === "room") {
        return roomPriorityByID(route.targetID);
      }
      if (route.scope === "broadcast") {
        return broadcastPriorityByID(route.targetID);
      }
      return defaultRoutePriorityLevel;
    };

    const maxPresencePriorityForSender = (senderUserID: string): number => {
      const senderPresence = presenceRef.current.find(
        (entry) => entry.userId === senderUserID,
      );
      if (
        !senderPresence ||
        !senderPresence.micEnabled ||
        !Array.isArray(senderPresence.talkRooms)
      ) {
        return -1;
      }
      let maxPriority = -1;
      for (const roomID of senderPresence.talkRooms) {
        if (!listenRoomIdsRef.current.includes(roomID)) continue;
        maxPriority = Math.max(maxPriority, roomPriorityByID(roomID));
      }
      return maxPriority;
    };

    const maxAudiblePriority = (): number => {
      let maxPriority = -1;
      for (const route of routes) {
        if (!isRouteAudibleToSelf(route)) continue;
        maxPriority = Math.max(maxPriority, routePriority(route));
      }
      for (const p of presenceRef.current) {
        if (p.userId === ad.self.id) continue;
        if (p.voiceMode !== "always_on" || !p.micEnabled) continue;
        const senderPriority = maxPresencePriorityForSender(p.userId);
        if (senderPriority >= 0) {
          maxPriority = Math.max(maxPriority, senderPriority);
        }
      }
      return maxPriority >= 0 ? maxPriority : defaultRoutePriorityLevel;
    };

    const applyDuckingForSource = (senderUserID: string, baseGain: number): number => {
      const maxPriority = maxAudiblePriority();
      let senderPriority = -1;
      for (const route of routes) {
        if (route.senderUserID !== senderUserID) continue;
        if (!isRouteAudibleToSelf(route)) continue;
        senderPriority = Math.max(senderPriority, routePriority(route));
      }
      if (senderPriority < 0) {
        senderPriority = maxPresencePriorityForSender(senderUserID);
      }
      if (senderPriority >= 0 && senderPriority < maxPriority) {
        return clampGainValue(baseGain * duckingGainLinear);
      }
      return clampGainValue(baseGain);
    };

    if (!sourceUserID) {
      return resolveUnknownSourceGain({
        routes,
        selfUserID: ad.self.id,
        listenRoomIDs: listenRoomIdsRef.current,
        talkRoomIDs: talkRoomIdsRef.current,
        roomGainById: roomGainByIdRef.current,
        directGainByUserId: directGainByUserIdRef.current,
        presence: presenceRef.current,
        clampGain: clampGainValue,
      });
    }
    const directToSelf = routes.some(
      (route) =>
        route.senderUserID === sourceUserID &&
        route.scope === "direct" &&
        route.targetID === ad.self.id,
    );
    if (directToSelf) {
      return applyDuckingForSource(
        sourceUserID,
        clampGainValue(directGainByUserIdRef.current[sourceUserID] ?? 1),
      );
    }
    const senderHasActiveRoute = routes.some(
      (route) => route.senderUserID === sourceUserID,
    );
    if (
      observedVoiceSendersRef.current.has(sourceUserID) &&
      !senderHasActiveRoute
    ) {
      return 0;
    }
    const senderPresence = presenceRef.current.find(
      (p) => p.userId === sourceUserID,
    );
    if (
      senderPresence &&
      senderPresence.micEnabled &&
      Array.isArray(senderPresence.talkRooms) &&
      senderPresence.talkRooms.length > 0
    ) {
      const listenedTalkRooms = senderPresence.talkRooms.filter((roomID) =>
        listenRoomIdsRef.current.includes(roomID),
      );
      if (listenedTalkRooms.length > 0) {
        return applyDuckingForSource(
          sourceUserID,
          clampGainValue(roomGainByIdRef.current[listenedTalkRooms[0]] ?? 1),
        );
      }
    }
    const routedRoom = routes.find(
      (route) =>
        route.senderUserID === sourceUserID &&
        route.scope === "room" &&
        listenRoomIdsRef.current.includes(route.targetID),
    );
    if (routedRoom) {
      return applyDuckingForSource(
        sourceUserID,
        clampGainValue(roomGainByIdRef.current[routedRoom.targetID] ?? 1),
      );
    }
    return applyDuckingForSource(sourceUserID, 1);
  }

  // Keep a stable ref so sub-hooks always call the latest version
  const resolveGainRef = useRef(resolveGainForSourceUser);
  resolveGainRef.current = resolveGainForSourceUser;

  // ── Sub-hooks ─────────────────────────────────────────────────────────────────────────────

  const mic = useLocalMic({
    selectedInputDeviceId,
    selectedInputDeviceIdRef,
    selectedInputGainFor,
    inputGainByDeviceId,
    audioGateEnabled,
    audioGateThresholdDb,
    isUserSettingsOpen,
    isUserSettingsOpenRef,
    voiceModeRef,
    pcRef,
    onAudioError: setAudioError,
    onRefreshAudioDevices,
    onAfterAudioSenderUpdated: applyOutgoingAudioSenderBitrate,
    enableReinit: !!(token && appData),
  });

  const { rtpStats, startStatsLoop, stopStatsLoop } = useRtpStats();
  const currentRtpStatsRef = useRef<RtpStats>(rtpStats);

  // Keep ref in sync with rtpStats for access in ontrack callbacks
  useEffect(() => {
    currentRtpStatsRef.current = rtpStats;
  }, [rtpStats]);

  useEffect(() => {
    if (!nativeAudio?.isNative) return;
    nativeAudio.setInputGain(
      clampInputGainValue(
        micInputBaseBoost *
          selectedInputGainFor(selectedInputDeviceIdRef.current),
      ),
    );
  }, [
    nativeAudio,
    selectedInputDeviceId,
    inputGainByDeviceId,
    selectedInputGainFor,
    selectedInputDeviceIdRef,
  ]);

  useEffect(() => {
    if (!nativeAudio?.isNative) return;
    nativeAudio.setAudioGate(audioGateEnabled, audioGateThresholdDb);
  }, [nativeAudio, audioGateEnabled, audioGateThresholdDb]);

  useEffect(() => {
    if (!nativeAudio?.isNative) return;
    if (!appDataRef.current) {
      nativeAudio.setOutputGains({});
      return;
    }

    const gainsByUserId: Record<string, number> = {};
    for (const user of appDataRef.current.users) {
      if (user.id === appDataRef.current.self.id) continue;
      gainsByUserId[user.id] = resolveGainForSourceUser(user.id);
    }
    nativeAudio.setOutputGains(gainsByUserId);
  }, [
    nativeAudio,
    appData,
    roomGainById,
    directGainByUserId,
    presence,
    activeVoiceRoutes,
    listenRoomIds,
    talkRoomIds,
    resolveGainForSourceUser,
  ]);

  const remote = useRemoteAudio({
    selectedOutputDeviceId,
    selectedOutputDeviceIdRef,
    roomGainById,
    directGainByUserId,
    resolveGainRef,
    onAudioError: setAudioError,
  });
  const {
    pauseAllRemoteAudio,
    retryPlayAllRemoteAudio,
    resumeRemoteAudioContexts,
  } = remote;

  // ── Voice route tracking ──
  function refreshActiveVoiceChannelState() {
    setActiveVoiceRoutes(Array.from(activeVoiceRoutesRef.current.values()));
    remote.applyVolumeToAllRemoteAudio();
  }

  function updateVoiceRoute(
    senderUserID: string,
    scopeValue: "direct" | "room" | "broadcast",
    targetID: string,
    body: string,
    fromUsername: string,
  ) {
    const ad = appDataRef.current;
    const routeKey = `${senderUserID}:${scopeValue}:${targetID}`;
    observedVoiceSendersRef.current.add(senderUserID);
    const label =
      scopeValue === "room"
        ? ad?.rooms.find((r) => r.id === targetID)?.name || targetID
        : scopeValue === "broadcast"
          ? ad?.broadcastGroups.find((g) => g.id === targetID)?.name || targetID
          : `Direct · ${fromUsername}`;
    if (body === "ptt_start" || body === "always_on") {
      activeVoiceRoutesRef.current.set(routeKey, {
        senderUserID,
        scope: scopeValue,
        targetID,
        label,
      });
    } else if (body === "ptt_stop" || body === "always_off") {
      activeVoiceRoutesRef.current.delete(routeKey);
    }
    refreshActiveVoiceChannelState();
  }

  // ── Incoming attention ──
  function clearIncomingAttentionTimer() {
    if (incomingAttentionTimeoutRef.current !== null) {
      window.clearTimeout(incomingAttentionTimeoutRef.current);
      incomingAttentionTimeoutRef.current = null;
    }
  }

  function triggerIncomingAttention(event: RoutedEvent) {
    const ad = appDataRef.current;
    if (!ad) return;
    let title = "Incoming signal";
    let detail = event.fromUser.username;
    if (event.scope === "room") {
      const roomName =
        ad.rooms.find((room) => room.id === event.targetId)?.name ||
        event.targetId;
      title =
        event.signal === "call"
          ? "Incoming group call"
          : "Incoming group signal";
      detail = `${event.fromUser.username} · ${roomName}`;
    } else if (event.scope === "direct") {
      title = "Incoming direct signal";
      detail = event.signal
        ? `${event.fromUser.username} · ${event.signal}`
        : event.fromUser.username;
    }
    setIncomingAttention({ title, detail });
    setAttentionFlashKey((prev) => prev + 1);
    clearIncomingAttentionTimer();
    incomingAttentionTimeoutRef.current = window.setTimeout(() => {
      incomingAttentionTimeoutRef.current = null;
      setIncomingAttention(null);
    }, 2200);
  }

  // ── Room permission helpers ──
  function canRoleSendToRoom(roomId: string, currentRoleId: string): boolean {
    const room = appDataRef.current?.rooms.find((entry) => entry.id === roomId);
    if (!room) return false;
    return roleAllowed(room.senderRoleIds, currentRoleId);
  }

  function canRoleReceiveFromRoom(
    roomId: string,
    currentRoleId: string,
  ): boolean {
    const room = appDataRef.current?.rooms.find((entry) => entry.id === roomId);
    if (!room) return false;
    return roleAllowed(room.receiverRoleIds, currentRoleId);
  }

  function isRoomForcedListen(roomId: string, currentRoleId: string): boolean {
    const room = appDataRef.current?.rooms.find((entry) => entry.id === roomId);
    if (!room) return false;
    return (room.forcedListenRoleIds ?? []).includes(currentRoleId);
  }

  // ── Room matrix actions ──
  function toggleListenRoom(roomId: string) {
    const ad = appDataRef.current;
    if (!ad || !canRoleReceiveFromRoom(roomId, ad.self.roleId)) return;
    if (isRoomForcedListen(roomId, ad.self.roleId)) return;
    const nextListen = toggleRoomSelectionState(listenRoomIdsRef.current, roomId);
    setListenRoomIds(nextListen);
    sendRoomMatrix(nextListen, talkRoomIdsRef.current, true);
  }

  function toggleTalkRoom(roomId: string) {
    const ad = appDataRef.current;
    if (!ad || !canRoleSendToRoom(roomId, ad.self.roleId)) return;
    const nextTalk = talkRoomIdsRef.current.includes(roomId)
      ? talkRoomIdsRef.current.filter((id) => id !== roomId)
      : [roomId];
    setTalkRoomIds(nextTalk);
    sendRoomMatrix(listenRoomIdsRef.current, nextTalk, true);
  }

  // ── Cleanup helpers ──
  function clearReconnectTimer() {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }

  function clearRoomSwitchTimer() {
    if (roomSwitchTimerRef.current !== null) {
      window.clearTimeout(roomSwitchTimerRef.current);
      roomSwitchTimerRef.current = null;
    }
  }

  function cleanupRealtimeResources() {
    mic.micReinitGenerationRef.current += 1;
    restoreAlwaysOnAfterDirectPttRef.current = false;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    for (const audio of remote.remoteAudioRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    remote.remoteAudioRef.current.clear();
    remote.remoteSourceUserIdRef.current.clear();
    activeVoiceRoutesRef.current.clear();
    observedVoiceSendersRef.current.clear();
    setActiveVoiceRoutes([]);
    if (mic.localStreamRef.current) {
      for (const track of mic.localStreamRef.current.getTracks()) track.stop();
      mic.localStreamRef.current = null;
    }
    mic.stopInputProcessing();
    pendingICERef.current = [];
    stopStatsLoop();
    mic.stopLevelMeter();
    remote.stopRemoteAudioMeter();
    clearIncomingAttentionTimer();
    setIncomingAttention(null);
  }

  async function releaseWakeLock() {
    const sentinel = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;
    if (!sentinel) {
      setWakeLockActive(false);
      return;
    }
    try {
      if (!sentinel.released) await sentinel.release();
    } catch {
      // ignore release failures
    } finally {
      setWakeLockActive(false);
    }
  }

  async function requestWakeLock() {
    if (
      !wakeLockSupported ||
      !keepScreenAwakeRef.current ||
      !token ||
      authMode !== "operator" ||
      connectionState !== "connected" ||
      document.visibilityState === "hidden"
    ) {
      await releaseWakeLock();
      return;
    }
    if (wakeLockSentinelRef.current && !wakeLockSentinelRef.current.released) {
      setWakeLockActive(true);
      return;
    }
    try {
      const navigatorWithAudioSession = navigator as NavigatorWithAudioSession;
      const sentinel =
        await navigatorWithAudioSession.wakeLock?.request("screen");
      if (!sentinel) {
        setWakeLockActive(false);
        return;
      }
      sentinel.addEventListener?.("release", () => {
        wakeLockSentinelRef.current = null;
        setWakeLockActive(false);
      });
      wakeLockSentinelRef.current = sentinel;
      setWakeLockActive(true);
    } catch {
      setWakeLockActive(false);
    }
  }

  function requestReconnectNow() {
    if (!shouldReconnectRef.current || !connectRealtimeRef.current) return;
    const socketState = wsRef.current?.readyState;
    if (
      socketState === WebSocket.OPEN ||
      socketState === WebSocket.CONNECTING
    ) {
      return;
    }
    clearReconnectTimer();
    void connectRealtimeRef.current();
  }

  const recoverPlaybackAfterResume = useCallback(
    async (reason: string) => {
      await resumeRemoteAudioContexts();
      if (enableBackgroundAudioRecoveryRef.current) {
        await retryPlayAllRemoteAudio();
        requestReconnectNow();
      }
      void requestWakeLock();
      pushDebugEvent(`system · mobile audio recovery · ${reason}`);
    },
    [
      pushDebugEvent,
      requestWakeLock,
      resumeRemoteAudioContexts,
      retryPlayAllRemoteAudio,
    ],
  );

  // ── Sending helpers ──
  function canSelfSendToRoom(roomId: string): boolean {
    const ad = appDataRef.current;
    if (!ad || !roomId) return false;
    return canRoleSendToRoom(roomId, ad.self.roleId);
  }

  function canSelfSendToBroadcastGroup(groupId: string): boolean {
    const ad = appDataRef.current;
    if (!ad || !groupId) return false;
    const group = ad.broadcastGroups.find((entry) => entry.id === groupId);
    if (!group) return false;
    const allowedRoleIds = Array.isArray(group.allowedRoleIds)
      ? group.allowedRoleIds
      : [];
    const roleAllowedForGroup =
      allowedRoleIds.length === 0 || allowedRoleIds.includes(ad.self.roleId);
    if (!roleAllowedForGroup) return false;
    return group.roomIds.some((roomId) => canRoleSendToRoom(roomId, ad.self.roleId));
  }

  function canSelfDirectToRole(targetRoleId: string): boolean {
    const ad = appDataRef.current;
    if (!ad || !targetRoleId) return false;
    return ad.rooms.some(
      (room) =>
        roleAllowed(room.senderRoleIds, ad.self.roleId) &&
        roleAllowed(room.receiverRoleIds, targetRoleId),
    );
  }

  function canSelfSendDirectToUser(targetUserId: string): boolean {
    const ad = appDataRef.current;
    if (!ad || !targetUserId) return false;
    if (targetUserId === ad.self.id) return false;
    const targetUser = ad.users.find((user) => user.id === targetUserId);
    if (!targetUser) return false;
    return canSelfDirectToRole(targetUser.roleId);
  }

  function canSendScopedVoiceState(
    scopeValue: "direct" | "room" | "broadcast",
    scopedTargetId: string,
  ): boolean {
    if (!scopedTargetId) return false;
    if (scopeValue === "direct") {
      return canSelfSendDirectToUser(scopedTargetId);
    }
    if (scopeValue === "room") {
      return canSelfSendToRoom(scopedTargetId);
    }
    return canSelfSendToBroadcastGroup(scopedTargetId);
  }

  function sendScopedVoiceState(
    scopeValue: "direct" | "room" | "broadcast",
    scopedTargetId: string,
    state: string,
  ) {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !scopedTargetId
    )
      return;
    if (!canSendScopedVoiceState(scopeValue, scopedTargetId)) {
      return;
    }
    const stream = mic.localStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        if (state === "always_on" || state === "ptt_start") {
          track.enabled = true;
        } else if (state === "always_off") {
          track.enabled = false;
        } else if (state === "ptt_stop") {
          track.enabled = voiceModeRef.current === "always_on";
        }
      }
    }
    wsRef.current.send(
      JSON.stringify({
        type: "voice_state",
        data: { scope: scopeValue, targetId: scopedTargetId, body: state },
      }),
    );
  }

  function roomMatrixSyncKey(listenRooms: string[], talkRooms: string[]): string {
    const listen = [...listenRooms].sort().join("|");
    const talk = [...talkRooms].sort().join("|");
    return `${listen}::${talk}`;
  }

  function sendRoomMatrix(
    listenRooms: string[],
    talkRooms: string[],
    suppressNextDebounced = false,
  ): boolean {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const syncKey = roomMatrixSyncKey(listenRooms, talkRooms);
    if (suppressNextDebounced) {
      pendingRoomMatrixEchoKeyRef.current = syncKey;
    }
    ws.send(
      JSON.stringify({
        type: "set_room_matrix",
        data: { listenRoomIds: listenRooms, talkRoomIds: talkRooms },
      }),
    );
    return true;
  }

  function sendVoiceState(state: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const voiceTargetId = matrixAnchorRoomId(
      listenRoomIdsRef.current,
      talkRoomIdsRef.current,
    );
    if (!voiceTargetId || !canSelfSendToRoom(voiceTargetId)) return;
    sendScopedVoiceState("room", voiceTargetId, state);
  }

  function sendScopedSignal(
    scopeValue: "direct" | "room" | "broadcast",
    scopedTargetId: string,
    signal: string,
  ) {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !scopedTargetId
    )
      return;
    if (!canSendScopedVoiceState(scopeValue, scopedTargetId)) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "signal",
        data: { scope: scopeValue, targetId: scopedTargetId, signal },
      }),
    );
  }

  function sendCompanionCommandResult(
    commandID: string,
    command: string,
    ok: boolean,
    status: "executed" | "rejected" | "failed",
    error?: string,
  ) {
    if (!commandID || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "companion_command_result",
        data: {
          commandId: commandID,
          command,
          ok,
          status,
          error,
          source: "browser",
          timestamp: Date.now(),
        },
      }),
    );
  }

  // ── Voice mode actions ──
  function setAlwaysOn(enabled: boolean) {
    restoreAlwaysOnAfterDirectPttRef.current = false;
    if (forcePttOnMobile) {
      if (voiceModeRef.current !== "ptt") {
        setVoiceMode("ptt");
        voiceModeRef.current = "ptt";
      }
      setPttPressed(false);
      setPttPressedChannelId(null);
      sendVoiceState("always_off");
      return;
    }
    if (enabled && enableDirectPpt) {
      if (voiceModeRef.current !== "ptt") {
        setVoiceMode("ptt");
        voiceModeRef.current = "ptt";
      }
      if (pttPressed) setPttPressed(false);
      sendVoiceState("always_off");
      return;
    }
    if (enabled) {
      setVoiceMode("always_on");
      voiceModeRef.current = "always_on";
      setPttPressed(false);
      setPttPressedChannelId(null);
      sendVoiceState("always_on");
    } else {
      setVoiceMode("ptt");
      voiceModeRef.current = "ptt";
      setPttPressed(false);
      setPttPressedChannelId(null);
      sendVoiceState("always_off");
    }
  }

  function handleEnableDirectPptChange(enabled: boolean) {
    if (enabled) setAlwaysOn(false);
  }

  // ── PTT actions ──
  function startPtt() {
    setPttPressed(true);
    sendVoiceState("ptt_start");
    nativeAudio?.setPtt(true);
  }
  function stopPtt() {
    setPttPressed(false);
    sendVoiceState("ptt_stop");
    nativeAudio?.setPtt(false);
  }

  function startBroadcastPtt(groupId: string) {
    if (!canSelfSendToBroadcastGroup(groupId)) return;
    setBroadcastPttPressed(groupId);
    sendScopedVoiceState("broadcast", groupId, "ptt_start");
  }

  function stopBroadcastPtt(groupId: string) {
    if (!canSelfSendToBroadcastGroup(groupId)) return;
    setBroadcastPttPressed((current) => (current === groupId ? null : current));
    sendScopedVoiceState("broadcast", groupId, "ptt_stop");
  }

  function startDirectPtt(userId: string) {
    if (!canSendScopedVoiceState("direct", userId)) return;
    if (voiceModeRef.current === "always_on") {
      restoreAlwaysOnAfterDirectPttRef.current = true;
      setVoiceMode("ptt");
      voiceModeRef.current = "ptt";
      sendVoiceState("always_off");
    }
    setdirectPttPressedUserId(userId);
    sendScopedVoiceState("direct", userId, "ptt_start");
  }

  function stopDirectPtt(userId: string) {
    if (!canSendScopedVoiceState("direct", userId)) return;
    setdirectPttPressedUserId((current) =>
      current === userId ? null : current,
    );
    sendScopedVoiceState("direct", userId, "ptt_stop");
    if (restoreAlwaysOnAfterDirectPttRef.current) {
      restoreAlwaysOnAfterDirectPttRef.current = false;
      setVoiceMode("always_on");
      voiceModeRef.current = "always_on";
      sendVoiceState("always_on");
    }
  }

  // ── Channel PTT ──
  function handleChannelPttStart(channelId: string) {
    if (!appDataRef.current || !channelId) return;
    if (!canSelfSendToRoom(channelId)) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setTalkRoomIds([channelId]);
    setPttPressed(true);
    setPttPressedChannelId(channelId);
    prevChannelRef.current = channelId;
    sendRoomMatrix(listenRoomIdsRef.current, [channelId], true);
    sendScopedVoiceState("room", channelId, "ptt_start");
  }

  function handleChannelPttStop(channelId: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (prevChannelRef.current === channelId) {
      setPttPressed(false);
      setPttPressedChannelId(null);
      sendScopedVoiceState("room", channelId, "ptt_stop");
      prevChannelRef.current = "";
    }
  }

  // ── Chat ──
  const chatScope: "direct" | "room" | "broadcast" = "room";

  function sendChat(ackRequired = false) {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !message.trim()
    )
      return;
    const resolvedTargetId = resolveChatTargetRoomId(
      listenRoomIdsRef.current,
      talkRoomIdsRef.current,
      appDataRef.current?.rooms || [],
      appDataRef.current?.roles.find(
        (role) => role.id === appDataRef.current?.self.roleId,
      ),
      appDataRef.current?.self.roleId || "",
    );
    if (!resolvedTargetId) return;
    wsRef.current.send(
      JSON.stringify({
        type: "chat",
        data: {
          scope: chatScope,
          targetId: resolvedTargetId,
          body: message.trim(),
          ackRequired: ackRequired && (appDataRef.current?.ackEnabled ?? true),
        },
      }),
    );
    setMessage("");
  }

  function acknowledgeChatMessage(messageId: string, senderUserId: string) {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !messageId ||
      !senderUserId
    ) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "chat_ack",
        data: { messageId, senderUserId },
      }),
    );
    setChatMessages((old) =>
      old.map((entry) => {
        if (entry.messageId !== messageId) {
          return entry;
        }
        return {
          ...entry,
          acked: true,
          ackedBy: appDataRef.current?.self.username || entry.ackedBy,
          ackedAt: new Date().toLocaleTimeString(),
        };
      }),
    );
  }

  // ── Bootstrap data application ──
  const applyBootstrapData = useCallback(
    (data: Bootstrap, isInitial = false) => {
      const roleDefaults = data.roles.find(
        (role) => role.id === data.self.roleId,
      );
      if (roleDefaults?.defaultVoiceMode) {
        const nextMode = resolveVoiceModeForClient(
          roleDefaults.defaultVoiceMode as "always_on" | "ptt",
        );
        setVoiceMode(nextMode);
        voiceModeRef.current = nextMode;
      }
      setViewMode(roleDefaults?.defaultSimpleView ? "simple" : "station");
      pendingInitialRoomRestoreRef.current = isInitial
        ? hadStoredSessionSettings
        : false;
      const hadStored = isInitial ? hadStoredSessionSettings : false;
      if (hadStored) {
        setListenRoomIds((prev) => {
          const sanitized = prev.filter((roomId) => {
            const room = data.rooms.find((entry) => entry.id === roomId);
            return (
              !!room && roleAllowed(room.receiverRoleIds, data.self.roleId)
            );
          });
          return mergeForcedListenRooms(
            sanitized,
            data.rooms,
            data.self.roleId,
          );
        });
        setTalkRoomIds((prev) =>
          prev.filter((roomId) => {
            const room = data.rooms.find((entry) => entry.id === roomId);
            return !!room && roleAllowed(room.senderRoleIds, data.self.roleId);
          }),
        );
      } else {
        let initialRoom = "";
        if (roleDefaults?.defaultRoomId) {
          initialRoom = roleDefaults.defaultRoomId;
        } else {
          const firstAllowedTalkRoom = data.rooms.find((room) =>
            roleAllowed(room.senderRoleIds, data.self.roleId),
          );
          const firstAllowedListenRoom = data.rooms.find((room) =>
            roleAllowed(room.receiverRoleIds, data.self.roleId),
          );
          initialRoom =
            firstAllowedTalkRoom?.id || firstAllowedListenRoom?.id || "";
        }
        if (initialRoom) {
          const initialRoomConfig = data.rooms.find(
            (room) => room.id === initialRoom,
          );
          const initialCanListen = roleAllowed(
            initialRoomConfig?.receiverRoleIds,
            data.self.roleId,
          );
          const initialCanTalk = roleAllowed(
            initialRoomConfig?.senderRoleIds,
            data.self.roleId,
          );
          setListenRoomIds(
            mergeForcedListenRooms(
              initialCanListen ? [initialRoom] : [],
              data.rooms,
              data.self.roleId,
            ),
          );
          setTalkRoomIds(initialCanTalk ? [initialRoom] : []);
        }
      }
    },
    [hadStoredSessionSettings, forcePttOnMobile],
  );

  // ── Admin mode: reset operator state ──
  useEffect(() => {
    if (authMode !== "admin") return;
    shouldReconnectRef.current = false;
    clearReconnectTimer();
    cleanupRealtimeResources();
    void releaseWakeLock();
    setConnectionState("offline");
    setPresence([]);
    setChatMessages([]);
    seenChatKeysRef.current.clear();
    setEvents([]);
    setPttPressed(false);
    setBroadcastPttPressed(null);
    setdirectPttPressedUserId(null);
    setPttPressedChannelId(null);
    setLastDirectCallerUserId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authMode]);

  // ── WebSocket + WebRTC lifecycle ──
  useEffect(() => {
    if (!token || !appData || authMode !== "operator") return;
    shouldReconnectRef.current = true;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      setConnectionState(
        reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting",
      );
      pendingInitialRoomRestoreRef.current = true;
      const ws = new WebSocket(
        buildWebSocketUrl("/ws", { token }),
      );
      wsRef.current = ws;

      ws.onopen = async () => {
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");
        setAudioError("");
        pendingICERef.current = [];
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcRef.current = pc;
        pc.onconnectionstatechange = () => setWebrtcState(pc.connectionState);
        pc.oniceconnectionstatechange = () =>
          setWebrtcState(`ice:${pc.iceConnectionState}`);
        if (showDebug) startStatsLoop(pc);
        pc.onicecandidate = (event) => {
          if (
            !event.candidate ||
            !wsRef.current ||
            wsRef.current.readyState !== WebSocket.OPEN
          )
            return;
          wsRef.current.send(
            JSON.stringify({
              type: "webrtc_ice_candidate",
              data: {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid || undefined,
                sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
              },
            }),
          );
        };
        pc.ontrack = (event) => {
          const key = `${event.track.id}-${event.streams[0]?.id || "nostream"}`;
          const sourceUserID =
            sourceUserIDFromTrackID(event.track.id) ||
            sourceUserIDFromRemoteSDPMid(pcRef.current, event.transceiver?.mid);
          if (sourceUserID) {
            remote.remoteSourceUserIdRef.current.set(key, sourceUserID);
          }
          // Set adaptive playout delay based on current network conditions
          const stats = currentRtpStatsRef.current;
          const delayHint = getAdaptivePlayoutDelayHint(
            stats.roundTripMs,
            stats.jitterMs,
          );
          trySetReceiverPlayoutDelayHint(event.receiver, delayHint);
          let audio = remote.remoteAudioRef.current.get(key);
          if (!audio) {
            audio = document.createElement("audio");
            audio.autoplay = true;
            audio.muted = false;
            remote.remoteAudioRef.current.set(key, audio);
          }
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          if (!remote.remoteAnalyserNodesRef.current.has(key)) {
            const AudioCtx = window.AudioContext;
            if (AudioCtx) {
              const ctx = new AudioCtx({ latencyHint: "interactive" });
              const src = ctx.createMediaStreamSource(stream);
              const gain = ctx.createGain();
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 256;
              src.connect(gain);
              gain.connect(analyser);
              const analyserBuf = new Uint8Array(
                new ArrayBuffer(analyser.frequencyBinCount),
              );
              remote.remoteAnalyserNodesRef.current.set(key, {
                ctx,
                analyser,
                gain,
                buf: analyserBuf,
              });
              remote.startRemoteAudioMeterLoop();
            }
          }
          audio.srcObject = stream;
          remote.applyVolumeToRemoteAudio(key);
          void (async () => {
            const outputDeviceId = selectedOutputDeviceIdRef.current;
            const sinkApplied = await remote.applyOutputDeviceToAudio(
              audio,
              outputDeviceId,
            );
            // Fail closed: with an explicit output selection, never leak to default.
            if (outputDeviceId && !sinkApplied) {
              audio.pause();
              audio.muted = true;
              return;
            }
            audio.muted = false;
            await audio.play();
          })().catch((err) => {
            setAudioError(
              `Remote audio playback blocked: ${err instanceof Error ? err.message : "unknown error"}`,
            );
          });
          pushDebugEvent("system · webrtc · remote audio track attached");
        };
        try {
          const captureStream = await mic.getMicStream(
            selectedInputDeviceIdRef.current,
          );
          mic.stopInputProcessing();
          mic.inputCaptureStreamRef.current = captureStream;
          const stream = mic.buildOutgoingMicStream(
            captureStream,
            selectedInputGainFor(selectedInputDeviceIdRef.current),
          );
          mic.localStreamRef.current = stream;
          if (isUserSettingsOpenRef.current) {
            mic.startLevelMeter(captureStream);
          } else {
            mic.stopLevelMeter();
          }
          void onRefreshAudioDevices();
          const initialEnabled = voiceModeRef.current === "always_on";
          for (const track of stream.getAudioTracks()) {
            track.enabled = initialEnabled;
            pc.addTrack(track, stream);
          }
          await applyOutgoingAudioSenderBitrate(pc);
          mic.applyVoiceModeToLocalTracks(voiceModeRef.current);
        } catch (e) {
          setAudioError(
            `Failed to access microphone: ${e instanceof Error ? e.message : "unknown error"}`,
          );
          pushDebugEvent("system · local/mic · capture failed (receive-only)");
        }
        ws.send(JSON.stringify({ type: "webrtc_ready", data: {} }));
        sendRoomMatrix(listenRoomIdsRef.current, talkRoomIdsRef.current, true);
        const initialVoiceModeValue = voiceModeRef.current;
        const voiceState =
          initialVoiceModeValue === "always_on" ? "always_on" : "ptt_stop";
        ws.send(
          JSON.stringify({
            type: "voice_state",
            data: {
              scope: "room",
              targetId: matrixAnchorRoomId(
                listenRoomIdsRef.current,
                talkRoomIdsRef.current,
              ),
              body: voiceState,
            },
          }),
        );
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        const ad = appDataRef.current;

        if (msg.type === "presence") {
          const nextPresence = normalizePresenceList(msg.data);
          setPresence((prev) =>
            samePresenceList(prev, nextPresence) ? prev : nextPresence,
          );
          remote.applyVolumeToAllRemoteAudio();
          return;
        }
        if (msg.type === "config_updated") {
          const updated = normalizePublicBootstrap(msg.data);
          onUpdateAppData((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              roles: updated.roles,
              rooms: updated.rooms,
              broadcastGroups: updated.broadcastGroups,
              ackEnabled: updated.ackEnabled,
            };
          });
          onUpdatePublicData(updated);
          const selfRoleId = ad?.self?.roleId ?? "";
          setListenRoomIds((prev) => {
            const filtered = prev.filter((id) => {
              const room = updated.rooms.find((r) => r.id === id);
              return !!room && roleAllowed(room.receiverRoleIds, selfRoleId);
            });
            const next = mergeForcedListenRooms(
              filtered,
              updated.rooms,
              selfRoleId,
            );
            return sameStringArray(prev, next) ? prev : next;
          });
          setTalkRoomIds((prev) => {
            const next = prev.filter((id) => {
              const room = updated.rooms.find((r) => r.id === id);
              return !!room && roleAllowed(room.senderRoleIds, selfRoleId);
            });
            return sameStringArray(prev, next) ? prev : next;
          });
          remote.applyVolumeToAllRemoteAudio();
          return;
        }
        if (msg.type === "session_revoked") {
          shouldReconnectRef.current = false;
          setConnectionState("offline");
          pushDebugEvent(
            `system · session revoked · reason:${msg.data.reason || "unknown"}`,
          );
          onSessionRevoked();
          ws.close(4001, "session revoked");
          return;
        }
        if (msg.type === "companion_command") {
          const commandID = String(msg.data.commandId || "").trim();
          const command = String(msg.data.command || "");
          setLastCompanionCommand({
            command,
            status: "executing",
            at: Date.now(),
          });
          const ackSuccess = () => {
            setLastCompanionCommand({
              command,
              status: "executed",
              at: Date.now(),
            });
            sendCompanionCommandResult(commandID, command, true, "executed");
          };
          const ackRejected = (error: string) => {
            setLastCompanionCommand({
              command,
              status: "rejected",
              error,
              at: Date.now(),
            });
            sendCompanionCommandResult(commandID, command, false, "rejected", error);
          };
          const ackFailed = (error: string) => {
            setLastCompanionCommand({
              command,
              status: "failed",
              error,
              at: Date.now(),
            });
            sendCompanionCommandResult(commandID, command, false, "failed", error);
          };

          if (msg.data.command === "set_voice_mode" && msg.data.mode) {
            setAlwaysOn(msg.data.mode === "always_on");
            ackSuccess();
            return;
          }
          if (msg.data.command === "ptt") {
            const nextScope = msg.data.scope || "room";
            const desiredState = msg.data.state || "ptt_stop";
            const resolvedTargetId =
              msg.data.targetId ||
              (nextScope === "room"
                ? matrixAnchorRoomId(
                    listenRoomIdsRef.current,
                    talkRoomIdsRef.current,
                  )
                : "");
            if (nextScope === "room") {
              setPttPressed(desiredState === "ptt_start");
            } else if (nextScope === "direct") {
              if (resolvedTargetId) {
                if (desiredState === "ptt_start") {
                  startDirectPtt(resolvedTargetId);
                } else {
                  stopDirectPtt(resolvedTargetId);
                }
              }
            } else if (nextScope === "broadcast") {
              if (desiredState === "ptt_start" && resolvedTargetId) {
                setBroadcastPttPressed(resolvedTargetId);
              } else {
                setBroadcastPttPressed((current) =>
                  current === resolvedTargetId ? null : current,
                );
              }
            }
            if (!resolvedTargetId) {
              ackRejected("missing targetId");
              return;
            }
            if (nextScope === "direct") {
              ackSuccess();
              return;
            }
            sendScopedVoiceState(nextScope, resolvedTargetId, desiredState);
            ackSuccess();
            return;
          }
          if (msg.data.command === "signal") {
            const nextScope = msg.data.scope || "room";
            const resolvedTargetId =
              msg.data.targetId ||
              (nextScope === "room"
                ? matrixAnchorRoomId(
                    listenRoomIdsRef.current,
                    talkRoomIdsRef.current,
                  )
                : "");
            if (!resolvedTargetId) {
              ackRejected("missing targetId");
              return;
            }
            if (!msg.data.signal) {
              ackRejected("missing signal");
              return;
            }
            sendScopedSignal(nextScope, resolvedTargetId, msg.data.signal);
            ackSuccess();
            return;
          }
          if (msg.data.command === "set_room_matrix") {
            const nextListen = Array.isArray(msg.data.listenRoomIds)
              ? msg.data.listenRoomIds
              : listenRoomIdsRef.current;
            const nextTalk = Array.isArray(msg.data.talkRoomIds)
              ? msg.data.talkRoomIds
              : talkRoomIdsRef.current;
            if (Array.isArray(msg.data.listenRoomIds)) {
              setListenRoomIds(msg.data.listenRoomIds);
            }
            if (Array.isArray(msg.data.talkRoomIds)) {
              setTalkRoomIds(msg.data.talkRoomIds);
            }
            sendRoomMatrix(nextListen, nextTalk, true);
            ackSuccess();
            return;
          }
          if (msg.data.command === "input_gain_delta") {
            const delta = Number(msg.data.volumeDelta || 0);
            if (!Number.isFinite(delta) || delta === 0) {
              ackRejected("missing volumeDelta");
              return;
            }
            onInputGainChange(
              selectedInputDeviceIdRef.current,
              gainWithDbDelta(
                selectedInputGainFor(selectedInputDeviceIdRef.current),
                delta,
              ),
            );
            ackSuccess();
            return;
          }
          if (
            msg.data.command === "set_streamdeck_brightness" ||
            msg.data.command === "clear_streamdeck_panel" ||
            msg.data.command === "reset_streamdeck"
          ) {
            onStreamDeckHardwareCommand?.({
              command: msg.data.command,
              brightness: msg.data.brightness,
            });
            ackSuccess();
            return;
          }
          ackFailed("unsupported command");
          return;
        }
        if (msg.type === "webrtc_offer") {
          // ── Native audio path (Tauri desktop) ──────────────────────────
          if (nativeAudio?.isNative) {
            void (async () => {
              const result = await nativeAudio.handleOffer({
                offerSdp: msg.data.sdp,
                inputDeviceId: selectedInputDeviceIdRef.current || undefined,
                outputDeviceId: selectedOutputDeviceIdRef.current || undefined,
                inputGain: clampInputGainValue(
                  micInputBaseBoost *
                    selectedInputGainFor(selectedInputDeviceIdRef.current),
                ),
                audioGateEnabled,
                audioGateThresholdDb,
              });
              if (result && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(
                  JSON.stringify({
                    type: "webrtc_answer",
                    data: { sdp: result.answerSdp },
                  }),
                );
                // Relay ICE candidates back to the SFU
                for (const candidateJson of result.iceCandidates) {
                  try {
                    const c = JSON.parse(candidateJson) as RTCIceCandidateInit;
                    wsRef.current?.send(
                      JSON.stringify({
                        type: "webrtc_ice_candidate",
                        data: {
                          candidate: c.candidate,
                          sdpMid: c.sdpMid ?? undefined,
                          sdpMLineIndex: c.sdpMLineIndex ?? undefined,
                        },
                      }),
                    );
                  } catch {
                    // skip malformed candidate
                  }
                }
                pushDebugEvent("system · webrtc · native engine answered offer");
                return;
              }
              // Fall through to browser path if native failed
              pushDebugEvent("system · webrtc · native engine failed, falling back");
            })().catch((err) => {
              setAudioError(
                `Native audio engine failed: ${err instanceof Error ? err.message : "unknown error"}`,
              );
            });
            return;
          }

          // ── Browser RTCPeerConnection path (fallback / web) ────────────
          const pc = pcRef.current;
          if (
            !pc ||
            !wsRef.current ||
            wsRef.current.readyState !== WebSocket.OPEN
          )
            return;
          void (async () => {
            if (pc.signalingState !== "stable") {
              try {
                await pc.setLocalDescription({ type: "rollback" });
              } catch {
                // ignore rollback failures
              }
            }
            await pc.setRemoteDescription({ type: "offer", sdp: msg.data.sdp });
            for (const c of pendingICERef.current) {
              await pc.addIceCandidate(c);
            }
            pendingICERef.current = [];
            const answer = await pc.createAnswer();
            const tunedAnswerSdp = tuneOpusSdpForSpeech(answer.sdp || "");
            await pc.setLocalDescription({
              type: "answer",
              sdp: tunedAnswerSdp,
            });
            await applyOutgoingAudioSenderBitrate(pc);
            wsRef.current?.send(
              JSON.stringify({
                type: "webrtc_answer",
                data: { sdp: tunedAnswerSdp },
              }),
            );
            pushDebugEvent("system · webrtc · answered offer");
          })().catch((err) => {
            setAudioError(
              `WebRTC renegotiation failed: ${err instanceof Error ? err.message : "unknown error"}`,
            );
          });
          return;
        }
        if (msg.type === "webrtc_ice_candidate") {
          const pc = pcRef.current;
          if (!pc) return;
          const candidate = {
            candidate: msg.data.candidate,
            sdpMid: msg.data.sdpMid,
            sdpMLineIndex: msg.data.sdpMLineIndex,
          };
          if (!pc.remoteDescription) {
            pendingICERef.current.push(candidate);
          } else {
            void pc.addIceCandidate(candidate).catch(console.error);
          }
          return;
        }
        if (
          msg.type === "voice_state" &&
          msg.data.fromUser.id !== ad?.self.id &&
          msg.data.scope &&
          msg.data.targetId
        ) {
          updateVoiceRoute(
            msg.data.fromUser.id,
            msg.data.scope,
            msg.data.targetId,
            (msg.data.body || "").toString(),
            msg.data.fromUser.username,
          );
        }
        if (
          msg.type === "voice_state" &&
          msg.data.scope === "direct" &&
          msg.data.targetId === ad?.self.id &&
          msg.data.fromUser.id !== ad?.self.id &&
          msg.data.body === "ptt_start"
        ) {
          setLastDirectCallerUserId(msg.data.fromUser.id);
        }
        if (msg.type === "signal" && msg.data.fromUser.id !== ad?.self.id) {
          const incomingGroupCall =
            msg.data.scope === "room" && msg.data.signal === "call";
          const incomingDirectSignal =
            msg.data.scope === "direct" && msg.data.targetId === ad?.self.id;
          if (incomingDirectSignal && msg.data.signal === "call") {
            setLastDirectCallerUserId(msg.data.fromUser.id);
          }
          if (incomingGroupCall || incomingDirectSignal) {
            triggerIncomingAttention(msg.data);
          }
        }
        if (msg.type === "chat") {
          const chatBody = (msg.data.body || "").toString().trim();
          if (chatBody) {
            const chatScope = msg.data.scope;
            const chatTargetId = msg.data.targetId;
            const roomLabel =
              chatScope === "room"
                ? ad?.rooms.find((room) => room.id === chatTargetId)?.name ||
                  chatTargetId
                : chatScope === "broadcast"
                  ? ad?.broadcastGroups.find(
                      (group) => group.id === chatTargetId,
                    )?.name || chatTargetId
                  : "Direct";
            setChatMessages((old) => {
              const nextEntry = {
                from: msg.data.fromUser.username,
                fromUserId: msg.data.fromUser.id,
                body: chatBody,
                at: new Date(msg.data.timestamp).toLocaleTimeString(),
                room: roomLabel,
                self: msg.data.fromUser.id === ad?.self.id,
                scope: chatScope,
                targetId: chatTargetId,
                targetType: msg.data.targetType,
                messageId: msg.data.messageId,
                ackRequired: !!msg.data.ackRequired,
                acked: !!msg.data.acked,
                ackedBy: msg.data.ackedBy?.username,
                ackedAt: msg.data.ackedAt
                  ? new Date(msg.data.ackedAt).toLocaleTimeString()
                  : undefined,
                source: msg.data.source,
              };
              const stableKey = nextEntry.messageId
                ? `id:${nextEntry.messageId}`
                : [
                    "fallback",
                    nextEntry.at,
                    nextEntry.fromUserId,
                    nextEntry.scope,
                    nextEntry.targetId,
                    nextEntry.body,
                  ].join("|");
              if (seenChatKeysRef.current.has(stableKey)) {
                return old;
              }
              const nextIdentity = [
                nextEntry.at,
                nextEntry.fromUserId,
                nextEntry.scope,
                nextEntry.targetId,
                nextEntry.body,
              ].join("|");
              const alreadyPresent = old.some((entry) => {
                if (nextEntry.messageId && entry.messageId) {
                  return entry.messageId === nextEntry.messageId;
                }
                const entryIdentity = [
                  entry.at,
                  entry.fromUserId,
                  entry.scope,
                  entry.targetId,
                  entry.body,
                ].join("|");
                return entryIdentity === nextIdentity;
              });
              if (alreadyPresent) {
                seenChatKeysRef.current.add(stableKey);
                return old;
              }
              seenChatKeysRef.current.add(stableKey);
              return [nextEntry, ...old].slice(0, 120);
            });
          }
        }
        if (msg.type === "chat_ack") {
          setChatMessages((old) =>
            old.map((entry) => {
              if (entry.messageId !== msg.data.messageId) {
                return entry;
              }
              return {
                ...entry,
                acked: true,
                ackedBy: msg.data.ackedBy.username,
                ackedAt: new Date(msg.data.ackedAt).toLocaleTimeString(),
              };
            }),
          );
          return;
        }
        if (msg.type === "chat_history_cleared") {
          setChatMessages([]);
          seenChatKeysRef.current.clear();
          if (showDebug) {
            pushDebugEvent("system · chat history cleared");
          }
          return;
        }
        const body = (msg.data.signal || msg.data.body || "").toString();
        if (showDebug) {
          setEvents((old) =>
            [
              {
                label: `${msg.type} · ${msg.data.fromUser.username} · ${msg.data.scope}/${msg.data.targetId} · ${body}`,
                at: new Date(msg.data.timestamp).toLocaleTimeString(),
              },
              ...old,
            ].slice(0, 200),
          );
        }
      };

      ws.onclose = (event) => {
        clearRoomSwitchTimer();
        cleanupRealtimeResources();
        if (!shouldReconnectRef.current || cancelled) {
          setConnectionState("offline");
          return;
        }
        if (event.code === 4001) {
          setConnectionState("offline");
          return;
        }
        console.warn("WebSocket closed:", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        pushDebugEvent(
          `system · websocket closed · code:${event.code} clean:${event.wasClean ? "yes" : "no"} · reconnecting...`,
        );
        setConnectionState("reconnecting");
        reconnectAttemptsRef.current += 1;
        const backoff = Math.min(
          8000,
          500 * 2 ** Math.min(reconnectAttemptsRef.current, 5),
        );
        const jitterFactor = 0.7 + Math.random() * 0.6;
        const reconnectDelay = Math.round(backoff * jitterFactor);
        reconnectTimeoutRef.current = window.setTimeout(() => {
          void connect();
        }, reconnectDelay);
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        pushDebugEvent(
          `system · websocket error · ${event instanceof ErrorEvent ? event.message : "check console"}`,
        );
        ws.close();
      };
    };
    connectRealtimeRef.current = connect;

    void connect();
    return () => {
      cancelled = true;
      connectRealtimeRef.current = null;
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      cleanupRealtimeResources();
      void releaseWakeLock();
      setConnectionState("offline");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, appData, authMode]);

  useEffect(() => {
    if (authMode !== "operator") return;
    const handleVisible = () => {
      if (document.visibilityState === "hidden") {
        void releaseWakeLock();
        return;
      }
      void recoverPlaybackAfterResume("visible");
    };
    const handlePageShow = () => void recoverPlaybackAfterResume("pageshow");
    const handleFocus = () => void recoverPlaybackAfterResume("focus");
    const handleOnline = () => void recoverPlaybackAfterResume("online");
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [authMode, recoverPlaybackAfterResume]);

  useEffect(() => {
    void requestWakeLock();
  }, [authMode, connectionState, keepScreenAwake, token]);

  useEffect(() => {
    const navigatorWithAudioSession = navigator as NavigatorWithAudioSession;
    if (
      !enableBackgroundAudioRecovery ||
      !navigatorWithAudioSession.audioSession
    )
      return;
    const nextType =
      authMode === "operator" && token && connectionState === "connected"
        ? "play-and-record"
        : "auto";
    try {
      navigatorWithAudioSession.audioSession.type = nextType;
    } catch {
      // ignore unsupported audio session assignments
    }
  }, [authMode, connectionState, enableBackgroundAudioRecovery, token]);

  useEffect(() => {
    if (!enableBackgroundAudioRecovery || !mediaSessionSupported) return;
    const mediaSession = navigator.mediaSession;
    const playbackState =
      connectionState === "connected"
        ? remote.incomingAudioActive
          ? "playing"
          : "paused"
        : "none";
    try {
      if (typeof MediaMetadata === "function") {
        mediaSession.metadata = new MediaMetadata({
          title: remote.incomingAudioActive
            ? "Live audio active"
            : "Intercom ready",
          artist: appData?.self.username || "Operator",
          album: "Kesher Live Production Intercom",
        });
      }
      mediaSession.playbackState = playbackState;
      mediaSession.setActionHandler("play", () => {
        void recoverPlaybackAfterResume("media-session-play");
      });
      mediaSession.setActionHandler("pause", () => {
        pauseAllRemoteAudio();
        mediaSession.playbackState = "paused";
      });
      mediaSession.setActionHandler("stop", () => {
        pauseAllRemoteAudio();
        mediaSession.playbackState = "paused";
      });
    } catch {
      // ignore media session errors on partially-supported browsers
    }
    return () => {
      try {
        mediaSession.setActionHandler("play", null);
        mediaSession.setActionHandler("pause", null);
        mediaSession.setActionHandler("stop", null);
      } catch {
        // ignore cleanup errors
      }
    };
  }, [
    appData?.self.username,
    connectionState,
    enableBackgroundAudioRecovery,
    mediaSessionSupported,
    pauseAllRemoteAudio,
    recoverPlaybackAfterResume,
    remote.incomingAudioActive,
  ]);

  // ── Presence sync → local state ──
  useEffect(() => {
    if (!appData) return;
    const selfPresence = presence.find(
      (entry) => entry.userId === appData.self.id,
    );
    if (!selfPresence) return;
    if (pendingInitialRoomRestoreRef.current) {
      const matchesListen = sameStringSet(
        listenRoomIdsRef.current,
        selfPresence.listenRooms,
      );
      const matchesTalk = sameStringSet(
        talkRoomIdsRef.current,
        selfPresence.talkRooms,
      );
      if (!matchesListen || !matchesTalk) {
        sendRoomMatrix(listenRoomIdsRef.current, talkRoomIdsRef.current, true);
        return;
      }
      pendingInitialRoomRestoreRef.current = false;
    }
    setListenRoomIds((prev) =>
      sameStringArray(prev, selfPresence.listenRooms)
        ? prev
        : selfPresence.listenRooms,
    );
    setTalkRoomIds((prev) =>
      sameStringArray(prev, selfPresence.talkRooms)
        ? prev
        : selfPresence.talkRooms,
    );
    const nextVoiceMode =
      resolveVoiceModeForClient(
        selfPresence.voiceMode === "always_on" ? "always_on" : "ptt",
      );
    if (nextVoiceMode !== voiceModeRef.current) {
      setVoiceMode(nextVoiceMode);
      voiceModeRef.current = nextVoiceMode;
    }
    if (nextVoiceMode !== "always_on" && !selfPresence.micEnabled) {
      setPttPressed(false);
      setdirectPttPressedUserId(null);
      setBroadcastPttPressed(null);
    }
  }, [presence, appData]);

  // ── Room matrix → server sync ──
  useEffect(() => {
    clearRoomSwitchTimer();
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    roomSwitchTimerRef.current = window.setTimeout(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const syncKey = roomMatrixSyncKey(listenRoomIds, talkRoomIds);
      if (pendingRoomMatrixEchoKeyRef.current === syncKey) {
        pendingRoomMatrixEchoKeyRef.current = null;
        return;
      }
      const anchorRoomId = matrixAnchorRoomId(listenRoomIds, talkRoomIds);
      sendRoomMatrix(listenRoomIds, talkRoomIds);
      pushDebugEvent(`system · matrix updated · ${anchorRoomId || "no-room"}`);
    }, roomMatrixSyncDebounceMs);
    return () => clearRoomSwitchTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenRoomIds, talkRoomIds]);

  // ── Return ──
  return {
    connectionState,
    presence,
    chatMessages,
    events,
    rtpStats,
    incomingAudioActive: remote.incomingAudioActive,
    activeVoiceRoutes,
    incomingAttention,
    lastCompanionCommand,
    attentionFlashKey,
    voiceMode,
    voiceModeRef,
    pttPressed,
    broadcastPttPressed,
    directPttPressedUserId,
    pttPressedChannelId,
    lastDirectCallerUserId,
    listenRoomIds,
    talkRoomIds,
    listenRoomIdsRef,
    talkRoomIdsRef,
    viewMode,
    message,
    setMessage,
    inputLevelDbFs: mic.inputLevelDbFs,
    displayedInputClipping: mic.displayedInputClipping,
    isLocalMonitorActive: mic.isLocalMonitorActive,
    toggleLocalMonitor: async () => {
      if (mic.isLocalMonitorActive) {
        mic.stopLocalMonitor();
      } else {
        await mic.startLocalMonitor(selectedOutputDeviceId);
      }
    },
    mediaSessionSupported,
    wakeLockSupported,
    wakeLockActive,
    isStandaloneDisplayMode,
    startPtt,
    stopPtt,
    startBroadcastPtt,
    stopBroadcastPtt,
    startDirectPtt,
    stopDirectPtt,
    setAlwaysOn,
    handleEnableDirectPptChange,
    sendScopedSignal,
    sendChat,
    acknowledgeChatMessage,
    handleChannelPttStart,
    handleChannelPttStop,
    toggleListenRoom,
    toggleTalkRoom,
    applyBootstrapData,
  };
}

// Re-export bootstrap helper for use in App.tsx
export async function loadBootstrap(token: string): Promise<Bootstrap> {
  return bootstrap(token);
}
