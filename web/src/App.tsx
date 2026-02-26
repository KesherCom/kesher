import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bootstrap, getPublicBootstrap, login, logout } from "./api";
import { LoginView } from "./components/LoginView";
import { SimpleIntercomView } from "./components/SimpleIntercomView";
import { StationIntercomView } from "./components/StationIntercomView";
import { AdminPanel } from "./components/admin/AdminPanel";
import { AdminMenu } from "./components/admin/AdminMenu";
import { AudioPanel } from "./components/panels/AudioPanel";
import { ChatSignalPanel } from "./components/panels/ChatSignalPanel";
import { RealtimeEventsPanel } from "./components/panels/RealtimeEventsPanel";
import {
  defaultAdminPin,
  type FavoriteSettings,
  type GlobalSettings,
  loadFavoriteSettings,
  loadGlobalSettings,
  loadSessionSettings,
  type SessionSettings,
  tokenStorageKey,
  clampGainValue,
  sessionSettingsStorageKey,
  globalSettingsStorageKey,
  favoritesStorageKey,
} from "./app/settings";
import {
  sameStringArray,
  sameStringSet,
  sourceUserIDFromRemoteSDPMid,
  sourceUserIDFromTrackID,
} from "./app/utils";
import {
  matrixAnchorRoomId,
  roleAllowed,
  toggleRoomSelectionState,
} from "./lib/intercom";
import type {
  Bootstrap,
  Presence,
  PublicBootstrap,
  RoutedEvent,
} from "./types";

type WsMessage =
  | { type: "presence"; data: Presence[] }
  | { type: "chat"; data: RoutedEvent }
  | { type: "signal"; data: RoutedEvent }
  | { type: "voice_state"; data: RoutedEvent }
  | {
      type: "companion_command";
      data: {
        command: string;
        mode?: "always_on" | "ptt";
        scope?: "direct" | "room" | "broadcast";
        targetId?: string;
        state?: "ptt_start" | "ptt_stop";
        signal?: string;
        roomId?: string;
        activeRoomId?: string;
        listenRoomIds?: string[];
        talkRoomIds?: string[];
      };
    }
  | { type: "webrtc_offer"; data: { sdp: string } }
  | {
      type: "webrtc_ice_candidate";
      data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number };
    };

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizePresenceList(value: unknown): Presence[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      ...record,
      userId: typeof record.userId === "string" ? record.userId : "",
      username: typeof record.username === "string" ? record.username : "",
      roleId: typeof record.roleId === "string" ? record.roleId : "",
      activeRoom:
        typeof record.activeRoom === "string" ? record.activeRoom : "",
      listenRooms: toStringArray(record.listenRooms),
      talkRooms: toStringArray(record.talkRooms),
      voiceMode:
        typeof record.voiceMode === "string" ? record.voiceMode : "ptt",
      micEnabled: Boolean(record.micEnabled),
      broadcastActive: Boolean(record.broadcastActive),
    };
  });
}

const defaultInputGainDeviceKey = "__default__";
const meterDbFsFloor = -60;

function inputGainDeviceKey(deviceId: string): string {
  return deviceId || defaultInputGainDeviceKey;
}

function peakAmplitudeToDbFs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return meterDbFsFloor;
  if (value >= 1) return 0;
  return Math.max(meterDbFsFloor, 20 * Math.log10(value));
}

