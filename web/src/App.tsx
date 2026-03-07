import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bootstrap,
  getPublicBootstrap,
  getStatus,
  login,
  logout,
  updateAdminPin,
} from "./api";
import { LoginView } from "./components/LoginView";
import { SimpleIntercomView } from "./components/SimpleIntercomView";
import { StationIntercomView } from "./components/StationIntercomView";
import { AdminShell } from "./components/admin/AdminShell";
import { ChatSignalPanel } from "./components/panels/ChatSignalPanel";
import { RealtimeEventsPanel } from "./components/panels/RealtimeEventsPanel";
import {
  tokenStorageKey,
  sessionSettingsStorageKey,
  type SessionSettings,
} from "./app/settings";
import {
  useKeyboardShortcuts,
  type ShortcutCallbacks,
} from "./app/useKeyboardShortcuts";
import { roleAllowed, matrixAnchorRoomId } from "./lib/intercom";
import { sortDirectUsersByRoleAndUsername } from "./lib/users";
import type { Bootstrap, PublicBootstrap } from "./types";
import { useSettings } from "./hooks/useSettings";
import { useAudioDevices } from "./hooks/useAudioDevices";
import { useIntercomSession } from "./hooks/useIntercomSession";

const adminPathname = "/admin";
const loginPathname = "/login";
const statusPollIntervalMs = 3000;

function isAdminPathname(pathname: string): boolean {
  return pathname === adminPathname;
}

function syncPathname(pathname: string, replace = false) {
  if (window.location.pathname === pathname) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method](
    window.history.state,
    "",
    `${pathname}${window.location.search}${window.location.hash}`,
  );
}

