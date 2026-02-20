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
  const [activeRoom, setActiveRoom] = useState("foh");
  const [presence, setPresence] = useState<Presence[]>([]);
  const [scope, setScope] = useState<"direct" | "room" | "broadcast">("room");
  const [targetId, setTargetId] = useState("");
  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<Array<{ label: string; at: string }>>([]);
  const [voiceMode, setVoiceMode] = useState<"always_on" | "ptt" | "listen_only">("always_on");
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
  const [adminRoleId, setAdminRoleId] = useState("");
  const [adminRoleName, setAdminRoleName] = useState("");
  const [adminRoleDefaultRoomId, setAdminRoleDefaultRoomId] = useState("");
  const [adminRoleDefaultVoiceMode, setAdminRoleDefaultVoiceMode] = useState<"always_on" | "ptt" | "listen_only" | "">(
    ""
  );
  const [adminRoomId, setAdminRoomId] = useState("");
  const [adminRoomName, setAdminRoomName] = useState("");
  const [adminGroupId, setAdminGroupId] = useState("");
  const [adminGroupName, setAdminGroupName] = useState("");
  const [adminGroupRoomIds, setAdminGroupRoomIds] = useState<string[]>([]);

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
  const activeRoomRef = useRef(activeRoom);
  const micMenuRef = useRef<HTMLDivElement | null>(null);
  const initialRoomFromUrl = (() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room");
    return room && room.trim() ? room : null;
  })();
  const initialRoomFromUrlRef = useRef<string | null>(initialRoomFromUrl);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
  useEffect(() => {
    selectedInputDeviceIdRef.current = selectedInputDeviceId;
  }, [selectedInputDeviceId]);
  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

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
        const urlRoom = initialRoomFromUrlRef.current;
        if (urlRoom && data.rooms.some((room) => room.id === urlRoom)) {
          setActiveRoom(urlRoom);
        } else if (roleDefaults?.defaultRoomId) {
          setActiveRoom(roleDefaults.defaultRoomId);
        } else if (data.rooms[0]) {
          setActiveRoom(data.rooms[0].id);
        }
        if (roleDefaults?.defaultVoiceMode) {
          const nextMode = roleDefaults.defaultVoiceMode as "always_on" | "ptt" | "listen_only";
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
    if (!adminRoleId && appData.roles[0]) {
      setAdminRoleId(appData.roles[0].id);
      setAdminRoleName(appData.roles[0].name);
      setAdminRoleDefaultRoomId(appData.roles[0].defaultRoomId || "");
      setAdminRoleDefaultVoiceMode((appData.roles[0].defaultVoiceMode as "always_on" | "ptt" | "listen_only") || "");
    }
    if (!adminRoomId && appData.rooms[0]) {
      setAdminRoomId(appData.rooms[0].id);
      setAdminRoomName(appData.rooms[0].name);
    }
    if (!adminGroupId && appData.broadcastGroups[0]) {
      setAdminGroupId(appData.broadcastGroups[0].id);
      setAdminGroupName(appData.broadcastGroups[0].name);
      setAdminGroupRoomIds(appData.broadcastGroups[0].roomIds);
    }
  }, [appData, adminRoleId, adminRoomId, adminGroupId]);

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

  function applyVoiceModeToLocalTracks(mode: "always_on" | "ptt" | "listen_only") {
    const stream = localStreamRef.current;
    if (!stream) return;
    const enabled = mode !== "listen_only" && mode !== "ptt";
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
        ws.send(JSON.stringify({ type: "set_active_room", data: { roomId: activeRoomRef.current } }));
        const initialVoiceMode = voiceModeRef.current;
        const voiceState =
          initialVoiceMode === "always_on" ? "always_on" : initialVoiceMode === "listen_only" ? "listen_only" : "ptt_stop";
        ws.send(
          JSON.stringify({
            type: "voice_state",
            data: { scope: "room", targetId: activeRoomRef.current, body: voiceState }
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
      wsRef.current.send(JSON.stringify({ type: "set_active_room", data: { roomId: activeRoom } }));
      const params = new URLSearchParams(window.location.search);
      params.set("room", activeRoom);
      const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
      setEvents((old) => [{ label: `system · room switch requested · ${activeRoom}`, at: new Date().toLocaleTimeString() }, ...old].slice(0, 200));
    }, 120);
    return () => clearRoomSwitchTimer();
  }, [activeRoom]);

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
    if (data.rooms.length > 0 && !data.rooms.some((room) => room.id === activeRoomRef.current)) {
      setActiveRoom(data.rooms[0].id);
    }
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

  function resetGroupForm() {
    setAdminGroupId("");
    setAdminGroupName("");
    setAdminGroupRoomIds([]);
  }

  function saveRoleConfig() {
    if (!token || !appData) return;
    const id = adminRoleId.trim();
    const name = adminRoleName.trim();
    if (!id || !name) return;
    const exists = appData.roles.some((role) => role.id === id);
    void runAdminAction(async () => {
      if (exists) {
        await updateRole(token, id, {
          name,
          defaultRoomId: adminRoleDefaultRoomId.trim() || undefined,
          defaultVoiceMode: adminRoleDefaultVoiceMode || undefined
        });
      } else {
        await createRole(token, {
          id,
          name,
          defaultRoomId: adminRoleDefaultRoomId.trim() || undefined,
          defaultVoiceMode: adminRoleDefaultVoiceMode || undefined
        });
      }
    });
  }

  function removeRoleConfig(id: string) {
    if (!token) return;
    void runAdminAction(() => deleteRole(token, id));
  }

  function saveRoomConfig() {
    if (!token || !appData) return;
    const id = adminRoomId.trim();
    const name = adminRoomName.trim();
    if (!id || !name) return;
    const exists = appData.rooms.some((room) => room.id === id);
    void runAdminAction(async () => {
      if (exists) {
        await updateRoom(token, id, { name });
      } else {
        await createRoom(token, { id, name });
      }
    });
  }

  function removeRoomConfig(id: string) {
    if (!token) return;
    void runAdminAction(() => deleteRoom(token, id));
  }

  function saveBroadcastGroupConfig() {
    if (!token || !appData) return;
    const id = adminGroupId.trim();
    const name = adminGroupName.trim();
    if (!id || !name || adminGroupRoomIds.length === 0) return;
    const exists = appData.broadcastGroups.some((group) => group.id === id);
    void runAdminAction(async () => {
      if (exists) {
        await updateBroadcastGroup(token, id, { name, roomIds: adminGroupRoomIds });
      } else {
        await createBroadcastGroup(token, { id, name, roomIds: adminGroupRoomIds });
      }
      resetGroupForm();
    });
  }

  function removeBroadcastGroupConfig(id: string) {
    if (!token) return;
    void runAdminAction(async () => {
      await deleteBroadcastGroup(token, id);
      if (adminGroupId === id) {
        resetGroupForm();
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
      const disable = state === "ptt_stop" || state === "listen_only";
      if (enable || disable) {
        for (const track of stream.getAudioTracks()) track.enabled = enable;
      }
    }
    if (state === "always_on") setVoiceMode("always_on");
    if (state === "listen_only") setVoiceMode("listen_only");
    if (state === "ptt_start" || state === "ptt_stop") setVoiceMode("ptt");
    const voiceTargetId = targetId || activeRoom;
    const voiceScope = targetId ? scope : "room";
    wsRef.current.send(JSON.stringify({ type: "voice_state", data: { scope: voiceScope, targetId: voiceTargetId, body: state } }));
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
                setActiveRoom(selectedRole.defaultRoomId);
              }
              if (selectedRole?.defaultVoiceMode) {
                const nextMode = selectedRole.defaultVoiceMode as "always_on" | "ptt" | "listen_only";
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
            <strong>{connectionState}</strong> · webrtc: <strong>{webrtcState}</strong>
          </p>
          <p style={{ margin: "0.2rem 0 0 0" }}>
            audio rtp: <strong>in {rtpStats.inKbps} kbps</strong> / <strong>out {rtpStats.outKbps} kbps</strong>
          </p>
          {audioError ? <p style={{ color: "#ffb4b4", margin: "0.35rem 0 0 0" }}>{audioError}</p> : null}
        </div>
        <button onClick={doLogout}>Logout</button>
      </header>
      <main>
        <aside>
          <h3>Active room</h3>
          <select value={activeRoom} onChange={(e) => setActiveRoom(e.target.value)}>
            {appData.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
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
          <ul>
            {presence.map((p) => (
              <li key={`${p.userId}-${p.activeRoom}`}>
                {p.username} ({p.roleId}) — {p.activeRoom || "no room"} — {p.voiceMode || "unknown"} /{" "}
                {p.micEnabled ? "mic on" : "mic off"}
              </li>
            ))}
          </ul>
        </aside>
        <section>
          <div className="controls">
            <label>
              Scope
              <select value={scope} onChange={(e) => setScope(e.target.value as "direct" | "room" | "broadcast")}>
                <option value="direct">Direct</option>
                <option value="room">Room</option>
                <option value="broadcast">Broadcast</option>
              </select>
            </label>
            <label>
              Target
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {currentTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
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
            <button onClick={() => sendVoiceState("ptt_start")}>PTT Start</button>
            <button onClick={() => sendVoiceState("ptt_stop")}>PTT Stop</button>
            <button onClick={() => sendVoiceState("always_on")}>Always On</button>
            <button onClick={() => sendVoiceState("listen_only")}>Listen Only</button>
          </div>
          {isAdmin ? (
            <div className="admin-panel">
              <h3>Admin · configuration</h3>
              {adminError ? <p className="admin-error">{adminError}</p> : null}
              <div className="admin-block">
                <h4>Roles</h4>
                <div className="admin-grid">
                  <input value={adminRoleId} onChange={(e) => setAdminRoleId(e.target.value)} placeholder="role-id" />
                  <input value={adminRoleName} onChange={(e) => setAdminRoleName(e.target.value)} placeholder="Role name" />
                  <select
                    value={adminRoleDefaultRoomId}
                    onChange={(e) => setAdminRoleDefaultRoomId(e.target.value)}
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
                    value={adminRoleDefaultVoiceMode}
                    onChange={(e) => setAdminRoleDefaultVoiceMode(e.target.value as "always_on" | "ptt" | "listen_only" | "")}
                    aria-label="Default audio mode"
                  >
                    <option value="">Default audio mode…</option>
                    <option value="always_on">Always on</option>
                    <option value="ptt">PTT</option>
                    <option value="listen_only">Listen only</option>
                  </select>
                  <button onClick={saveRoleConfig} disabled={adminBusy || !adminRoleId.trim() || !adminRoleName.trim()}>
                    Save role
                  </button>
                </div>
                <ul className="admin-list">
                  {appData.roles.map((role) => (
                    <li key={role.id}>
                      <button
                        onClick={() => {
                          setAdminRoleId(role.id);
                          setAdminRoleName(role.name);
                          setAdminRoleDefaultRoomId(role.defaultRoomId || "");
                          setAdminRoleDefaultVoiceMode((role.defaultVoiceMode as "always_on" | "ptt" | "listen_only") || "");
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
                <h4>Rooms</h4>
                <div className="admin-grid">
                  <input value={adminRoomId} onChange={(e) => setAdminRoomId(e.target.value)} placeholder="room-id" />
                  <input value={adminRoomName} onChange={(e) => setAdminRoomName(e.target.value)} placeholder="Room name" />
                  <button onClick={saveRoomConfig} disabled={adminBusy || !adminRoomId.trim() || !adminRoomName.trim()}>
                    Save room
                  </button>
                </div>
                <ul className="admin-list">
                  {appData.rooms.map((room) => (
                    <li key={room.id}>
                      <button
                        onClick={() => {
                          setAdminRoomId(room.id);
                          setAdminRoomName(room.name);
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
                <h4>Broadcast channels</h4>
                <div className="admin-grid">
                  <input
                    value={adminGroupId}
                    onChange={(e) => setAdminGroupId(e.target.value)}
                    placeholder="broadcast-channel-id"
                  />
                  <input
                    value={adminGroupName}
                    onChange={(e) => setAdminGroupName(e.target.value)}
                    placeholder="Broadcast channel name"
                  />
                  <button
                    onClick={saveBroadcastGroupConfig}
                    disabled={adminBusy || !adminGroupId.trim() || !adminGroupName.trim() || adminGroupRoomIds.length === 0}
                  >
                    Save channel
                  </button>
                </div>
                <div className="admin-room-picker">
                  {appData.rooms.map((room) => (
                    <label key={`group-room-${room.id}`} className="admin-checkbox">
                      <input
                        type="checkbox"
                        checked={adminGroupRoomIds.includes(room.id)}
                        onChange={() =>
                          setAdminGroupRoomIds((prev) =>
                            prev.includes(room.id) ? prev.filter((id) => id !== room.id) : [...prev, room.id]
                          )
                        }
                      />
                      <span>{room.name}</span>
                    </label>
                  ))}
                </div>
                <ul className="admin-list">
                  {appData.broadcastGroups.map((group) => (
                    <li key={group.id}>
                      <button
                        onClick={() => {
                          setAdminGroupId(group.id);
                          setAdminGroupName(group.name);
                          setAdminGroupRoomIds(group.roomIds);
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
          <h3>Realtime events</h3>
          <ul className="events">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span>{e.at}</span>
                <span>{e.label}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