export function App() {
  const initialSessionSettings = loadSessionSettings();
  const initialGlobalSettings = loadGlobalSettings();
  const initialFavorites = loadFavoriteSettings();
  const hadStoredRoomMatrix =
    initialSessionSettings.listenRoomIds.length > 0 ||
    initialSessionSettings.talkRoomIds.length > 0;
  const [publicData, setPublicData] = useState<PublicBootstrap | null>(null);
  const [appData, setAppData] = useState<Bootstrap | null>(null);
  const [token, setToken] = useState<string | null>(() =>
    sessionStorage.getItem(tokenStorageKey),
  );
  const [username, setUsername] = useState(initialSessionSettings.username);
  const [roleId, setRoleID] = useState(initialSessionSettings.roleId);
  const [listenRoomIds, setListenRoomIds] = useState<string[]>(
    initialSessionSettings.listenRoomIds,
  );
  const [talkRoomIds, setTalkRoomIds] = useState<string[]>(
    initialSessionSettings.talkRoomIds,
  );
  const [presence, setPresence] = useState<Presence[]>([]);
  const [scope, setScope] = useState<"direct" | "room" | "broadcast">("room");
  const [targetId, setTargetId] = useState("");
  const [message, setMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<
    Array<{
      from: string;
      body: string;
      at: string;
      room: string;
      self: boolean;
    }>
  >([]);
  const [events, setEvents] = useState<Array<{ label: string; at: string }>>(
    [],
  );
  const [voiceMode, setVoiceMode] = useState<"always_on" | "ptt">(
    initialGlobalSettings.enableDirectPpt ? "ptt" : "always_on",
  );
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "reconnecting" | "offline"
  >("offline");
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState(
    initialGlobalSettings.selectedInputDeviceId,
  );
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState(
    initialGlobalSettings.selectedOutputDeviceId,
  );
  const [enableDirectPpt, setEnableDirectPpt] = useState(
    initialGlobalSettings.enableDirectPpt,
  );
  const [enableDirectTabs, setEnableDirectTabs] = useState(
    initialGlobalSettings.enableDirectTabs,
  );
  const [inputGainByDeviceId, setInputGainByDeviceId] = useState<
    Record<string, number>
  >(initialGlobalSettings.inputGainByDeviceId ?? {});
  const [roomGainById, setRoomGainById] = useState<Record<string, number>>(
    initialGlobalSettings.roomGainById,
  );
  const [directGainByUserId, setDirectGainByUserId] = useState<
    Record<string, number>
  >(initialGlobalSettings.directGainByUserId);
  const [pinnedRoomIds, setPinnedRoomIds] = useState<string[]>(
    initialFavorites.pinnedRoomIds,
  );
  const [pinnedUserIds, setPinnedUserIds] = useState<string[]>(
    initialFavorites.pinnedUserIds,
  );
  const [showPinnedOnly, setShowPinnedOnly] = useState<boolean>(
    initialFavorites.showPinnedOnly,
  );
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [inputLevelDbFs, setInputLevelDbFs] = useState(meterDbFsFloor);
  const [inputSamplePeakClipping, setInputSamplePeakClipping] = useState(false);
  const [displayedInputClipping, setDisplayedInputClipping] = useState(false);
  const [audioError, setAudioError] = useState<string>("");
  const [webrtcState, setWebrtcState] = useState<string>("new");
  const [rtpStats, setRtpStats] = useState<{ inKbps: number; outKbps: number }>(
    { inKbps: 0, outKbps: 0 },
  );
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [isOutputMenuOpen, setIsOutputMenuOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"station" | "simple">("station");
  const [authMode, setAuthMode] = useState<"operator" | "admin">("operator");
  const [adminPinInput, setAdminPinInput] = useState("");
  const [adminLoginError, setAdminLoginError] = useState("");
  const [adminPinGuard, setAdminPinGuard] = useState<string>(defaultAdminPin);
  const [adminOverrideActive, setAdminOverrideActive] = useState(false);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState<boolean>(false);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
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
  const [incomingAttention, setIncomingAttention] = useState<{
    title: string;
    detail: string;
  } | null>(null);
  const [attentionFlashKey, setAttentionFlashKey] = useState(0);
  const [incomingAudioActive, setIncomingAudioActive] = useState(false);
  const [activeVoiceRoutes, setActiveVoiceRoutes] = useState<
    Array<{
      senderUserID: string;
      scope: "direct" | "room" | "broadcast";
      targetID: string;
      label: string;
    }>
  >([]);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteSourceUserIdRef = useRef<Map<string, string>>(new Map());
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const pendingICERef = useRef<
    Array<{ candidate: string; sdpMid?: string; sdpMLineIndex?: number }>
  >([]);
  const activeVoiceRoutesRef = useRef<
    Map<
      string,
      {
        senderUserID: string;
        scope: "direct" | "room" | "broadcast";
        targetID: string;
        label: string;
      }
    >
  >(new Map());
  const remoteAnalyserNodesRef = useRef<
    Map<
      string,
      {
        ctx: AudioContext;
        analyser: AnalyserNode;
        gain: GainNode;
        buf: Uint8Array;
      }
    >
  >(new Map());
  const remoteAudioMeterRafRef = useRef<number | null>(null);
  const incomingAudioOffTimeoutRef = useRef<number | null>(null);
  const incomingAttentionTimeoutRef = useRef<number | null>(null);
  const incomingAudioActiveRef = useRef(false);
  const roomSwitchTimerRef = useRef<number | null>(null);
  const voiceModeRef = useRef(voiceMode);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterMonitorStreamRef = useRef<MediaStream | null>(null);
  const inputCaptureStreamRef = useRef<MediaStream | null>(null);
  const inputProcessingAudioCtxRef = useRef<AudioContext | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const inputClippingDisplayTimeoutRef = useRef<number | null>(null);
  const micReinitGenerationRef = useRef(0);
  const statsIntervalRef = useRef<number | null>(null);
  const lastStatsRef = useRef<{
    ts: number;
    inBytes: number;
    outBytes: number;
  } | null>(null);
  const selectedInputDeviceIdRef = useRef(
    initialGlobalSettings.selectedInputDeviceId,
  );
  const selectedOutputDeviceIdRef = useRef(
    initialGlobalSettings.selectedOutputDeviceId,
  );
  const roomGainByIdRef = useRef(initialGlobalSettings.roomGainById);
  const inputGainByDeviceIdRef = useRef(
    initialGlobalSettings.inputGainByDeviceId ?? {},
  );
  const directGainByUserIdRef = useRef(
    initialGlobalSettings.directGainByUserId,
  );
  const listenRoomIdsRef = useRef<string[]>(listenRoomIds);
  const talkRoomIdsRef = useRef<string[]>(talkRoomIds);
  const prevChannelRef = useRef<string>("");
  const pendingInitialRoomRestoreRef = useRef(hadStoredRoomMatrix);
  const micMenuRef = useRef<HTMLDivElement | null>(null);
  const outputMenuRef = useRef<HTMLDivElement | null>(null);
  const showDebug = (() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("debug");
    return value === "1" || value === "true";
  })();

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
  useEffect(() => {
    selectedInputDeviceIdRef.current = selectedInputDeviceId;
  }, [selectedInputDeviceId]);
  useEffect(() => {
    selectedOutputDeviceIdRef.current = selectedOutputDeviceId;
  }, [selectedOutputDeviceId]);
  useEffect(() => {
    roomGainByIdRef.current = roomGainById;
  }, [roomGainById]);
  useEffect(() => {
    inputGainByDeviceIdRef.current = inputGainByDeviceId;
  }, [inputGainByDeviceId]);
  useEffect(() => {
    directGainByUserIdRef.current = directGainByUserId;
  }, [directGainByUserId]);
  useEffect(() => {
    listenRoomIdsRef.current = listenRoomIds;
  }, [listenRoomIds]);
  useEffect(() => {
    talkRoomIdsRef.current = talkRoomIds;
  }, [talkRoomIds]);

  useEffect(() => {
    localStorage.removeItem(tokenStorageKey);
    getPublicBootstrap().then(setPublicData).catch(console.error);
  }, []);

  useEffect(() => {
    localStorage.setItem(
      sessionSettingsStorageKey,
      JSON.stringify({
        username,
        roleId,
        listenRoomIds,
        talkRoomIds,
      } satisfies SessionSettings),
    );
  }, [username, roleId, listenRoomIds, talkRoomIds]);

  useEffect(() => {
    localStorage.setItem(
      globalSettingsStorageKey,
      JSON.stringify({
        selectedInputDeviceId,
        selectedOutputDeviceId,
        enableDirectPpt,
        enableDirectTabs,
        inputGainByDeviceId,
        roomGainById,
        directGainByUserId,
      } satisfies GlobalSettings),
    );
  }, [
    selectedInputDeviceId,
    selectedOutputDeviceId,
    enableDirectPpt,
    enableDirectTabs,
    inputGainByDeviceId,
    roomGainById,
    directGainByUserId,
  ]);

  useEffect(() => {
    localStorage.setItem(
      favoritesStorageKey,
      JSON.stringify({
        pinnedRoomIds,
        pinnedUserIds,
        showPinnedOnly,
      } satisfies FavoriteSettings),
    );
  }, [pinnedRoomIds, pinnedUserIds, showPinnedOnly]);

  useEffect(() => {
    if (!token) return;
    bootstrap(token)
      .then((data) => {
        setAppData(data);
        setRoleID(data.self.roleId);
        const roleDefaults = data.roles.find(
          (role) => role.id === data.self.roleId,
        );
        const sanitizedListen = listenRoomIdsRef.current.filter((roomId) => {
          const room = data.rooms.find((entry) => entry.id === roomId);
          return !!room && roleAllowed(room.receiverRoleIds, data.self.roleId);
        });
        const sanitizedTalk = talkRoomIdsRef.current.filter((roomId) => {
          const room = data.rooms.find((entry) => entry.id === roomId);
          return !!room && roleAllowed(room.senderRoleIds, data.self.roleId);
        });
        pendingInitialRoomRestoreRef.current =
          sanitizedListen.length > 0 || sanitizedTalk.length > 0;
        if (sanitizedListen.length > 0 || sanitizedTalk.length > 0) {
          setListenRoomIds(sanitizedListen);
          setTalkRoomIds(sanitizedTalk);
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
            setListenRoomIds(initialCanListen ? [initialRoom] : []);
            setTalkRoomIds(initialCanTalk ? [initialRoom] : []);
          }
        }
        if (roleDefaults?.defaultVoiceMode) {
          const nextMode = roleDefaults.defaultVoiceMode as "always_on" | "ptt";
          setVoiceMode(nextMode);
          voiceModeRef.current = nextMode;
        }
        setViewMode(roleDefaults?.defaultSimpleView ? "simple" : "station");
      })
      .catch(() => {
        sessionStorage.removeItem(tokenStorageKey);
        localStorage.removeItem(tokenStorageKey);
        setToken(null);
      });
  }, [token]);

  useEffect(() => {
    if (!appData) return;
    setPinnedRoomIds((prev) =>
      prev.filter((id) => appData.rooms.some((room) => room.id === id)),
    );
    setPinnedUserIds((prev) =>
      prev.filter((id) => appData.users.some((user) => user.id === id)),
    );
  }, [appData]);

  useEffect(() => {
    if (!appData) return;
    setRoomGainById((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([roomId]) =>
          appData.rooms.some((room) => room.id === roomId),
        ),
      );
      return next;
    });
    setDirectGainByUserId((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([userId]) =>
          appData.users.some((user) => user.id === userId),
        ),
      );
      return next;
    });
  }, [appData]);

  function resolveGainForSourceUser(sourceUserID: string): number {
    if (!appData) return 1;
    const routes = Array.from(activeVoiceRoutesRef.current.values());
    if (!sourceUserID) {
      const directToSelfRoutes = routes.filter(
        (route) =>
          route.scope === "direct" && route.targetID === appData.self.id,
      );
      if (directToSelfRoutes.length > 0) {
        let gain = 1;
        for (const route of directToSelfRoutes) {
          gain = Math.max(
            gain,
            clampGainValue(
              directGainByUserIdRef.current[route.senderUserID] ?? 1,
            ),
          );
        }
        return gain;
      }
      let roomGain = 1;
      for (const route of routes) {
        if (route.scope !== "room") continue;
        if (!listenRoomIdsRef.current.includes(route.targetID)) continue;
        roomGain = Math.max(
          roomGain,
          clampGainValue(roomGainByIdRef.current[route.targetID] ?? 1),
        );
      }
      if (roomGain !== 1) return roomGain;
      for (const p of presence) {
        if (p.userId === appData.self.id) continue;
        if (p.voiceMode !== "always_on" || !p.micEnabled) continue;
        for (const roomId of p.talkRooms || []) {
          if (!listenRoomIdsRef.current.includes(roomId)) continue;
          roomGain = Math.max(
            roomGain,
            clampGainValue(roomGainByIdRef.current[roomId] ?? 1),
          );
        }
      }
      const anchorRoomID = matrixAnchorRoomId(
        listenRoomIdsRef.current,
        talkRoomIdsRef.current,
      );
      if (anchorRoomID) {
        return clampGainValue(
          roomGainByIdRef.current[anchorRoomID] ?? roomGain,
        );
      }
      if (listenRoomIdsRef.current.length > 0) {
        let fallbackRoomGain = roomGain;
        for (const roomID of listenRoomIdsRef.current) {
          fallbackRoomGain = Math.max(
            fallbackRoomGain,
            clampGainValue(roomGainByIdRef.current[roomID] ?? 1),
          );
        }
        return fallbackRoomGain;
      }
      return roomGain;
    }
    const directToSelf = routes.some(
      (route) =>
        route.senderUserID === sourceUserID &&
        route.scope === "direct" &&
        route.targetID === appData.self.id,
    );
    if (directToSelf) {
      return clampGainValue(directGainByUserIdRef.current[sourceUserID] ?? 1);
    }
    const senderPresence = presence.find((p) => p.userId === sourceUserID);
    if (
      senderPresence &&
      Array.isArray(senderPresence.talkRooms) &&
      senderPresence.talkRooms.length > 0
    ) {
      const listenedTalkRooms = senderPresence.talkRooms.filter((roomID) =>
        listenRoomIdsRef.current.includes(roomID),
      );
      if (listenedTalkRooms.length > 0) {
        const roomToUse =
          senderPresence.activeRoom &&
          listenedTalkRooms.includes(senderPresence.activeRoom)
            ? senderPresence.activeRoom
            : listenedTalkRooms[0];
        return clampGainValue(roomGainByIdRef.current[roomToUse] ?? 1);
      }
    }
    const routedRoom = routes.find(
      (route) =>
        route.senderUserID === sourceUserID &&
        route.scope === "room" &&
        listenRoomIdsRef.current.includes(route.targetID),
    );
    if (routedRoom) {
      return clampGainValue(roomGainByIdRef.current[routedRoom.targetID] ?? 1);
    }
    return 1;
  }

  function applyVolumeToRemoteAudio(key: string) {
    const sourceUserID = remoteSourceUserIdRef.current.get(key) || "";
    const gainValue = resolveGainForSourceUser(sourceUserID);
    const analyserNode = remoteAnalyserNodesRef.current.get(key);
    if (analyserNode) {
      analyserNode.gain.gain.value = gainValue;
    }
    const audio = remoteAudioRef.current.get(key);
    if (audio) {
      audio.volume = Math.min(1, Math.max(0, gainValue));
    }
  }

  function applyVolumeToAllRemoteAudio() {
    for (const key of remoteAudioRef.current.keys()) {
      applyVolumeToRemoteAudio(key);
    }
  }

  const refreshAudioDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    setInputDevices(inputs);
    setOutputDevices(outputs);
    setSelectedInputDeviceId((prev) => {
      if (prev && inputs.some((d) => d.deviceId === prev)) return prev;
      return inputs[0]?.deviceId || "";
    });
    setSelectedOutputDeviceId((prev) => {
      if (prev && outputs.some((d) => d.deviceId === prev)) return prev;
      return "";
    });
  }, []);

  useEffect(() => {
    void refreshAudioDevices();
    navigator.mediaDevices.addEventListener(
      "devicechange",
      refreshAudioDevices,
    );
    return () =>
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        refreshAudioDevices,
      );
  }, [refreshAudioDevices]);
  useEffect(() => {
    if (!(window.isSecureContext || window.location.hostname === "localhost")) {
      setAudioError(
        "Microphone capture needs HTTPS (or localhost). Open the app via HTTPS for remote devices.",
      );
    }
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        micMenuRef.current &&
        event.target instanceof Node &&
        !micMenuRef.current.contains(event.target)
      ) {
        setIsMicMenuOpen(false);
      }
      if (
        outputMenuRef.current &&
        event.target instanceof Node &&
        !outputMenuRef.current.contains(event.target)
      ) {
        setIsOutputMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function clearReconnectTimer() {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }

  async function canApplyOutputDevice(
    outputDeviceId: string,
  ): Promise<boolean> {
    if (outputDeviceId === "") return true;
    type AudioWithSinkId = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const probe = document.createElement("audio") as AudioWithSinkId;
    if (typeof probe.setSinkId !== "function") return false;
    return applyOutputDeviceToAudio(probe as HTMLAudioElement, outputDeviceId);
  }

  async function changeOutputDevice(outputDeviceId: string) {
    if (outputDeviceId === selectedOutputDeviceIdRef.current) return;
    const canApply = await canApplyOutputDevice(outputDeviceId);
    if (!canApply) return;
    setSelectedOutputDeviceId(outputDeviceId);
    selectedOutputDeviceIdRef.current = outputDeviceId;
    setAudioError("");
  }
  function clearIncomingAttentionTimer() {
    if (incomingAttentionTimeoutRef.current !== null) {
      window.clearTimeout(incomingAttentionTimeoutRef.current);
      incomingAttentionTimeoutRef.current = null;
    }
  }

  function triggerIncomingAttention(event: RoutedEvent) {
    if (!appData) return;
    let title = "Incoming signal";
    let detail = event.fromUser.username;
    if (event.scope === "room") {
      const roomName =
        appData.rooms.find((room) => room.id === event.targetId)?.name ||
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

  function stopRemoteAudioMeter() {
    if (remoteAudioMeterRafRef.current !== null) {
      cancelAnimationFrame(remoteAudioMeterRafRef.current);
      remoteAudioMeterRafRef.current = null;
    }
    if (incomingAudioOffTimeoutRef.current !== null) {
      window.clearTimeout(incomingAudioOffTimeoutRef.current);
      incomingAudioOffTimeoutRef.current = null;
    }
    for (const { ctx } of remoteAnalyserNodesRef.current.values()) {
      void ctx.close();
    }
    remoteAnalyserNodesRef.current.clear();
    incomingAudioActiveRef.current = false;
    setIncomingAudioActive(false);
  }

  function startRemoteAudioMeterLoop() {
    if (remoteAudioMeterRafRef.current !== null) return;
    const tick = () => {
      let active = false;
      for (const { analyser, buf } of remoteAnalyserNodesRef.current.values()) {
        analyser.getByteTimeDomainData(
          buf as unknown as Uint8Array<ArrayBuffer>,
        );
        let sum = 0;
        for (const v of buf) {
          const centered = (v - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 0.018) {
          active = true;
          break;
        }
      }
      if (active) {
        if (incomingAudioOffTimeoutRef.current !== null) {
          window.clearTimeout(incomingAudioOffTimeoutRef.current);
          incomingAudioOffTimeoutRef.current = null;
        }
        if (!incomingAudioActiveRef.current) {
          incomingAudioActiveRef.current = true;
          setIncomingAudioActive(true);
        }
      } else if (
        incomingAudioActiveRef.current &&
        incomingAudioOffTimeoutRef.current === null
      ) {
        incomingAudioOffTimeoutRef.current = window.setTimeout(() => {
          incomingAudioOffTimeoutRef.current = null;
          incomingAudioActiveRef.current = false;
          setIncomingAudioActive(false);
        }, 1000);
      }
      remoteAudioMeterRafRef.current = requestAnimationFrame(tick);
    };
    remoteAudioMeterRafRef.current = requestAnimationFrame(tick);
  }

  function refreshActiveVoiceChannelState() {
    setActiveVoiceRoutes(Array.from(activeVoiceRoutesRef.current.values()));
    applyVolumeToAllRemoteAudio();
  }

  function updateVoiceRoute(
    senderUserID: string,
    scopeValue: "direct" | "room" | "broadcast",
    targetID: string,
    body: string,
    fromUsername: string,
  ) {
    const routeKey = `${senderUserID}:${scopeValue}:${targetID}`;
    const label =
      scopeValue === "room"
        ? appData?.rooms.find((r) => r.id === targetID)?.name || targetID
        : scopeValue === "broadcast"
          ? appData?.broadcastGroups.find((g) => g.id === targetID)?.name ||
            targetID
          : `Direct · ${fromUsername}`;
    if (body === "ptt_start" || body === "always_on") {
      activeVoiceRoutesRef.current.set(routeKey, {
        senderUserID,
        scope: scopeValue,
        targetID,
        label,
      });
    } else if (body === "ptt_stop") {
      activeVoiceRoutesRef.current.delete(routeKey);
    }
    refreshActiveVoiceChannelState();
  }

  function canRoleSendToRoom(roomId: string, currentRoleId: string) {
    const room = appData?.rooms.find((entry) => entry.id === roomId);
    if (!room) return false;
    return roleAllowed(room.senderRoleIds, currentRoleId);
  }

  function canRoleReceiveFromRoom(roomId: string, currentRoleId: string) {
    const room = appData?.rooms.find((entry) => entry.id === roomId);
    if (!room) return false;
    return roleAllowed(room.receiverRoleIds, currentRoleId);
  }

  function toggleListenRoom(roomId: string) {
    if (!appData || !canRoleReceiveFromRoom(roomId, appData.self.roleId))
      return;
    setListenRoomIds((prev) => toggleRoomSelectionState(prev, roomId));
  }

  function toggleTalkRoom(roomId: string) {
    if (!appData || !canRoleSendToRoom(roomId, appData.self.roleId)) return;
    setTalkRoomIds((prev) => {
      if (prev[0] === roomId && prev.length === 1) return prev;
      return [roomId];
    });
  }

  const togglePinnedRoom = useCallback((roomId: string) => {
    setPinnedRoomIds((prev) =>
      prev.includes(roomId)
        ? prev.filter((id) => id !== roomId)
        : [...prev, roomId],
    );
  }, []);

  const togglePinnedUser = useCallback((userId: string) => {
    setPinnedUserIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  }, []);

  function clearRoomSwitchTimer() {
    if (roomSwitchTimerRef.current !== null) {
      window.clearTimeout(roomSwitchTimerRef.current);
      roomSwitchTimerRef.current = null;
    }
  }

  function stopStatsLoop() {
    if (statsIntervalRef.current !== null) {
      window.clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    lastStatsRef.current = null;
    setRtpStats({ inKbps: 0, outKbps: 0 });
  }

  function startStatsLoop(pc: RTCPeerConnection) {
    stopStatsLoop();
    statsIntervalRef.current = window.setInterval(() => {
      void (async () => {
        const report = await pc.getStats();
        let inBytes = 0;
        let outBytes = 0;
        report.forEach((s) => {
          if (
            s.type === "inbound-rtp" &&
            (s as RTCInboundRtpStreamStats).kind === "audio"
          ) {
            inBytes += (s as RTCInboundRtpStreamStats).bytesReceived || 0;
          }
          if (
            s.type === "outbound-rtp" &&
            (s as RTCOutboundRtpStreamStats).kind === "audio"
          ) {
            outBytes += (s as RTCOutboundRtpStreamStats).bytesSent || 0;
          }
        });
        const now = Date.now();
        const prev = lastStatsRef.current;
        if (!prev) {
          lastStatsRef.current = { ts: now, inBytes, outBytes };
          return;
        }
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec <= 0) return;
        const inKbps = ((inBytes - prev.inBytes) * 8) / 1000 / dtSec;
        const outKbps = ((outBytes - prev.outBytes) * 8) / 1000 / dtSec;
        lastStatsRef.current = { ts: now, inBytes, outBytes };
        setRtpStats({
          inKbps: Math.max(0, Math.round(inKbps)),
          outKbps: Math.max(0, Math.round(outKbps)),
        });
      })().catch(() => undefined);
    }, 1000);
  }

  function stopLevelMeter() {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    analyserRef.current = null;
    if (meterMonitorStreamRef.current) {
      for (const track of meterMonitorStreamRef.current.getTracks()) {
        track.stop();
      }
      meterMonitorStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setInputLevelDbFs(meterDbFsFloor);
    setInputSamplePeakClipping(false);
  }

  function stopInputProcessing() {
    if (inputCaptureStreamRef.current) {
      for (const track of inputCaptureStreamRef.current.getTracks()) {
        track.stop();
      }
      inputCaptureStreamRef.current = null;
    }
    if (inputProcessingAudioCtxRef.current) {
      void inputProcessingAudioCtxRef.current.close();
      inputProcessingAudioCtxRef.current = null;
    }
    inputGainNodeRef.current = null;
  }

  function selectedInputGainFor(deviceId: string): number {
    return clampGainValue(
      inputGainByDeviceIdRef.current[inputGainDeviceKey(deviceId)] ?? 1,
    );
  }

  function buildOutgoingMicStream(
    sourceStream: MediaStream,
    gainValue: number,
  ): MediaStream {
    const sourceTrack = sourceStream.getAudioTracks()[0];
    if (!sourceTrack) return sourceStream;
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return sourceStream;
    try {
      const ctx = new AudioCtx();
      const src = ctx.createMediaStreamSource(sourceStream);
      const gain = ctx.createGain();
      gain.gain.value = clampGainValue(gainValue);
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(dest);
      const processedTrack = dest.stream.getAudioTracks()[0];
      if (!processedTrack) {
        void ctx.close();
        return sourceStream;
      }
      inputProcessingAudioCtxRef.current = ctx;
      inputGainNodeRef.current = gain;
      return new MediaStream([processedTrack]);
    } catch {
      return sourceStream;
    }
  }

  function startLevelMeter(stream: MediaStream) {
    stopLevelMeter();
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const sourceTrack = stream.getAudioTracks()[0];
    if (!sourceTrack) return;
    const monitorTrack = sourceTrack.clone();
    const monitorStream = new MediaStream([monitorTrack]);
    meterMonitorStreamRef.current = monitorStream;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(monitorStream);
    const meterGain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(meterGain);
    meterGain.connect(analyser);
    analyserRef.current = analyser;
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      meterGain.gain.value = clampGainValue(
        inputGainNodeRef.current?.gain.value ?? 1,
      );
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) {
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      setInputLevelDbFs(peakAmplitudeToDbFs(peak));
      setInputSamplePeakClipping(peak >= 1);
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
  }

  function applyVoiceModeToLocalTracks(mode: "always_on" | "ptt") {
    const stream = localStreamRef.current;
    if (!stream) return;
    const enabled = mode === "always_on";
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  async function applyOutputDeviceToAudio(
    audio: HTMLAudioElement,
    outputDeviceId: string,
  ): Promise<boolean> {
    type AudioWithSinkId = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const audioWithSink = audio as AudioWithSinkId;
    if (typeof audioWithSink.setSinkId !== "function")
      return outputDeviceId === "";
    const sinkId = outputDeviceId || "default";
    try {
      await audioWithSink.setSinkId(sinkId);
      return true;
    } catch (err) {
      setAudioError(
        `Failed to switch speaker output: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return false;
    }
  }

  async function getMicStream(deviceId: string): Promise<MediaStream> {
    const baseAudio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...baseAudio, deviceId: { exact: deviceId } },
          video: false,
        });
      } catch {
        return navigator.mediaDevices.getUserMedia({
          audio: baseAudio,
          video: false,
        });
      }
    }
    return navigator.mediaDevices.getUserMedia({
      audio: baseAudio,
      video: false,
    });
  }

  useEffect(() => {
    applyVolumeToAllRemoteAudio();
  }, [roomGainById, directGainByUserId]);
  function cleanupRealtimeResources() {
    micReinitGenerationRef.current += 1;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    for (const audio of remoteAudioRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    remoteAudioRef.current.clear();
    remoteSourceUserIdRef.current.clear();
    activeVoiceRoutesRef.current.clear();
    setActiveVoiceRoutes([]);
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    stopInputProcessing();
    pendingICERef.current = [];
    stopStatsLoop();
    stopLevelMeter();
    stopRemoteAudioMeter();
    clearIncomingAttentionTimer();
    setIncomingAttention(null);
  }

  useEffect(() => {
    if (!token || !appData) return;
    shouldReconnectRef.current = true;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      setConnectionState(
        reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting",
      );
      pendingInitialRoomRestoreRef.current =
        listenRoomIdsRef.current.length > 0 ||
        talkRoomIdsRef.current.length > 0;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`,
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
        startStatsLoop(pc);
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
            remoteSourceUserIdRef.current.set(key, sourceUserID);
          }
          let audio = remoteAudioRef.current.get(key);
          if (!audio) {
            audio = document.createElement("audio");
            audio.autoplay = true;
            audio.muted = false;
            remoteAudioRef.current.set(key, audio);
          }
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          const playbackStream: MediaStream = stream;
          if (!remoteAnalyserNodesRef.current.has(key)) {
            const AudioCtx = window.AudioContext;
            if (AudioCtx) {
              const ctx = new AudioCtx();
              const src = ctx.createMediaStreamSource(stream);
              const gain = ctx.createGain();
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 256;
              src.connect(gain);
              gain.connect(analyser);
              const analyserBuf = new Uint8Array(
                new ArrayBuffer(analyser.frequencyBinCount),
              );
              remoteAnalyserNodesRef.current.set(key, {
                ctx,
                analyser,
                gain,
                buf: analyserBuf,
              });
              startRemoteAudioMeterLoop();
            }
          }
          audio.srcObject = playbackStream;
          applyVolumeToRemoteAudio(key);
          const reapplyOutputDevice = () => {
            void applyOutputDeviceToAudio(
              audio,
              selectedOutputDeviceIdRef.current,
            );
          };
          reapplyOutputDevice();
          void audio
            .play()
            .then(() => {
              reapplyOutputDevice();
            })
            .catch((err) => {
              setAudioError(
                `Remote audio playback blocked: ${err instanceof Error ? err.message : "unknown error"}`,
              );
            });
          setEvents((old) =>
            [
              {
                label: "system · webrtc · remote audio track attached",
                at: new Date().toLocaleTimeString(),
              },
              ...old,
            ].slice(0, 200),
          );
        };
        try {
          const captureStream = await getMicStream(
            selectedInputDeviceIdRef.current,
          );
          stopInputProcessing();
          inputCaptureStreamRef.current = captureStream;
          const stream = buildOutgoingMicStream(
            captureStream,
            selectedInputGainFor(selectedInputDeviceIdRef.current),
          );
          localStreamRef.current = stream;
          startLevelMeter(captureStream);
          void refreshAudioDevices();
          const initialEnabled = voiceModeRef.current === "always_on";
          for (const track of stream.getAudioTracks()) {
            track.enabled = initialEnabled;
            pc.addTrack(track, stream);
          }
          applyVoiceModeToLocalTracks(voiceModeRef.current);
        } catch (e) {
          setAudioError(
            `Failed to access microphone: ${e instanceof Error ? e.message : "unknown error"}`,
          );
          setEvents((old) =>
            [
              {
                label: "system · local/mic · capture failed (receive-only)",
                at: new Date().toLocaleTimeString(),
              },
              ...old,
            ].slice(0, 200),
          );
        }
        ws.send(JSON.stringify({ type: "webrtc_ready", data: {} }));
        const activeRoomId = matrixAnchorRoomId(
          listenRoomIdsRef.current,
          talkRoomIdsRef.current,
        );
        if (activeRoomId) {
          ws.send(
            JSON.stringify({
              type: "set_active_room",
              data: { roomId: activeRoomId },
            }),
          );
        }
        ws.send(
          JSON.stringify({
            type: "set_room_matrix",
            data: {
              activeRoomId,
              listenRoomIds: listenRoomIdsRef.current,
              talkRoomIds: talkRoomIdsRef.current,
            },
          }),
        );
        const initialVoiceMode = voiceModeRef.current;
        const voiceState =
          initialVoiceMode === "always_on" ? "always_on" : "ptt_stop";
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
        if (msg.type === "presence") {
          setPresence(normalizePresenceList(msg.data));
          return;
        }
        if (msg.type === "companion_command") {
          if (msg.data.command === "set_voice_mode" && msg.data.mode) {
            setAlwaysOn(msg.data.mode === "always_on");
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
              if (desiredState === "ptt_start" && resolvedTargetId) {
                setdirectPttPressedUserId(resolvedTargetId);
              } else {
                setdirectPttPressedUserId((current) =>
                  current === resolvedTargetId ? null : current,
                );
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
            if (resolvedTargetId) {
              sendScopedVoiceState(nextScope, resolvedTargetId, desiredState);
            }
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
            if (resolvedTargetId && msg.data.signal) {
              sendScopedSignal(nextScope, resolvedTargetId, msg.data.signal);
            }
            return;
          }
          if (msg.data.command === "set_active_room" && msg.data.roomId) {
            setTalkRoomIds([msg.data.roomId]);
            setListenRoomIds([msg.data.roomId]);
            wsRef.current?.send(
              JSON.stringify({
                type: "set_active_room",
                data: { roomId: msg.data.roomId },
              }),
            );
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
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              const activeRoomId =
                msg.data.activeRoomId ||
                matrixAnchorRoomId(nextListen, nextTalk);
              wsRef.current.send(
                JSON.stringify({
                  type: "set_room_matrix",
                  data: {
                    activeRoomId,
                    listenRoomIds: nextListen,
                    talkRoomIds: nextTalk,
                  },
                }),
              );
            }
            return;
          }
          return;
        }
        if (msg.type === "webrtc_offer") {
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
            await pc.setLocalDescription(answer);
            wsRef.current?.send(
              JSON.stringify({
                type: "webrtc_answer",
                data: { sdp: answer.sdp || "" },
              }),
            );
            setEvents((old) =>
              [
                {
                  label: "system · webrtc · answered offer",
                  at: new Date().toLocaleTimeString(),
                },
                ...old,
              ].slice(0, 200),
            );
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
          msg.data.fromUser.id !== appData.self.id &&
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
          msg.data.targetId === appData.self.id &&
          msg.data.fromUser.id !== appData.self.id &&
          msg.data.body === "ptt_start"
        ) {
          setLastDirectCallerUserId(msg.data.fromUser.id);
        }
        if (msg.type === "signal" && msg.data.fromUser.id !== appData.self.id) {
          const incomingGroupCall =
            msg.data.scope === "room" && msg.data.signal === "call";
          const incomingDirectSignal =
            msg.data.scope === "direct" &&
            msg.data.targetId === appData.self.id;
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
            const roomLabel =
              msg.data.scope === "room"
                ? appData.rooms.find((room) => room.id === msg.data.targetId)
                    ?.name || msg.data.targetId
                : msg.data.scope === "broadcast"
                  ? appData.broadcastGroups.find(
                      (group) => group.id === msg.data.targetId,
                    )?.name || msg.data.targetId
                  : "Direct";
            setChatMessages((old) =>
              [
                {
                  from: msg.data.fromUser.username,
                  body: chatBody,
                  at: new Date(msg.data.timestamp).toLocaleTimeString(),
                  room: roomLabel,
                  self: msg.data.fromUser.id === appData.self.id,
                },
                ...old,
              ].slice(0, 120),
            );
          }
        }
        const body = (msg.data.signal || msg.data.body || "").toString();
        setEvents((old) =>
          [
            {
              label: `${msg.type} · ${msg.data.fromUser.username} · ${msg.data.scope}/${msg.data.targetId} · ${body}`,
              at: new Date(msg.data.timestamp).toLocaleTimeString(),
            },
            ...old,
          ].slice(0, 200),
        );
      };

      ws.onclose = (event) => {
        clearRoomSwitchTimer();
        cleanupRealtimeResources();
        if (!shouldReconnectRef.current || cancelled) {
          setConnectionState("offline");
          return;
        }
        console.warn("WebSocket closed:", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        setEvents((old) =>
          [
            {
              label: `system · websocket closed · code:${event.code} clean:${event.wasClean ? "yes" : "no"} · reconnecting...`,
              at: new Date().toLocaleTimeString(),
            },
            ...old,
          ].slice(0, 200),
        );
        setConnectionState("reconnecting");
        reconnectAttemptsRef.current += 1;
        const backoff = Math.min(
          8000,
          500 * 2 ** Math.min(reconnectAttemptsRef.current, 5),
        );
        reconnectTimeoutRef.current = window.setTimeout(() => {
          void connect();
        }, backoff);
      };
      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        setEvents((old) =>
          [
            {
              label: `system · websocket error · ${event instanceof ErrorEvent ? event.message : "check console"}`,
              at: new Date().toLocaleTimeString(),
            },
            ...old,
          ].slice(0, 200),
        );
        ws.close();
      };
    };

    void connect();
    return () => {
      cancelled = true;
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      cleanupRealtimeResources();
      setConnectionState("offline");
    };
  }, [token, appData, refreshAudioDevices]);

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
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const activeRoomId = matrixAnchorRoomId(
            listenRoomIdsRef.current,
            talkRoomIdsRef.current,
          );
          if (activeRoomId) {
            wsRef.current.send(
              JSON.stringify({
                type: "set_active_room",
                data: { roomId: activeRoomId },
              }),
            );
          }
          wsRef.current.send(
            JSON.stringify({
              type: "set_room_matrix",
              data: {
                activeRoomId,
                listenRoomIds: listenRoomIdsRef.current,
                talkRoomIds: talkRoomIdsRef.current,
              },
            }),
          );
        }
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
      selfPresence.voiceMode === "always_on" ? "always_on" : "ptt";
    if (nextVoiceMode !== voiceModeRef.current) {
      setVoiceMode(nextVoiceMode);
      voiceModeRef.current = nextVoiceMode;
    }
    if (nextVoiceMode === "always_on") {
      setPttPressed(false);
      setdirectPttPressedUserId(null);
      setBroadcastPttPressed(null);
      return;
    }
    setPttPressed(selfPresence.micEnabled);
    if (!selfPresence.micEnabled) {
      setdirectPttPressedUserId(null);
      setBroadcastPttPressed(null);
    }
  }, [presence, appData]);

  useEffect(() => {
    clearRoomSwitchTimer();
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    roomSwitchTimerRef.current = window.setTimeout(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const activeRoomId = matrixAnchorRoomId(listenRoomIds, talkRoomIds);
      wsRef.current.send(
        JSON.stringify({
          type: "set_room_matrix",
          data: {
            activeRoomId,
            listenRoomIds,
            talkRoomIds,
          },
        }),
      );
      setEvents((old) =>
        [
          {
            label: `system · matrix updated · ${activeRoomId || "no-room"}`,
            at: new Date().toLocaleTimeString(),
          },
          ...old,
        ].slice(0, 200),
      );
    }, 120);
    return () => clearRoomSwitchTimer();
  }, [listenRoomIds, talkRoomIds]);

  useEffect(() => {
    if (!token || !appData || !pcRef.current) return;
    const generation = ++micReinitGenerationRef.current;
    void (async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const newCaptureStream = await getMicStream(selectedInputDeviceId);
        if (generation !== micReinitGenerationRef.current) {
          for (const t of newCaptureStream.getTracks()) t.stop();
          return;
        }
        stopInputProcessing();
        inputCaptureStreamRef.current = newCaptureStream;
        const newStream = buildOutgoingMicStream(
          newCaptureStream,
          selectedInputGainFor(selectedInputDeviceId),
        );
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          pc.addTrack(newTrack, newStream);
        }
        if (generation !== micReinitGenerationRef.current) {
          for (const t of newStream.getTracks()) t.stop();
          return;
        }
        if (localStreamRef.current) {
          for (const t of localStreamRef.current.getTracks()) t.stop();
        }
        localStreamRef.current = newStream;
        startLevelMeter(newCaptureStream);
        applyVoiceModeToLocalTracks(voiceModeRef.current);
        setAudioError("");
      } catch (e) {
        setAudioError(
          `Failed to switch microphone: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    })();
    return () => {
      if (generation === micReinitGenerationRef.current) {
        micReinitGenerationRef.current += 1;
      }
    };
  }, [selectedInputDeviceId, token, appData]);

  useEffect(() => {
    const selectedGain = selectedInputGainFor(selectedInputDeviceId);
    if (inputGainNodeRef.current) {
      inputGainNodeRef.current.gain.value = selectedGain;
    }
  }, [selectedInputDeviceId, inputGainByDeviceId]);

  useEffect(() => {
    for (const audio of remoteAudioRef.current.values()) {
      void applyOutputDeviceToAudio(audio, selectedOutputDeviceId);
    }
  }, [selectedOutputDeviceId]);

  const onRoomGainChange = useCallback((roomId: string, gain: number) => {
    setRoomGainById((prev) => ({ ...prev, [roomId]: clampGainValue(gain) }));
  }, []);

  const onDirectGainChange = useCallback((userId: string, gain: number) => {
    setDirectGainByUserId((prev) => ({
      ...prev,
      [userId]: clampGainValue(gain),
    }));
  }, []);

  const onInputGainChange = useCallback((deviceId: string, gain: number) => {
    const key = inputGainDeviceKey(deviceId);
    setInputGainByDeviceId((prev) => ({
      ...prev,
      [key]: clampGainValue(gain),
    }));
  }, []);

  const currentTargets = useMemo(() => {
    if (!appData) return [];
    if (scope === "direct") {
      return appData.users
        .filter(
          (u) =>
            u.id !== appData.self.id && u.username.toLowerCase() !== "admin",
        )
        .map((u) => ({ id: u.id, label: `${u.username} (${u.roleId})` }));
    }
    if (scope === "room") {
      return appData.rooms
        .filter((room) => roleAllowed(room.senderRoleIds, appData.self.roleId))
        .map((r) => ({ id: r.id, label: r.name }));
    }
    return appData.broadcastGroups
      .filter((group) =>
        roleAllowed(
          Array.isArray(group.allowedRoleIds) ? group.allowedRoleIds : [],
          appData.self.roleId,
        ),
      )
      .map((b) => ({ id: b.id, label: b.name }));
  }, [scope, appData]);

  const selectedMicLabel = useMemo(() => {
    return (
      inputDevices.find((d) => d.deviceId === selectedInputDeviceId)?.label ||
      "Select microphone"
    );
  }, [inputDevices, selectedInputDeviceId]);
  const selectedInputGain = useMemo(
    () =>
      clampGainValue(
        inputGainByDeviceId[inputGainDeviceKey(selectedInputDeviceId)] ?? 1,
      ),
    [selectedInputDeviceId, inputGainByDeviceId],
  );
  const inputClipping = inputSamplePeakClipping;
  useEffect(() => {
    if (displayedInputClipping === inputClipping) return;
    if (inputClippingDisplayTimeoutRef.current !== null) {
      window.clearTimeout(inputClippingDisplayTimeoutRef.current);
      inputClippingDisplayTimeoutRef.current = null;
    }
    inputClippingDisplayTimeoutRef.current = window.setTimeout(() => {
      inputClippingDisplayTimeoutRef.current = null;
      setDisplayedInputClipping(inputClipping);
    }, 2000);
    return () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
    };
  }, [inputClipping, displayedInputClipping]);
  useEffect(
    () => () => {
      if (inputClippingDisplayTimeoutRef.current !== null) {
        window.clearTimeout(inputClippingDisplayTimeoutRef.current);
        inputClippingDisplayTimeoutRef.current = null;
      }
    },
    [],
  );
  const outputSelectionSupported = useMemo(() => {
    type AudioWithSinkId = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const probe = document.createElement("audio") as AudioWithSinkId;
    return typeof probe.setSinkId === "function";
  }, []);
  const selectedOutputLabel = useMemo(() => {
    if (!selectedOutputDeviceId) return "System default";
    return (
      outputDevices.find((d) => d.deviceId === selectedOutputDeviceId)?.label ||
      "System default"
    );
  }, [outputDevices, selectedOutputDeviceId]);
  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of appData?.roles || []) map.set(role.id, role.name);
    return map;
  }, [appData]);

  const availableChannels = useMemo(() => {
    return (appData?.rooms || []).map((room) => ({
      id: room.id,
      label: room.name,
    }));
  }, [appData]);

  useEffect(() => {
    setTargetId((prev) => {
      if (currentTargets.some((target) => target.id === prev)) return prev;
      return currentTargets[0]?.id || "";
    });
  }, [currentTargets]);

  async function doLogin(overrideUsername?: string, overrideRoleId?: string) {
    const useUsername =
      typeof overrideUsername === "string" ? overrideUsername : username.trim();
    const useRoleId =
      typeof overrideRoleId === "string" ? overrideRoleId : roleId;
    const res = await login(useUsername, useRoleId);
    sessionStorage.setItem(tokenStorageKey, res.token);
    localStorage.removeItem(tokenStorageKey);
    setToken(res.token);
  }

  async function handleOperatorLogin() {
    setAuthMode("operator");
    setAdminLoginError("");
    await doLogin();
  }

  async function handleAdminLogin() {
    if (adminPinInput.trim() !== adminPinGuard) {
      setAdminLoginError("Incorrect admin PIN.");
      return;
    }
    setAdminLoginError("");
    setAuthMode("admin");
    // Allow direct admin login even when no username/role selected.
    // Use provided username/role if present, otherwise fall back to sensible defaults.
    const nextRoleId = roleId || publicData?.roles?.[0]?.id || "";
    if (!nextRoleId) {
      setAdminLoginError("No role available for admin login.");
      return;
    }
    // Perform a login using the reserved admin username, but don't overwrite the user's session settings.
    await doLogin("admin", nextRoleId);
    setAdminOverrideActive(true);
  }

  async function doLogout() {
    if (token) {
      await logout(token);
      sessionStorage.removeItem(tokenStorageKey);
      localStorage.removeItem(tokenStorageKey);
      localStorage.removeItem(sessionSettingsStorageKey);
      setAuthMode("operator");
      setAdminPinInput("");
      setAdminLoginError("");
      setAdminOverrideActive(false);
      setToken(null);
      setAppData(null);
      setPresence([]);
      setLastDirectCallerUserId(null);
      setViewMode("station");
      clearReconnectTimer();
      cleanupRealtimeResources();
      setConnectionState("offline");
    }
  }

  async function refreshBootstrapData() {
    if (!token) return;
    const data = await bootstrap(token);
    setAppData(data);
    const roleDefaults = data.roles.find(
      (role) => role.id === data.self.roleId,
    );
    setViewMode(roleDefaults?.defaultSimpleView ? "simple" : "station");
    setPublicData({
      roles: data.roles,
      rooms: data.rooms,
      broadcastGroups: data.broadcastGroups,
    });
    setListenRoomIds((prev) => {
      const next = prev.filter((roomId) => {
        const room = data.rooms.find((entry) => entry.id === roomId);
        return !!room && roleAllowed(room.receiverRoleIds, data.self.roleId);
      });
      if (next.length > 0) return next;
      const firstAllowed = data.rooms.find((room) =>
        roleAllowed(room.receiverRoleIds, data.self.roleId),
      );
      return firstAllowed ? [firstAllowed.id] : [];
    });
    setTalkRoomIds((prev) => {
      const next = prev.filter((roomId) => {
        const room = data.rooms.find((entry) => entry.id === roomId);
        return !!room && roleAllowed(room.senderRoleIds, data.self.roleId);
      });
      if (next.length > 0) return next;
      const firstAllowed = data.rooms.find((room) =>
        roleAllowed(room.senderRoleIds, data.self.roleId),
      );
      return firstAllowed ? [firstAllowed.id] : [];
    });
  }

  function sendChat() {
    if (
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      !message.trim()
    )
      return;
    const resolvedTargetId =
      scope === "room"
        ? matrixAnchorRoomId(
            listenRoomIdsRef.current,
            talkRoomIdsRef.current,
          ) || targetId
        : targetId;
    if (!resolvedTargetId) return;
    wsRef.current.send(
      JSON.stringify({
        type: "chat",
        data: { scope, targetId: resolvedTargetId, body: message.trim() },
      }),
    );
    setMessage("");
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
    wsRef.current.send(
      JSON.stringify({
        type: "signal",
        data: { scope: scopeValue, targetId: scopedTargetId, signal },
      }),
    );
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
    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        if (state === "always_on" || state === "ptt_start") {
          track.enabled = true;
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

  function sendVoiceState(state: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const voiceTargetId = matrixAnchorRoomId(
      listenRoomIdsRef.current,
      talkRoomIdsRef.current,
    );
    if (!voiceTargetId) return;
    sendScopedVoiceState("room", voiceTargetId, state);
  }

  function setAlwaysOn(enabled: boolean) {
    if (enableDirectPpt) {
      if (voiceModeRef.current !== "ptt") {
        setVoiceMode("ptt");
        voiceModeRef.current = "ptt";
      }
      if (pttPressed) {
        setPttPressed(false);
      }
      sendVoiceState("ptt_stop");
      return;
    }

    if (enabled) {
      setVoiceMode("always_on");
      voiceModeRef.current = "always_on";
      sendVoiceState("always_on");
    } else {
      setVoiceMode("ptt");
      voiceModeRef.current = "ptt";
      sendVoiceState("ptt_stop");
    }
  }

  function handleEnableDirectPptChange(enabled: boolean) {
    setEnableDirectPpt(enabled);
    if (enabled) {
      setAlwaysOn(false);
    }
  }

  function startPtt() {
    setPttPressed(true);
    sendVoiceState("ptt_start");
  }

  function stopPtt() {
    setPttPressed(false);
    sendVoiceState("ptt_stop");
  }

  function sendBroadcastVoiceState(groupId: string, state: string) {
    sendScopedVoiceState("broadcast", groupId, state);
  }

  function startBroadcastPtt(groupId: string) {
    setBroadcastPttPressed(groupId);
    sendBroadcastVoiceState(groupId, "ptt_start");
  }

  function stopBroadcastPtt(groupId: string) {
    setBroadcastPttPressed((current) => (current === groupId ? null : current));
    sendBroadcastVoiceState(groupId, "ptt_stop");
  }

  function sendDirectVoiceState(userId: string, state: string) {
    sendScopedVoiceState("direct", userId, state);
  }

  function startDirectPtt(userId: string) {
    setdirectPttPressedUserId(userId);
    sendDirectVoiceState(userId, "ptt_start");
  }

  function stopDirectPtt(userId: string) {
    setdirectPttPressedUserId((current) =>
      current === userId ? null : current,
    );
    sendDirectVoiceState(userId, "ptt_stop");
  }

  function handleChannelPttStart(channelId: string) {
    if (!appData || !channelId) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // Select the channel and start PTT with that channel directly
    setSelectedChannelId(channelId);
    setTalkRoomIds([channelId]);
    setPttPressed(true);
    setPttPressedChannelId(channelId);
    prevChannelRef.current = channelId;
    // First: Notify backend of the room matrix change (keep listen rooms unchanged)
    wsRef.current.send(
      JSON.stringify({
        type: "set_room_matrix",
        data: {
          listenRoomIDs: listenRoomIdsRef.current,
          talkRoomIDs: [channelId],
          activeRoomID: channelId,
        },
      }),
    );
    sendScopedVoiceState("room", channelId, "ptt_start");
  }

  function handleChannelPttStop(channelId: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (prevChannelRef.current === channelId) {
      setPttPressed(false);
      setPttPressedChannelId(null);
      // Send voice state with the channel that was being pressed
      sendScopedVoiceState("room", channelId, "ptt_stop");
      prevChannelRef.current = "";
    }
  }

  if (!publicData) return <div className="root">Loading configuration…</div>;
  if (!token) {
    return (
      <LoginView
        publicData={publicData}
        username={username}
        roleId={roleId}
        onUsernameChange={setUsername}
        onRoleChange={(nextRoleId) => {
          setRoleID(nextRoleId);
          const selectedRole = publicData.roles.find(
            (role) => role.id === nextRoleId,
          );
          if (selectedRole?.defaultRoomId) {
            setListenRoomIds([selectedRole.defaultRoomId]);
            setTalkRoomIds([selectedRole.defaultRoomId]);
          }
          if (selectedRole?.defaultVoiceMode) {
            const nextMode = selectedRole.defaultVoiceMode as
              | "always_on"
              | "ptt";
            setVoiceMode(nextMode);
            voiceModeRef.current = nextMode;
          }
        }}
        onLogin={() => {
          void handleOperatorLogin();
        }}
        adminPin={adminPinInput}
        onAdminPinChange={setAdminPinInput}
        onAdminLogin={() => {
          void handleAdminLogin();
        }}
        adminError={adminLoginError}
      />
    );
  }

  if (!appData) {
    return <div className="root">Loading data…</div>;
  }

  // audioPanel is now integrated into the User Settings modal in StationIntercomView
  // const audioPanel = (
  //   <AudioPanel
  //     inputDevices={inputDevices}
  //     selectedInputDeviceId={selectedInputDeviceId}
  //     selectedMicLabel={selectedMicLabel}
  //     isMicMenuOpen={isMicMenuOpen}
  //     setIsMicMenuOpen={setIsMicMenuOpen}
  //     setSelectedInputDeviceId={setSelectedInputDeviceId}
  //     inputLevel={inputLevel}
  //     outputDevices={outputDevices}
  //     selectedOutputDeviceId={selectedOutputDeviceId}
  //     selectedOutputLabel={selectedOutputLabel}
  //     isOutputMenuOpen={isOutputMenuOpen}
  //     setIsOutputMenuOpen={setIsOutputMenuOpen}
  //     setSelectedOutputDeviceId={(nextOutputDeviceId) => {
  //       void changeOutputDevice(nextOutputDeviceId);
  //     }}
  //     outputSelectionSupported={outputSelectionSupported}
  //     micMenuRef={micMenuRef}
  //     outputMenuRef={outputMenuRef}
  //   />
  // );

  const chatAndSignalBlock = (
    <ChatSignalPanel
      message={message}
      onMessageChange={setMessage}
      onSendChat={sendChat}
      chatMessages={chatMessages}
    />
  );

  const realtimeDebugBlock = <RealtimeEventsPanel events={events} />;
  const receivingRoutes = incomingAudioActive ? activeVoiceRoutes : [];
  const hasExplicitReceivingRoutes = receivingRoutes.length > 0;
  const alwaysOnFallbackRoomIds = new Set(
    !incomingAudioActive || hasExplicitReceivingRoutes
      ? []
      : presence
          .filter(
            (p) =>
              p.userId !== appData.self.id &&
              p.voiceMode === "always_on" &&
              p.micEnabled &&
              Array.isArray(p.talkRooms) &&
              p.talkRooms.length > 0,
          )
          .flatMap((p) =>
            p.talkRooms.filter((roomId) => listenRoomIds.includes(roomId)),
          ),
  );

  if (authMode === "admin" && token) {
    const displayUsername = adminOverrideActive
      ? "admin"
      : appData.self.username;
    const adminRoleLabel = adminOverrideActive
      ? "Admin"
      : roleNameById.get(appData.self.roleId) || appData.self.roleId || "Admin";
    return (
      <div className="root admin-shell">
        <div className="admin-shell-header">
          <div>
            <h1>Admin console</h1>
            <p className="admin-shell-user">
              Signed in as {displayUsername} ({adminRoleLabel})
            </p>
          </div>
          <div className="admin-shell-actions">
            <button onClick={() => void refreshBootstrapData()}>Refresh</button>
            <button
              className="station-top-logout"
              onClick={() => void doLogout()}
            >
              Logout / Lock
            </button>
          </div>
        </div>

        <AdminMenu
          isOpen={isAdminPanelOpen}
          setIsOpen={setIsAdminPanelOpen}
          token={token}
          appData={appData}
          refreshBootstrapData={refreshBootstrapData}
          adminPin={adminPinGuard}
          onUpdateAdminPin={(next) => setAdminPinGuard(next)}
          audioStats={rtpStats}
          activeRoutesCount={activeVoiceRoutes.length}
        />
      </div>
    );
  }

  function isReceivingRoom(roomId: string) {
    if (!incomingAudioActive) return false;
    if (
      receivingRoutes.some(
        (route) => route.scope === "room" && route.targetID === roomId,
      )
    )
      return true;
    return alwaysOnFallbackRoomIds.has(roomId);
  }

  function isReceivingBroadcast(groupId: string) {
    if (!incomingAudioActive) return false;
    return receivingRoutes.some(
      (route) => route.scope === "broadcast" && route.targetID === groupId,
    );
  }

  function isReceivingDirect(userId: string) {
    if (!incomingAudioActive) return false;
    return receivingRoutes.some(
      (route) => route.scope === "direct" && route.senderUserID === userId,
    );
  }

  const directOnlineTargets = presence
    .filter((p) => p.userId !== appData.self.id)
    .slice()
    .sort((a, b) => {
      const roleA = (
        roleNameById.get(a.roleId) ||
        a.roleId ||
        ""
      ).toLowerCase();
      const roleB = (
        roleNameById.get(b.roleId) ||
        b.roleId ||
        ""
      ).toLowerCase();
      const byRole = roleA.localeCompare(roleB, undefined, {
        sensitivity: "base",
      });
      if (byRole !== 0) return byRole;
      return a.username.localeCompare(b.username, undefined, {
        sensitivity: "base",
      });
    });
  const replyTarget =
    directOnlineTargets.find((p) => p.userId === lastDirectCallerUserId) ||
    null;
  const simpleVoiceTargetId = matrixAnchorRoomId(listenRoomIds, talkRoomIds);
  const simplePttTargetLabel =
    appData.rooms.find((room) => room.id === simpleVoiceTargetId)?.name ||
    "No room selected";
  const attentionFlashOverlay = incomingAttention ? (
    <div
      key={attentionFlashKey}
      className="attention-flash attention-flash-call"
      role="status"
      aria-live="assertive"
    >
      <div className="attention-flash-card">
        <strong>{incomingAttention.title}</strong>
        <span>{incomingAttention.detail}</span>
      </div>
    </div>
  ) : null;

  if (viewMode === "simple") {
    return (
      <>
        <SimpleIntercomView
          pttPressed={pttPressed}
          onStartPpt={startPtt}
          onStopPpt={stopPtt}
          replyTarget={
            replyTarget
              ? { userId: replyTarget.userId, username: replyTarget.username }
              : null
          }
          selectedInputDeviceId={selectedInputDeviceId}
          onSelectedInputDeviceIdChange={setSelectedInputDeviceId}
          inputDevices={inputDevices}
          selectedOutputDeviceId={selectedOutputDeviceId}
          onSelectedOutputDeviceIdChange={(nextOutputDeviceId) => {
            void changeOutputDevice(nextOutputDeviceId);
          }}
          outputDevices={outputDevices}
          outputSelectionSupported={outputSelectionSupported}
          simplePptTargetLabel={simplePttTargetLabel}
          doLogout={() => {
            void doLogout();
          }}
        />
        {attentionFlashOverlay}
      </>
    );
  }

  return (
    <>
      <StationIntercomView
        appData={appData}
        doLogout={() => {
          void doLogout();
        }}
        listenRoomIds={listenRoomIds}
        talkRoomIds={talkRoomIds}
        canRoleSendToRoom={canRoleSendToRoom}
        canRoleReceiveFromRoom={canRoleReceiveFromRoom}
        toggleTalkRoom={toggleTalkRoom}
        toggleListenRoom={toggleListenRoom}
        isReceivingRoom={isReceivingRoom}
        isReceivingBroadcast={isReceivingBroadcast}
        isReceivingDirect={isReceivingDirect}
        broadcastPttPressed={broadcastPttPressed}
        startBroadcastPtt={startBroadcastPtt}
        stopBroadcastPtt={stopBroadcastPtt}
        broadcastGroups={appData.broadcastGroups}
        presence={presence}
        roleNameById={roleNameById}
        lastDirectCallerUserId={lastDirectCallerUserId}
        directPttPressedUserId={directPttPressedUserId}
        startDirectPtt={startDirectPtt}
        stopDirectPtt={stopDirectPtt}
        sendScopedSignal={sendScopedSignal}
        pttPressed={pttPressed}
        startPtt={startPtt}
        stopPtt={stopPtt}
        voiceMode={voiceMode}
        setAlwaysOn={setAlwaysOn}
        chatAndSignalPanel={chatAndSignalBlock}
        showDebug={showDebug}
        inputDevices={inputDevices}
        selectedInputDeviceId={selectedInputDeviceId}
        selectedMicLabel={selectedMicLabel}
        setSelectedInputDeviceId={setSelectedInputDeviceId}
        inputLevelDbFs={inputLevelDbFs}
        inputGain={selectedInputGain}
        inputClipping={displayedInputClipping}
        onInputGainChange={onInputGainChange}
        outputDevices={outputDevices}
        selectedOutputDeviceId={selectedOutputDeviceId}
        selectedOutputLabel={selectedOutputLabel}
        outputSelectionSupported={outputSelectionSupported}
        setSelectedOutputDeviceId={(nextOutputDeviceId) => {
          void changeOutputDevice(nextOutputDeviceId);
        }}
        realtimeDebugBlock={realtimeDebugBlock}
        enableDirectPpt={enableDirectPpt}
        onEnableDirectPptChange={handleEnableDirectPptChange}
        enableDirectTabs={enableDirectTabs}
        onEnableDirectTabsChange={setEnableDirectTabs}
        availableChannels={availableChannels}
        selectedChannelId={selectedChannelId}
        onSelectChannel={setSelectedChannelId}
        onChannelPptStart={handleChannelPttStart}
        onChannelPptStop={handleChannelPttStop}
        pptPressedChannelId={pttPressedChannelId}
        pinnedRoomIds={pinnedRoomIds}
        pinnedUserIds={pinnedUserIds}
        showPinnedOnly={showPinnedOnly}
        onTogglePinnedRoom={togglePinnedRoom}
        onTogglePinnedUser={togglePinnedUser}
        onShowPinnedOnlyChange={setShowPinnedOnly}
        isUserSettingsOpen={isUserSettingsOpen}
        setIsUserSettingsOpen={setIsUserSettingsOpen}
        roomGainById={roomGainById}
        directGainByUserId={directGainByUserId}
        onRoomGainChange={onRoomGainChange}
        onDirectGainChange={onDirectGainChange}
      />
      {attentionFlashOverlay}
    </>
  );
}
