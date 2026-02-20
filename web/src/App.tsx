import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bootstrap,
  createBroadcastGroup,
  createRole,
  createRoom,
  deleteBroadcastGroup,
  deleteRole,
  deleteRoom,
  getPublicBootstrap,
  login,
  logout,
  updateBroadcastGroup,
  updateRole,
  updateRoom
} from "./api";
import type { Bootstrap, Presence, PublicBootstrap, RoutedEvent } from "./types";

type WsMessage =
  | { type: "presence"; data: Presence[] }
  | { type: "chat"; data: RoutedEvent }
  | { type: "signal"; data: RoutedEvent }
  | { type: "voice_state"; data: RoutedEvent }
  | { type: "webrtc_offer"; data: { sdp: string } }
  | { type: "webrtc_ice_candidate"; data: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } };

const storageKey = "intercom-token";

export function App() {
  const [publicData, setPublicData] = useState<PublicBootstrap | null>(null);
  const [appData, setAppData] = useState<Bootstrap | null>(null);
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(storageKey));
  const [username, setUsername] = useState("");
  const [roleId, setRoleID] = useState("");
  const [listenRoomIds, setListenRoomIds] = useState<string[]>([]);
  const [talkRoomIds, setTalkRoomIds] = useState<string[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [scope, setScope] = useState<"direct" | "room" | "broadcast">("room");
  const [targetId, setTargetId] = useState("");
  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<Array<{ label: string; at: string }>>([]);
  const [voiceMode, setVoiceMode] = useState<"always_on" | "ptt">("always_on");
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "reconnecting" | "offline">("offline");
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [audioError, setAudioError] = useState<string>("");
  const [webrtcState, setWebrtcState] = useState<string>("new");
  const [rtpStats, setRtpStats] = useState<{ inKbps: number; outKbps: number }>({ inKbps: 0, outKbps: 0 });
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [roleCreateId, setRoleCreateId] = useState("");
  const [roleCreateName, setRoleCreateName] = useState("");
  const [roleCreateDefaultRoomId, setRoleCreateDefaultRoomId] = useState("");
  const [roleCreateDefaultVoiceMode, setRoleCreateDefaultVoiceMode] = useState<"always_on" | "ptt" | "">("");
  const [roleEditId, setRoleEditId] = useState<string | null>(null);
  const [roleEditName, setRoleEditName] = useState("");
  const [roleEditDefaultRoomId, setRoleEditDefaultRoomId] = useState("");
  const [roleEditDefaultVoiceMode, setRoleEditDefaultVoiceMode] = useState<"always_on" | "ptt" | "">("");
  const [roomCreateId, setRoomCreateId] = useState("");
  const [roomCreateName, setRoomCreateName] = useState("");
  const [roomEditId, setRoomEditId] = useState<string | null>(null);
  const [roomEditName, setRoomEditName] = useState("");
  const [groupCreateId, setGroupCreateId] = useState("");
  const [groupCreateName, setGroupCreateName] = useState("");
  const [groupCreateRoomIds, setGroupCreateRoomIds] = useState<string[]>([]);
  const [groupEditId, setGroupEditId] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditRoomIds, setGroupEditRoomIds] = useState<string[]>([]);
  const [pttPressed, setPttPressed] = useState(false);
  const [broadcastPttPressed, setBroadcastPttPressed] = useState<string | null>(null);
  const [directPttPressedUserId, setDirectPttPressedUserId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const pendingICERef = useRef<Array<{ candidate: string; sdpMid?: string; sdpMLineIndex?: number }>>([]);
  const roomSwitchTimerRef = useRef<number | null>(null);
  const voiceModeRef = useRef(voiceMode);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const statsIntervalRef = useRef<number | null>(null);
  const lastStatsRef = useRef<{ ts: number; inBytes: number; outBytes: number } | null>(null);
  const selectedInputDeviceIdRef = useRef("");
  const listenRoomIdsRef = useRef<string[]>(listenRoomIds);
  const talkRoomIdsRef = useRef<string[]>(talkRoomIds);
  const micMenuRef = useRef<HTMLDivElement | null>(null);
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
    listenRoomIdsRef.current = listenRoomIds;
  }, [listenRoomIds]);
  useEffect(() => {
    talkRoomIdsRef.current = talkRoomIds;
  }, [talkRoomIds]);

  useEffect(() => {
    localStorage.removeItem(storageKey);
    getPublicBootstrap().then(setPublicData).catch(console.error);
  }, []);

  useEffect(() => {
    if (!token) return;
    bootstrap(token)
      .then((data) => {
        setAppData(data);
        setRoleID(data.self.roleId);
        const roleDefaults = data.roles.find((role) => role.id === data.self.roleId);
        let initialRoom = "";
        if (roleDefaults?.defaultRoomId) {
          initialRoom = roleDefaults.defaultRoomId;
        } else if (data.rooms[0]) {
          initialRoom = data.rooms[0].id;
        }
        if (initialRoom) {
          setListenRoomIds([initialRoom]);
          setTalkRoomIds([initialRoom]);
        }
        if (roleDefaults?.defaultVoiceMode) {
          const nextMode = roleDefaults.defaultVoiceMode as "always_on" | "ptt";
          setVoiceMode(nextMode);
          voiceModeRef.current = nextMode;
        }
      })
      .catch(() => {
        sessionStorage.removeItem(storageKey);
        localStorage.removeItem(storageKey);
        setToken(null);
      });
  }, [token]);

  useEffect(() => {
    if (!appData) return;
    if (roleCreateDefaultRoomId === "" && appData.rooms[0]) {
      setRoleCreateDefaultRoomId(appData.rooms[0].id);
    }
  }, [appData, roleCreateDefaultRoomId]);

  const refreshInputDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    setInputDevices(inputs);
    setSelectedInputDeviceId((prev) => {
      if (prev && inputs.some((d) => d.deviceId === prev)) return prev;
      return inputs[0]?.deviceId || "";
    });
  }, []);

  useEffect(() => {
    void refreshInputDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshInputDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshInputDevices);
  }, [refreshInputDevices]);
  useEffect(() => {
    if (!(window.isSecureContext || window.location.hostname === "localhost")) {
      setAudioError("Microphone capture needs HTTPS (or localhost). Open the app via HTTPS for remote devices.");
    }
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!micMenuRef.current) return;
      if (event.target instanceof Node && !micMenuRef.current.contains(event.target)) {
        setIsMicMenuOpen(false);
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

  function matrixAnchorRoomId(listenIds: string[], talkIds: string[]) {
    return talkIds[0] || listenIds[0] || "";
  }

  function toggleRoomSelection(
    roomId: string,
    setState: (value: string[] | ((prev: string[]) => string[])) => void
  ) {
    setState((prev) => {
      if (prev.includes(roomId)) {
        if (prev.length === 1) return prev;
        return prev.filter((id) => id !== roomId);
      }
      return [...prev, roomId];
    });
  }

  function toggleListenRoom(roomId: string) {
    toggleRoomSelection(roomId, setListenRoomIds);
  }

  function toggleTalkRoom(roomId: string) {
    setTalkRoomIds((prev) => {
      if (prev[0] === roomId && prev.length === 1) return prev;
      return [roomId];
    });
  }

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
          if (s.type === "inbound-rtp" && (s as RTCInboundRtpStreamStats).kind === "audio") {
            inBytes += (s as RTCInboundRtpStreamStats).bytesReceived || 0;
          }
          if (s.type === "outbound-rtp" && (s as RTCOutboundRtpStreamStats).kind === "audio") {
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
        setRtpStats({ inKbps: Math.max(0, Math.round(inKbps)), outKbps: Math.max(0, Math.round(outKbps)) });
      })().catch(() => undefined);
    }, 1000);
  }

  function stopLevelMeter() {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    analyserRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setInputLevel(0);
  }

  function startLevelMeter(stream: MediaStream) {
    stopLevelMeter();
    const AudioCtx = window.AudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyserRef.current = analyser;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const centered = (v - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / buf.length);
      setInputLevel(Math.min(100, Math.round(rms * 220)));
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

  async function getMicStream(deviceId: string): Promise<MediaStream> {
    const baseAudio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    if (!deviceId) {
      return navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...baseAudio, deviceId: { exact: deviceId } },
        video: false
      });
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
    }
  }

  function cleanupRealtimeResources() {
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
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    pendingICERef.current = [];
    stopStatsLoop();
    stopLevelMeter();
  }

  useEffect(() => {
    if (!token || !appData) return;
    shouldReconnectRef.current = true;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      setConnectionState(reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting");
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = async () => {
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");
        setAudioError("");
        pendingICERef.current = [];
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcRef.current = pc;
        pc.onconnectionstatechange = () => setWebrtcState(pc.connectionState);
        pc.oniceconnectionstatechange = () => setWebrtcState(`ice:${pc.iceConnectionState}`);
        startStatsLoop(pc);
        pc.onicecandidate = (event) => {
          if (!event.candidate || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          wsRef.current.send(
            JSON.stringify({
              type: "webrtc_ice_candidate",
              data: {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid || undefined,
                sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined
              }
            })
          );
        };
        pc.ontrack = (event) => {
          const key = `${event.track.id}-${event.streams[0]?.id || "nostream"}`;
          let audio = remoteAudioRef.current.get(key);
          if (!audio) {
            audio = document.createElement("audio");
            audio.autoplay = true;
            audio.muted = false;
            audio.volume = 1;
            remoteAudioRef.current.set(key, audio);
          }
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          audio.srcObject = stream;
          void audio.play().catch((err) => {
            setAudioError(`Remote audio playback blocked: ${err instanceof Error ? err.message : "unknown error"}`);
          });
          setEvents((old) => [{ label: "system · webrtc · remote audio track attached", at: new Date().toLocaleTimeString() }, ...old].slice(0, 200));
        };
        try {
          const stream = await getMicStream(selectedInputDeviceIdRef.current);
          localStreamRef.current = stream;
          startLevelMeter(stream);
          void refreshInputDevices();
          const initialEnabled = voiceModeRef.current === "always_on";
          for (const track of stream.getAudioTracks()) {
            track.enabled = initialEnabled;
            pc.addTrack(track, stream);
          }
          applyVoiceModeToLocalTracks(voiceModeRef.current);
        } catch (e) {
          setAudioError(`Failed to access microphone: ${e instanceof Error ? e.message : "unknown error"}`);
          setEvents((old) => [{ label: "system · local/mic · capture failed (receive-only)", at: new Date().toLocaleTimeString() }, ...old].slice(0, 200));
        }
        ws.send(JSON.stringify({ type: "webrtc_ready", data: {} }));
        ws.send(
          JSON.stringify({
            type: "set_room_matrix",
            data: {
              activeRoomId: matrixAnchorRoomId(listenRoomIdsRef.current, talkRoomIdsRef.current),
              listenRoomIds: listenRoomIdsRef.current,
              talkRoomIds: talkRoomIdsRef.current
            }
          })
        );
        const initialVoiceMode = voiceModeRef.current;
        const voiceState = initialVoiceMode === "always_on" ? "always_on" : "ptt_stop";
        ws.send(
          JSON.stringify({
            type: "voice_state",
            data: {
              scope: "room",
              targetId: matrixAnchorRoomId(listenRoomIdsRef.current, talkRoomIdsRef.current),
              body: voiceState
            }
          })
        );
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === "presence") {
          setPresence(msg.data);
          return;
        }
        if (msg.type === "webrtc_offer") {
          const pc = pcRef.current;
          if (!pc || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
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
            wsRef.current?.send(JSON.stringify({ type: "webrtc_answer", data: { sdp: answer.sdp || "" } }));
            setEvents((old) => [{ label: "system · webrtc · answered offer", at: new Date().toLocaleTimeString() }, ...old].slice(0, 200));
          })().catch((err) => {
            setAudioError(`WebRTC renegotiation failed: ${err instanceof Error ? err.message : "unknown error"}`);
          });
          return;
        }
        if (msg.type === "webrtc_ice_candidate") {
          const pc = pcRef.current;
          if (!pc) return;
          const candidate = {
            candidate: msg.data.candidate,
            sdpMid: msg.data.sdpMid,
            sdpMLineIndex: msg.data.sdpMLineIndex
          };
          if (!pc.remoteDescription) {
            pendingICERef.current.push(candidate);
          } else {
            void pc.addIceCandidate(candidate).catch(console.error);
          }
          return;
        }
        const body = (msg.data.signal || msg.data.body || "").toString();
        setEvents((old) =>
          [
            {
              label: `${msg.type} · ${msg.data.fromUser.username} · ${msg.data.scope}/${msg.data.targetId} · ${body}`,
              at: new Date(msg.data.timestamp).toLocaleTimeString()
            },
            ...old
          ].slice(0, 200)
        );
      };

      ws.onclose = () => {
        clearRoomSwitchTimer();
        cleanupRealtimeResources();
        if (!shouldReconnectRef.current || cancelled) {
          setConnectionState("offline");
          return;
        }
        setConnectionState("reconnecting");
        reconnectAttemptsRef.current += 1;
        const backoff = Math.min(8000, 500 * 2 ** Math.min(reconnectAttemptsRef.current, 5));
        reconnectTimeoutRef.current = window.setTimeout(() => {
          void connect();
        }, backoff);
      };
      ws.onerror = () => ws.close();
    };

    void connect();
    return () => {
      cancelled = true;
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      cleanupRealtimeResources();
      setConnectionState("offline");
    };
  }, [token, appData]);

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
            talkRoomIds
          }
        })
      );
      setEvents((old) =>
        [{ label: `system · matrix updated · ${activeRoomId || "no-room"}`, at: new Date().toLocaleTimeString() }, ...old].slice(0, 200)
      );
    }, 120);
    return () => clearRoomSwitchTimer();
  }, [listenRoomIds, talkRoomIds]);

  useEffect(() => {
    if (!token || !appData || !pcRef.current || !selectedInputDeviceId) return;
    void (async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const newStream = await getMicStream(selectedInputDeviceId);
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          pc.addTrack(newTrack, newStream);
        }
        if (localStreamRef.current) {
          for (const t of localStreamRef.current.getTracks()) t.stop();
        }
        localStreamRef.current = newStream;
        startLevelMeter(newStream);
        applyVoiceModeToLocalTracks(voiceModeRef.current);
        setAudioError("");
      } catch (e) {
        setAudioError(`Failed to switch microphone: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    })();
  }, [selectedInputDeviceId, token, appData]);

  const currentTargets = useMemo(() => {
    if (!appData) return [];
    if (scope === "direct") return appData.users.map((u) => ({ id: u.id, label: `${u.username} (${u.roleId})` }));
    if (scope === "room") return appData.rooms.map((r) => ({ id: r.id, label: r.name }));
    return appData.broadcastGroups.map((b) => ({ id: b.id, label: b.name }));
  }, [scope, appData]);

  const selectedMicLabel = useMemo(() => {
    return inputDevices.find((d) => d.deviceId === selectedInputDeviceId)?.label || "Select microphone";
  }, [inputDevices, selectedInputDeviceId]);
  const isAdmin = appData?.self.roleId === "producer";
  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of appData?.roles || []) map.set(role.id, role.name);
    return map;
  }, [appData]);

  useEffect(() => {
    if (currentTargets[0]) setTargetId(currentTargets[0].id);
  }, [scope, appData]);

  async function doLogin() {
    const res = await login(username.trim(), roleId);
    sessionStorage.setItem(storageKey, res.token);
    localStorage.removeItem(storageKey);
    setToken(res.token);
  }

  async function doLogout() {
    if (token) {
      await logout(token);
      sessionStorage.removeItem(storageKey);
      localStorage.removeItem(storageKey);
      setToken(null);
      setAppData(null);
      setPresence([]);
      clearReconnectTimer();
      cleanupRealtimeResources();
      setConnectionState("offline");
    }
  }

  async function refreshBootstrapData() {
    if (!token) return;
    const data = await bootstrap(token);
    setAppData(data);
    setPublicData({
      roles: data.roles,
      rooms: data.rooms,
      broadcastGroups: data.broadcastGroups
    });
    setListenRoomIds((prev) => {
      const next = prev.filter((roomId) => data.rooms.some((room) => room.id === roomId));
      if (next.length > 0) return next;
      return data.rooms[0] ? [data.rooms[0].id] : [];
    });
    setTalkRoomIds((prev) => {
      const next = prev.filter((roomId) => data.rooms.some((room) => room.id === roomId));
      if (next.length > 0) return next;
      return data.rooms[0] ? [data.rooms[0].id] : [];
    });
  }

  async function runAdminAction(action: () => Promise<void>) {
    setAdminBusy(true);
    setAdminError("");
    try {
      await action();
      await refreshBootstrapData();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "admin operation failed");
    } finally {
      setAdminBusy(false);
    }
  }

  function resetGroupCreateForm() {
    setGroupCreateId("");
    setGroupCreateName("");
    setGroupCreateRoomIds([]);
  }

  function resetRoleEditForm() {
    setRoleEditId(null);
    setRoleEditName("");
    setRoleEditDefaultRoomId("");
    setRoleEditDefaultVoiceMode("");
  }

  function resetRoomEditForm() {
    setRoomEditId(null);
    setRoomEditName("");
  }

  function resetGroupEditForm() {
    setGroupEditId(null);
    setGroupEditName("");
    setGroupEditRoomIds([]);
  }

  function createRoleConfig() {
    if (!token) return;
    const id = roleCreateId.trim();
    const name = roleCreateName.trim();
    if (!id || !name) return;
    void runAdminAction(async () => {
      await createRole(token, {
        id,
        name,
        defaultRoomId: roleCreateDefaultRoomId.trim() || undefined,
        defaultVoiceMode: roleCreateDefaultVoiceMode || undefined
      });
      setRoleCreateId("");
      setRoleCreateName("");
      setRoleCreateDefaultVoiceMode("");
    });
  }

  function saveRoleEdit() {
    if (!token || !roleEditId) return;
    const name = roleEditName.trim();
    if (!name) return;
    void runAdminAction(async () => {
      await updateRole(token, roleEditId, {
        name,
        defaultRoomId: roleEditDefaultRoomId.trim() || undefined,
        defaultVoiceMode: roleEditDefaultVoiceMode || undefined
      });
      resetRoleEditForm();
    });
  }

  function removeRoleConfig(id: string) {
    if (!token) return;
    void runAdminAction(() => deleteRole(token, id));
  }

  function createRoomConfig() {
    if (!token) return;
    const id = roomCreateId.trim();
    const name = roomCreateName.trim();
    if (!id || !name) return;
    void runAdminAction(async () => {
      await createRoom(token, { id, name });
      setRoomCreateId("");
      setRoomCreateName("");
    });
  }

  function saveRoomEdit() {
    if (!token || !roomEditId) return;
    const name = roomEditName.trim();
    if (!name) return;
    void runAdminAction(async () => {
      await updateRoom(token, roomEditId, { name });
      resetRoomEditForm();
    });
  }

  function removeRoomConfig(id: string) {
    if (!token) return;
    void runAdminAction(() => deleteRoom(token, id));
  }

  function createBroadcastGroupConfig() {
    if (!token) return;
    const id = groupCreateId.trim();
    const name = groupCreateName.trim();
    if (!id || !name || groupCreateRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await createBroadcastGroup(token, { id, name, roomIds: groupCreateRoomIds });
      resetGroupCreateForm();
    });
  }

  function saveGroupEdit() {
    if (!token || !groupEditId) return;
    const name = groupEditName.trim();
    if (!name || groupEditRoomIds.length === 0) return;
    void runAdminAction(async () => {
      await updateBroadcastGroup(token, groupEditId, { name, roomIds: groupEditRoomIds });
      resetGroupEditForm();
    });
  }

  function removeBroadcastGroupConfig(id: string) {
    if (!token) return;
    void runAdminAction(async () => {
      await deleteBroadcastGroup(token, id);
      if (groupEditId === id) {
        resetGroupEditForm();
      }
    });
  }

  function sendChat() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !targetId || !message.trim()) return;
    wsRef.current.send(JSON.stringify({ type: "chat", data: { scope, targetId, body: message.trim() } }));
    setMessage("");
  }

  function sendSignal(signal: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !targetId) return;
    wsRef.current.send(JSON.stringify({ type: "signal", data: { scope, targetId, signal } }));
  }

  function sendVoiceState(state: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const stream = localStreamRef.current;
    if (stream) {
      const enable = state === "ptt_start" || state === "always_on";
      const disable = state === "ptt_stop";
      if (enable || disable) {
        for (const track of stream.getAudioTracks()) track.enabled = enable;
      }
    }
    if (state === "always_on") setVoiceMode("always_on");
    if (state === "ptt_start" || state === "ptt_stop") setVoiceMode("ptt");
    const voiceTargetId = targetId || matrixAnchorRoomId(listenRoomIdsRef.current, talkRoomIdsRef.current);
    if (!voiceTargetId) return;
    const voiceScope = targetId ? scope : "room";
    wsRef.current.send(JSON.stringify({ type: "voice_state", data: { scope: voiceScope, targetId: voiceTargetId, body: state } }));
  }

  function setAlwaysOn(enabled: boolean) {
    if (enabled) {
      sendVoiceState("always_on");
    } else {
      sendVoiceState("ptt_stop");
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
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const stream = localStreamRef.current;
    if (stream) {
      const enable = state === "ptt_start" || state === "always_on";
      const disable = state === "ptt_stop";
      if (enable || disable) {
        for (const track of stream.getAudioTracks()) track.enabled = enable;
      }
    }
    if (state === "always_on") setVoiceMode("always_on");
    if (state === "ptt_start" || state === "ptt_stop") setVoiceMode("ptt");
    wsRef.current.send(JSON.stringify({ type: "voice_state", data: { scope: "broadcast", targetId: groupId, body: state } }));
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
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const stream = localStreamRef.current;
    if (stream) {
      const enable = state === "ptt_start" || state === "always_on";
      const disable = state === "ptt_stop";
      if (enable || disable) {
        for (const track of stream.getAudioTracks()) track.enabled = enable;
      }
    }
    if (state === "always_on") setVoiceMode("always_on");
    if (state === "ptt_start" || state === "ptt_stop") setVoiceMode("ptt");
    wsRef.current.send(JSON.stringify({ type: "voice_state", data: { scope: "direct", targetId: userId, body: state } }));
  }

  function startDirectPtt(userId: string) {
    setDirectPttPressedUserId(userId);
    sendDirectVoiceState(userId, "ptt_start");
  }

  function stopDirectPtt(userId: string) {
    setDirectPttPressedUserId((current) => (current === userId ? null : current));
    sendDirectVoiceState(userId, "ptt_stop");
  }

  if (!publicData) return <div className="root">Loading configuration…</div>;
  if (!token || !appData) {
    return (
      <div className="root login">
        <h1>Live Production Intercom</h1>
        <label>
          Display name
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Tim FOH" />
        </label>
        <label>
          Role
          <select
            value={roleId}
            onChange={(e) => {
              const nextRoleId = e.target.value;
              setRoleID(nextRoleId);
              const selectedRole = publicData.roles.find((role) => role.id === nextRoleId);
              if (selectedRole?.defaultRoomId) {
                setListenRoomIds([selectedRole.defaultRoomId]);
                setTalkRoomIds([selectedRole.defaultRoomId]);
              }
              if (selectedRole?.defaultVoiceMode) {
                const nextMode = selectedRole.defaultVoiceMode as "always_on" | "ptt";
                setVoiceMode(nextMode);
                voiceModeRef.current = nextMode;
              }
            }}
          >
            <option value="">Select role</option>
            {publicData.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={doLogin} disabled={!username.trim() || !roleId}>
          Join Intercom
        </button>
      </div>
    );
  }

  return (
    <div className="root app">
      <header>
        <div>
          <h1>Live Production Intercom</h1>
          <p>
            Signed in as <strong>{appData.self.username}</strong> ({appData.self.roleId}) · connection:{" "}
            <strong>{connectionState}</strong>
          </p>
          {showDebug ? (
            <>
              <p style={{ margin: "0.2rem 0 0 0" }}>
                webrtc: <strong>{webrtcState}</strong>
              </p>
              <p style={{ margin: "0.2rem 0 0 0" }}>
                audio rtp: <strong>in {rtpStats.inKbps} kbps</strong> / <strong>out {rtpStats.outKbps} kbps</strong>
              </p>
            </>
          ) : null}
          {audioError ? <p style={{ color: "#ffb4b4", margin: "0.35rem 0 0 0" }}>{audioError}</p> : null}
        </div>
        <button onClick={doLogout}>Logout</button>
      </header>
      <main>
        <aside>
          <h3>Room matrix</h3>
          <div className="room-matrix">
            {appData.rooms.map((room) => {
              const listening = listenRoomIds.includes(room.id);
              const talking = talkRoomIds.includes(room.id);
              return (
                <div key={`matrix-${room.id}`} className="matrix-card">
                  <div className="matrix-room-name">{room.name}</div>
                  <div className="matrix-actions">
                    <button
                      className={`matrix-action listen ${listening ? "on" : ""}`}
                      onClick={() => toggleListenRoom(room.id)}
                      title="Toggle listening for this room"
                    >
                      Listen
                    </button>
                    <button
                      className={`matrix-action talk ${talking ? "on" : ""}`}
                      onClick={() => toggleTalkRoom(room.id)}
                      title="Toggle talking to this room"
                    >
                      Talk
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <small>
            Listen: {listenRoomIds.length} · Talk: {talkRoomIds.length}
          </small>
          <h3>Microphone</h3>
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
          <small>Input level</small>
          <h3>Online</h3>
          <div className="online-rooms">
            {appData.roles.map((role) => {
              const users = presence.filter((p) => p.roleId === role.id);
              if (users.length === 0) return null;
              return (
                <div key={`online-role-${role.id}`} className="online-room">
                  <div className="online-room-title">{role.name}</div>
                  <ul>
                    {users.map((p) => (
                      <li key={`${p.userId}-${role.id}`}>
                        <div className="online-user-row">
                          <span>
                            {p.username} — {p.micEnabled ? "mic on" : "mic off"}
                            {p.broadcastActive ? <span className="online-broadcast">broadcasting</span> : null}
                          </span>
                          {p.userId !== appData.self.id ? (
                            <button
                              className={`direct-ptt-button ${directPttPressedUserId === p.userId ? "active" : ""}`}
                              onPointerDown={() => startDirectPtt(p.userId)}
                              onPointerUp={() => stopDirectPtt(p.userId)}
                              onPointerLeave={() => stopDirectPtt(p.userId)}
                              onPointerCancel={() => stopDirectPtt(p.userId)}
                            >
                              Talk
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {presence.some((p) => !p.roleId || !roleNameById.has(p.roleId)) ? (
              <div className="online-room">
                <div className="online-room-title">Unknown role</div>
                <ul>
                  {presence
                    .filter((p) => !p.roleId || !roleNameById.has(p.roleId))
                    .map((p) => (
                      <li key={`${p.userId}-unknown-role`}>
                        <div className="online-user-row">
                          <span>
                            {p.username} — {p.micEnabled ? "mic on" : "mic off"}
                            {p.broadcastActive ? <span className="online-broadcast">broadcasting</span> : null}
                          </span>
                          {p.userId !== appData.self.id ? (
                            <button
                              className={`direct-ptt-button ${directPttPressedUserId === p.userId ? "active" : ""}`}
                              onPointerDown={() => startDirectPtt(p.userId)}
                              onPointerUp={() => stopDirectPtt(p.userId)}
                              onPointerLeave={() => stopDirectPtt(p.userId)}
                              onPointerCancel={() => stopDirectPtt(p.userId)}
                            >
                              Talk
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
          </div>
        </aside>
        <section>
          <div className="chat">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
              placeholder="Type chat message…"
            />
            <button onClick={sendChat}>Send chat</button>
          </div>
          <div className="signals">
            <button onClick={() => sendSignal("attention")}>Attention</button>
            <button onClick={() => sendSignal("standby")}>Standby</button>
            <button onClick={() => sendSignal("go")}>Go</button>
          </div>
          <div className="voice">
            <button
              className={`voice-ptt ${pttPressed ? "active" : ""}`}
              onPointerDown={startPtt}
              onPointerUp={stopPtt}
              onPointerLeave={stopPtt}
              onPointerCancel={stopPtt}
            >
              PTT
            </button>
            <label className="voice-toggle">
              <input type="checkbox" checked={voiceMode === "always_on"} onChange={(e) => setAlwaysOn(e.target.checked)} />
              <span>Always on</span>
            </label>
          </div>
          {appData.broadcastGroups.length > 0 ? (
            <div className="broadcast-ptt">
              <div className="broadcast-ptt-title">Broadcast PTT</div>
              <div className="broadcast-ptt-buttons">
                {appData.broadcastGroups.map((group) => (
                  <button
                    key={group.id}
                    className={`broadcast-ptt-button ${broadcastPttPressed === group.id ? "active" : ""}`}
                    onPointerDown={() => startBroadcastPtt(group.id)}
                    onPointerUp={() => stopBroadcastPtt(group.id)}
                    onPointerLeave={() => stopBroadcastPtt(group.id)}
                    onPointerCancel={() => stopBroadcastPtt(group.id)}
                  >
                    {group.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {isAdmin ? (
            <div className="admin-panel">
              <h3>Admin · configuration</h3>
              {adminError ? <p className="admin-error">{adminError}</p> : null}
              <div className="admin-block">
                <h4>Create role</h4>
                <div className="admin-grid">
                  <input value={roleCreateId} onChange={(e) => setRoleCreateId(e.target.value)} placeholder="role-id" />
                  <input value={roleCreateName} onChange={(e) => setRoleCreateName(e.target.value)} placeholder="Role name" />
                  <select
                    value={roleCreateDefaultRoomId}
                    onChange={(e) => setRoleCreateDefaultRoomId(e.target.value)}
                    aria-label="Default room"
                  >
                    <option value="">Default room…</option>
                    {appData.rooms.map((room) => (
                      <option key={`role-room-${room.id}`} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={roleCreateDefaultVoiceMode}
                    onChange={(e) => setRoleCreateDefaultVoiceMode(e.target.value as "always_on" | "ptt" | "")}
                    aria-label="Default audio mode"
                  >
                    <option value="">Default audio mode…</option>
                    <option value="always_on">Always on</option>
                    <option value="ptt">PTT</option>
                  </select>
                  <button onClick={createRoleConfig} disabled={adminBusy || !roleCreateId.trim() || !roleCreateName.trim()}>
                    Create role
                  </button>
                </div>
                {roleEditId ? (
                  <div className="admin-edit-panel">
                    <div className="admin-edit-title">Editing role: {roleEditId}</div>
                    <div className="admin-grid">
                      <input value={roleEditName} onChange={(e) => setRoleEditName(e.target.value)} placeholder="Role name" />
                      <select
                        value={roleEditDefaultRoomId}
                        onChange={(e) => setRoleEditDefaultRoomId(e.target.value)}
                        aria-label="Default room"
                      >
                        <option value="">Default room…</option>
                        {appData.rooms.map((room) => (
                          <option key={`role-edit-room-${room.id}`} value={room.id}>
                            {room.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={roleEditDefaultVoiceMode}
                        onChange={(e) => setRoleEditDefaultVoiceMode(e.target.value as "always_on" | "ptt" | "")}
                        aria-label="Default audio mode"
                      >
                        <option value="">Default audio mode…</option>
                        <option value="always_on">Always on</option>
                        <option value="ptt">PTT</option>
                      </select>
                      <button onClick={saveRoleEdit} disabled={adminBusy || !roleEditName.trim()}>
                        Save changes
                      </button>
                      <button onClick={resetRoleEditForm} disabled={adminBusy} className="secondary">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <ul className="admin-list">
                  {appData.roles.map((role) => (
                    <li key={role.id}>
                      <button
                        onClick={() => {
                          setRoleEditId(role.id);
                          setRoleEditName(role.name);
                          setRoleEditDefaultRoomId(role.defaultRoomId || "");
                          setRoleEditDefaultVoiceMode((role.defaultVoiceMode as "always_on" | "ptt") || "");
                        }}
                      >
                        Edit
                      </button>
                      <span>
                        {role.name} <small>({role.id})</small>
                      </span>
                      <button onClick={() => removeRoleConfig(role.id)} disabled={adminBusy}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="admin-block">
                <h4>Create room</h4>
                <div className="admin-grid">
                  <input value={roomCreateId} onChange={(e) => setRoomCreateId(e.target.value)} placeholder="room-id" />
                  <input value={roomCreateName} onChange={(e) => setRoomCreateName(e.target.value)} placeholder="Room name" />
                  <button onClick={createRoomConfig} disabled={adminBusy || !roomCreateId.trim() || !roomCreateName.trim()}>
                    Create room
                  </button>
                </div>
                {roomEditId ? (
                  <div className="admin-edit-panel">
                    <div className="admin-edit-title">Editing room: {roomEditId}</div>
                    <div className="admin-grid">
                      <input value={roomEditName} onChange={(e) => setRoomEditName(e.target.value)} placeholder="Room name" />
                      <button onClick={saveRoomEdit} disabled={adminBusy || !roomEditName.trim()}>
                        Save changes
                      </button>
                      <button onClick={resetRoomEditForm} disabled={adminBusy} className="secondary">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <ul className="admin-list">
                  {appData.rooms.map((room) => (
                    <li key={room.id}>
                      <button
                        onClick={() => {
                          setRoomEditId(room.id);
                          setRoomEditName(room.name);
                        }}
                      >
                        Edit
                      </button>
                      <span>
                        {room.name} <small>({room.id})</small>
                      </span>
                      <button onClick={() => removeRoomConfig(room.id)} disabled={adminBusy}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="admin-block">
                <h4>Create broadcast channel</h4>
                <div className="admin-grid">
                  <input
                    value={groupCreateId}
                    onChange={(e) => setGroupCreateId(e.target.value)}
                    placeholder="broadcast-channel-id"
                  />
                  <input
                    value={groupCreateName}
                    onChange={(e) => setGroupCreateName(e.target.value)}
                    placeholder="Broadcast channel name"
                  />
                  <button
                    onClick={createBroadcastGroupConfig}
                    disabled={adminBusy || !groupCreateId.trim() || !groupCreateName.trim() || groupCreateRoomIds.length === 0}
                  >
                    Create channel
                  </button>
                </div>
                <div className="admin-room-picker">
                  {appData.rooms.map((room) => (
                    <label key={`group-create-room-${room.id}`} className="admin-checkbox">
                      <input
                        type="checkbox"
                        checked={groupCreateRoomIds.includes(room.id)}
                        onChange={() =>
                          setGroupCreateRoomIds((prev) =>
                            prev.includes(room.id) ? prev.filter((id) => id !== room.id) : [...prev, room.id]
                          )
                        }
                      />
                      <span>{room.name}</span>
                    </label>
                  ))}
                </div>
                {groupEditId ? (
                  <div className="admin-edit-panel">
                    <div className="admin-edit-title">Editing channel: {groupEditId}</div>
                    <div className="admin-grid">
                      <input value={groupEditName} onChange={(e) => setGroupEditName(e.target.value)} placeholder="Channel name" />
                      <button onClick={saveGroupEdit} disabled={adminBusy || !groupEditName.trim() || groupEditRoomIds.length === 0}>
                        Save changes
                      </button>
                      <button onClick={resetGroupEditForm} disabled={adminBusy} className="secondary">
                        Cancel
                      </button>
                    </div>
                    <div className="admin-room-picker">
                      {appData.rooms.map((room) => (
                        <label key={`group-edit-room-${room.id}`} className="admin-checkbox">
                          <input
                            type="checkbox"
                            checked={groupEditRoomIds.includes(room.id)}
                            onChange={() =>
                              setGroupEditRoomIds((prev) =>
                                prev.includes(room.id) ? prev.filter((id) => id !== room.id) : [...prev, room.id]
                              )
                            }
                          />
                          <span>{room.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                <ul className="admin-list">
                  {appData.broadcastGroups.map((group) => (
                    <li key={group.id}>
                      <button
                        onClick={() => {
                          setGroupEditId(group.id);
                          setGroupEditName(group.name);
                          setGroupEditRoomIds(group.roomIds);
                        }}
                      >
                        Edit
                      </button>
                      <span>
                        {group.name} <small>({group.id})</small>
                      </span>
                      <button onClick={() => removeBroadcastGroupConfig(group.id)} disabled={adminBusy}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          {showDebug ? (
            <>
              <h3>Realtime events</h3>
              <ul className="events">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span>{e.at}</span>
                    <span>{e.label}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}