export function App() {
  // ── Core auth state ──
  const [token, setToken] = useState<string | null>(() =>
    sessionStorage.getItem(tokenStorageKey),
  );
  const [appData, setAppData] = useState<Bootstrap | null>(null);
  const [publicData, setPublicData] = useState<PublicBootstrap | null>(null);
  const [authMode, setAuthMode] = useState<"operator" | "admin">(() =>
    isAdminPathname(window.location.pathname) ? "admin" : "operator",
  );
  const [adminPinInput, setAdminPinInput] = useState("");
  const [adminLoginError, setAdminLoginError] = useState("");
  const [adminOverrideActive, setAdminOverrideActive] = useState(false);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [roomListenerCounts, setRoomListenerCounts] = useState<
    Record<string, number>
  >({});

  // ── UI state ──
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const isUserSettingsOpenRef = useRef(isUserSettingsOpen);
  useEffect(() => {
    isUserSettingsOpenRef.current = isUserSettingsOpen;
  }, [isUserSettingsOpen]);

  const showDebug = (() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("debug");
    return v === "1" || v === "true";
  })();

  // ── Settings & preferences ──
  const settings = useSettings();

  // ── Audio devices ──
  const audioDevices = useAudioDevices({
    setSelectedInputDeviceId: settings.setSelectedInputDeviceId,
    setSelectedOutputDeviceId: settings.setSelectedOutputDeviceId,
  });

  // Load initial room matrix from session storage (only once at mount)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const storedSession = useMemo(() => {
    try {
      return JSON.parse(
        localStorage.getItem(sessionSettingsStorageKey) || "{}",
      ) as Partial<SessionSettings>;
    } catch {
      return {} as Partial<SessionSettings>;
    }
  }, []);

  // ── Intercom session (WS + WebRTC + audio + voice) ──
  const session = useIntercomSession({
    token,
    appData,
    authMode,
    showDebug,
    selectedInputDeviceId: settings.selectedInputDeviceId,
    selectedInputDeviceIdRef: settings.selectedInputDeviceIdRef,
    selectedOutputDeviceId: settings.selectedOutputDeviceId,
    selectedOutputDeviceIdRef: settings.selectedOutputDeviceIdRef,
    inputGainByDeviceId: settings.inputGainByDeviceId,
    inputGainByDeviceIdRef: settings.inputGainByDeviceIdRef,
    roomGainById: settings.roomGainById,
    roomGainByIdRef: settings.roomGainByIdRef,
    directGainByUserId: settings.directGainByUserId,
    directGainByUserIdRef: settings.directGainByUserIdRef,
    enableDirectPpt: settings.enableDirectPpt,
    enableBackgroundAudioRecovery: settings.enableBackgroundAudioRecovery,
    keepScreenAwake: settings.keepScreenAwake,
    isUserSettingsOpen,
    isUserSettingsOpenRef,
    selectedInputGainFor: settings.selectedInputGainFor,
    initialListenRoomIds: storedSession.listenRoomIds ?? [],
    initialTalkRoomIds: storedSession.talkRoomIds ?? [],
    hadStoredSessionSettings: settings.hadStoredSessionSettings,
    initialVoiceMode: settings.enableDirectPpt ? "ptt" : "always_on",
    onUpdateAppData: setAppData,
    onUpdatePublicData: setPublicData,
    onRefreshAudioDevices: audioDevices.refreshAudioDevices,
  });

  // ── Computed values ──
  const selectedInputGain = useMemo(
    () => settings.selectedInputGainFor(settings.selectedInputDeviceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.selectedInputDeviceId, settings.inputGainByDeviceId],
  );

  const selectedMicLabel = useMemo(
    () =>
      audioDevices.inputDevices.find(
        (d) => d.deviceId === settings.selectedInputDeviceId,
      )?.label || "Select microphone",
    [audioDevices.inputDevices, settings.selectedInputDeviceId],
  );

  const outputSelectionSupported = useMemo(() => {
    type AudioWithSinkId = HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const probe = document.createElement("audio") as AudioWithSinkId;
    return typeof probe.setSinkId === "function";
  }, []);

  const selectedOutputLabel = useMemo(() => {
    if (!settings.selectedOutputDeviceId) return "System default";
    return (
      audioDevices.outputDevices.find(
        (d) => d.deviceId === settings.selectedOutputDeviceId,
      )?.label || "System default"
    );
  }, [audioDevices.outputDevices, settings.selectedOutputDeviceId]);

  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of appData?.roles || []) map.set(role.id, role.name);
    return map;
  }, [appData]);

  // ── Initial load: public bootstrap ──
  useEffect(() => {
    localStorage.removeItem(tokenStorageKey);
    getPublicBootstrap().then(setPublicData).catch(console.error);
  }, []);

  // ── Bootstrap on login ──
  useEffect(() => {
    if (!token) return;
    bootstrap(token)
      .then((data) => {
        setAppData(data);
        settings.setRoleID(data.self.roleId);
        session.applyBootstrapData(data, true);
      })
      .catch(() => {
        sessionStorage.removeItem(tokenStorageKey);
        setToken(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Status polling ──
  useEffect(() => {
    if (!token || authMode !== "operator") {
      setRoomListenerCounts({});
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const pollStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const status = await getStatus(token);
        if (cancelled) return;
        setRoomListenerCounts(status.roomListenerCounts ?? {});
      } catch {
        if (cancelled) return;
      } finally {
        inFlight = false;
      }
    };
    void pollStatus();
    const intervalId = window.setInterval(
      () => void pollStatus(),
      statusPollIntervalMs,
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token, authMode]);

  // ── Session persistence (all four fields together) ──
  useEffect(() => {
    localStorage.setItem(
      sessionSettingsStorageKey,
      JSON.stringify({
        username: settings.username,
        roleId: settings.roleId,
        listenRoomIds: session.listenRoomIds,
        talkRoomIds: session.talkRoomIds,
      } satisfies SessionSettings),
    );
  }, [
    settings.username,
    settings.roleId,
    session.listenRoomIds,
    session.talkRoomIds,
  ]);

  // ── Prune pinned rooms/users that no longer exist ──
  useEffect(() => {
    if (!appData) return;
    settings.setPinnedRoomIds((prev) =>
      prev.filter((id) => appData.rooms.some((room) => room.id === id)),
    );
    settings.setPinnedUserIds((prev) =>
      prev.filter((id) => appData.users.some((user) => user.id === id)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appData]);

  // ── Prune per-room/user gain entries for entities that no longer exist ──
  useEffect(() => {
    if (!appData) return;
    settings.setRoomGainById((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([roomId]) =>
          appData.rooms.some((room) => room.id === roomId),
        ),
      ),
    );
    settings.setDirectGainByUserId((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([userId]) =>
          appData.users.some((user) => user.id === userId),
        ),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appData]);

  // ── Routing ──
  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!token) return;
    if (isAdminPathname(pathname)) setAuthMode("admin");
  }, [pathname, token]);

  useEffect(() => {
    if (!token) {
      syncPathname(loginPathname, true);
      setPathname(loginPathname);
      return;
    }
    const targetPathname = authMode === "admin" ? adminPathname : "/";
    if (pathname === loginPathname) {
      syncPathname(targetPathname, true);
      setPathname(targetPathname);
      return;
    }
    if (pathname !== targetPathname) {
      syncPathname(targetPathname);
      setPathname(targetPathname);
    }
  }, [authMode, pathname, token]);

  // ── Login / logout ──
  async function doLogin(overrideUsername?: string, overrideRoleId?: string) {
    const useUsername =
      typeof overrideUsername === "string"
        ? overrideUsername
        : settings.username.trim();
    const useRoleId =
      typeof overrideRoleId === "string" ? overrideRoleId : settings.roleId;
    const res = await login(useUsername, useRoleId);
    sessionStorage.setItem(tokenStorageKey, res.token);
    setToken(res.token);
  }

  async function handleOperatorLogin() {
    setAuthMode("operator");
    setAdminLoginError("");
    try {
      await doLogin();
    } catch (error) {
      setAdminLoginError(
        error instanceof Error ? error.message : "Login failed.",
      );
    }
  }

  async function handleAdminLogin() {
    if (adminPinInput.trim() !== settings.adminPinGuard) {
      setAdminLoginError("Incorrect admin PIN.");
      return;
    }
    setAdminLoginError("");
    const nextRoleId = settings.roleId || publicData?.roles?.[0]?.id || "";
    if (!nextRoleId) {
      setAdminLoginError("No role available for admin login.");
      return;
    }
    setAuthMode("admin");
    try {
      await doLogin("admin", nextRoleId);
      setAdminOverrideActive(true);
    } catch (error) {
      setAuthMode("operator");
      setAdminLoginError(
        error instanceof Error ? error.message : "Admin login failed.",
      );
    }
  }

  async function doLogout() {
    if (!token) return;
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
  }

  async function refreshBootstrapData() {
    if (!token) return;
    const data = await bootstrap(token);
    setAppData(data);
    settings.setRoleID(data.self.roleId);
    setPublicData({
      roles: data.roles,
      rooms: data.rooms,
      broadcastGroups: data.broadcastGroups,
    });
    session.applyBootstrapData(data, false);
  }

  // ── Output device change (guarded) ──
  async function changeOutputDevice(outputDeviceId: string) {
    if (outputDeviceId === settings.selectedOutputDeviceIdRef.current) return;
    if (outputDeviceId !== "") {
      type AudioWithSinkId = HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      const probe = document.createElement("audio") as AudioWithSinkId;
      if (typeof probe.setSinkId !== "function") return;
      try {
        await probe.setSinkId(outputDeviceId);
      } catch {
        return;
      }
    }
    settings.setSelectedOutputDeviceId(outputDeviceId);
    settings.selectedOutputDeviceIdRef.current = outputDeviceId;
  }

  // ── Keyboard shortcuts ──
  const shortcutCallbacks = useMemo<ShortcutCallbacks>(
    () => ({
      ptt: { onStart: session.startPtt, onStop: session.stopPtt },
      toggleAlwaysOn: {
        onToggle: () =>
          session.setAlwaysOn(session.voiceModeRef.current !== "always_on"),
      },
    }),
    // session functions close over refs – stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useKeyboardShortcuts(
    settings.keyboardShortcuts,
    shortcutCallbacks,
    !isRecordingShortcut,
  );

  const togglePinnedRoom = useCallback(
    (roomId: string) => {
      settings.setPinnedRoomIds((prev) =>
        prev.includes(roomId)
          ? prev.filter((id) => id !== roomId)
          : [...prev, roomId],
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const togglePinnedUser = useCallback(
    (userId: string) => {
      settings.setPinnedUserIds((prev) =>
        prev.includes(userId)
          ? prev.filter((id) => id !== userId)
          : [...prev, userId],
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Early returns ──
  if (!publicData) return <div className="root">Loading configuration...</div>;

  if (!token) {
    return (
      <LoginView
        publicData={publicData}
        username={settings.username}
        roleId={settings.roleId}
        onUsernameChange={settings.setUsername}
        onRoleChange={(nextRoleId) => {
          settings.setRoleID(nextRoleId);
          const selectedRole = publicData.roles.find(
            (r) => r.id === nextRoleId,
          );
          if (selectedRole?.defaultRoomId) {
            localStorage.setItem(
              sessionSettingsStorageKey,
              JSON.stringify({
                username: settings.username,
                roleId: nextRoleId,
                listenRoomIds: [selectedRole.defaultRoomId],
                talkRoomIds: [selectedRole.defaultRoomId],
              } satisfies SessionSettings),
            );
          }
        }}
        onLogin={() => void handleOperatorLogin()}
        adminPin={adminPinInput}
        onAdminPinChange={setAdminPinInput}
        onAdminLogin={() => void handleAdminLogin()}
        adminError={adminLoginError}
      />
    );
  }

  if (!appData) return <div className="root">Loading data...</div>;

  // ── Admin view ──
  if (authMode === "admin") {
    const displayUsername = adminOverrideActive
      ? "admin"
      : appData.self.username;
    const adminRoleLabel = adminOverrideActive
      ? "Admin"
      : roleNameById.get(appData.self.roleId) || appData.self.roleId || "Admin";
    return (
      <AdminShell
        token={token}
        appData={appData}
        adminPin={settings.adminPinGuard}
        onUpdateAdminPin={async (currentPin, newPin) => {
          await updateAdminPin(token, currentPin, newPin);
          settings.setAdminPinGuard(newPin);
        }}
        audioStats={session.rtpStats}
        activeRoutesCount={session.activeVoiceRoutes.length}
        displayUsername={displayUsername}
        adminRoleLabel={adminRoleLabel}
        onRefresh={refreshBootstrapData}
        onLogout={doLogout}
      />
    );
  }

  // ── Operator view ──
  const chatAndSignalBlock = (
    <ChatSignalPanel
      message={session.message}
      onMessageChange={session.setMessage}
      onSendChat={session.sendChat}
      chatMessages={session.chatMessages}
    />
  );
  const realtimeDebugBlock = <RealtimeEventsPanel events={session.events} />;

  const receivingRoutes = session.incomingAudioActive
    ? session.activeVoiceRoutes
    : [];
  const alwaysOnFallbackRoomIds = new Set(
    !session.incomingAudioActive || receivingRoutes.length > 0
      ? []
      : session.presence
          .filter(
            (p) =>
              p.userId !== appData.self.id &&
              p.voiceMode === "always_on" &&
              p.micEnabled &&
              Array.isArray(p.talkRooms) &&
              p.talkRooms.length > 0,
          )
          .flatMap((p) =>
            p.talkRooms.filter((roomId) =>
              session.listenRoomIds.includes(roomId),
            ),
          ),
  );

  function isReceivingRoom(roomId: string) {
    if (!session.incomingAudioActive) return false;
    if (
      receivingRoutes.some((r) => r.scope === "room" && r.targetID === roomId)
    )
      return true;
    return alwaysOnFallbackRoomIds.has(roomId);
  }

  function isReceivingBroadcast(groupId: string) {
    if (!session.incomingAudioActive) return false;
    return receivingRoutes.some(
      (r) => r.scope === "broadcast" && r.targetID === groupId,
    );
  }

  function isReceivingDirect(userId: string) {
    if (!session.incomingAudioActive) return false;
    return receivingRoutes.some(
      (r) => r.scope === "direct" && r.senderUserID === userId,
    );
  }

  const directOnlineTargets = sortDirectUsersByRoleAndUsername(
    session.presence.filter((p) => p.userId !== appData.self.id),
    roleNameById,
  );
  const replyTarget =
    directOnlineTargets.find(
      (p) => p.userId === session.lastDirectCallerUserId,
    ) || null;

  const simpleVoiceTargetId = matrixAnchorRoomId(
    session.listenRoomIds,
    session.talkRoomIds,
  );
  const simplePttTargetLabel =
    appData.rooms.find((room) => room.id === simpleVoiceTargetId)?.name ||
    "No room selected";

  const attentionFlashOverlay = session.incomingAttention ? (
    <div
      key={session.attentionFlashKey}
      className="attention-flash attention-flash-call"
      role="status"
      aria-live="assertive"
    >
      <div className="attention-flash-card">
        <strong>{session.incomingAttention.title}</strong>
        <span>{session.incomingAttention.detail}</span>
      </div>
    </div>
  ) : null;

  if (session.viewMode === "simple") {
    return (
      <>
        <SimpleIntercomView
          connectionState={session.connectionState}
          pttPressed={session.pttPressed}
          onStartPpt={session.startPtt}
          onStopPpt={session.stopPtt}
          replyTarget={
            replyTarget
              ? { userId: replyTarget.userId, username: replyTarget.username }
              : null
          }
          selectedInputDeviceId={settings.selectedInputDeviceId}
          onSelectedInputDeviceIdChange={settings.setSelectedInputDeviceId}
          inputDevices={audioDevices.inputDevices}
          selectedOutputDeviceId={settings.selectedOutputDeviceId}
          onSelectedOutputDeviceIdChange={(id) => void changeOutputDevice(id)}
          outputDevices={audioDevices.outputDevices}
          outputSelectionSupported={outputSelectionSupported}
          enableBackgroundAudioRecovery={settings.enableBackgroundAudioRecovery}
          onEnableBackgroundAudioRecoveryChange={
            settings.setEnableBackgroundAudioRecovery
          }
          keepScreenAwake={settings.keepScreenAwake}
          onKeepScreenAwakeChange={settings.setKeepScreenAwake}
          mediaSessionSupported={session.mediaSessionSupported}
          wakeLockSupported={session.wakeLockSupported}
          wakeLockActive={session.wakeLockActive}
          isStandaloneDisplayMode={session.isStandaloneDisplayMode}
          simplePptTargetLabel={simplePttTargetLabel}
          doLogout={() => void doLogout()}
        />
        {attentionFlashOverlay}
      </>
    );
  }

  return (
    <>
      <StationIntercomView
        connectionState={session.connectionState}
        appData={appData}
        doLogout={() => void doLogout()}
        listenRoomIds={session.listenRoomIds}
        talkRoomIds={session.talkRoomIds}
        canRoleSendToRoom={(roomId, currentRoleId) => {
          const room = appData.rooms.find((r) => r.id === roomId);
          return !!room && roleAllowed(room.senderRoleIds, currentRoleId);
        }}
        canRoleReceiveFromRoom={(roomId, currentRoleId) => {
          const room = appData.rooms.find((r) => r.id === roomId);
          return !!room && roleAllowed(room.receiverRoleIds, currentRoleId);
        }}
        toggleTalkRoom={session.toggleTalkRoom}
        toggleListenRoom={session.toggleListenRoom}
        isReceivingRoom={isReceivingRoom}
        isReceivingBroadcast={isReceivingBroadcast}
        isReceivingDirect={isReceivingDirect}
        broadcastPttPressed={session.broadcastPttPressed}
        startBroadcastPtt={session.startBroadcastPtt}
        stopBroadcastPtt={session.stopBroadcastPtt}
        broadcastGroups={appData.broadcastGroups}
        presence={session.presence}
        roomListenerCounts={roomListenerCounts}
        roleNameById={roleNameById}
        lastDirectCallerUserId={session.lastDirectCallerUserId}
        directPttPressedUserId={session.directPttPressedUserId}
        startDirectPtt={session.startDirectPtt}
        stopDirectPtt={session.stopDirectPtt}
        sendScopedSignal={session.sendScopedSignal}
        pttPressed={session.pttPressed}
        startPtt={session.startPtt}
        stopPtt={session.stopPtt}
        voiceMode={session.voiceMode}
        setAlwaysOn={session.setAlwaysOn}
        chatAndSignalPanel={chatAndSignalBlock}
        showDebug={showDebug}
        realtimeDebugBlock={realtimeDebugBlock}
        enableDirectPpt={settings.enableDirectPpt}
        onEnableDirectPptChange={(enabled) => {
          settings.setEnableDirectPpt(enabled);
          session.handleEnableDirectPptChange(enabled);
        }}
        enableDirectTabs={settings.enableDirectTabs}
        onEnableDirectTabsChange={settings.setEnableDirectTabs}
        enableBackgroundAudioRecovery={settings.enableBackgroundAudioRecovery}
        onEnableBackgroundAudioRecoveryChange={
          settings.setEnableBackgroundAudioRecovery
        }
        keepScreenAwake={settings.keepScreenAwake}
        onKeepScreenAwakeChange={settings.setKeepScreenAwake}
        mediaSessionSupported={session.mediaSessionSupported}
        wakeLockSupported={session.wakeLockSupported}
        wakeLockActive={session.wakeLockActive}
        isStandaloneDisplayMode={session.isStandaloneDisplayMode}
        onChannelPptStart={session.handleChannelPttStart}
        onChannelPptStop={session.handleChannelPttStop}
        pptPressedChannelId={session.pttPressedChannelId}
        pinnedRoomIds={settings.pinnedRoomIds}
        pinnedUserIds={settings.pinnedUserIds}
        showPinnedOnly={settings.showPinnedOnly}
        onTogglePinnedRoom={togglePinnedRoom}
        onTogglePinnedUser={togglePinnedUser}
        onShowPinnedOnlyChange={settings.setShowPinnedOnly}
        isUserSettingsOpen={isUserSettingsOpen}
        setIsUserSettingsOpen={setIsUserSettingsOpen}
        roomGainById={settings.roomGainById}
        directGainByUserId={settings.directGainByUserId}
        onRoomGainChange={settings.onRoomGainChange}
        onDirectGainChange={settings.onDirectGainChange}
        keyboardShortcuts={settings.keyboardShortcuts}
        onKeyboardShortcutsChange={settings.setKeyboardShortcuts}
        onRecordingShortcutChange={setIsRecordingShortcut}
        inputDevices={audioDevices.inputDevices}
        selectedInputDeviceId={settings.selectedInputDeviceId}
        selectedMicLabel={selectedMicLabel}
        setSelectedInputDeviceId={settings.setSelectedInputDeviceId}
        inputLevelDbFs={session.inputLevelDbFs}
        inputGain={selectedInputGain}
        inputClipping={session.displayedInputClipping}
        onInputGainChange={settings.onInputGainChange}
        outputDevices={audioDevices.outputDevices}
        selectedOutputDeviceId={settings.selectedOutputDeviceId}
        selectedOutputLabel={selectedOutputLabel}
        outputSelectionSupported={outputSelectionSupported}
        setSelectedOutputDeviceId={(id) => void changeOutputDevice(id)}
      />
      {attentionFlashOverlay}
    </>
  );
}
