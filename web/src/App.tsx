import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  StreamDeckButtonControlDefinition,
  StreamDeckEncoderControlDefinition,
  StreamDeckWeb,
} from "@elgato-stream-deck/webhid";
import {
  adminLogin,
  bootstrap,
  getStreamDeckSettings,
  getPublicBootstrap,
  getStatus,
  login,
  loginTakeover,
  publishUserCompanionProfile,
  resetStreamDeckSettings,
  logout,
  updateStreamDeckSettings,
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
import {
  gainWithDbDelta,
  parseStreamDeckBridgeEvent,
  resolveStreamDeckButtonAction,
  streamDeckButtonEventName,
} from "./lib/streamDeckBridge";
import {
  isWebHidSupported,
} from "./lib/streamDeckWebHid";
import { createStreamDeckDevTools } from "./lib/streamDeckDevTools";
import {
  getStreamDeckPageButtons,
  renderStreamDeckButton,
  type StreamDeckRenderableButton,
} from "./lib/streamDeckHardwareFeedback";
import { withResolvedStreamDeckButtonLabel } from "./lib/streamDeckLabels";
import { sortDirectUsersByRoleAndUsername } from "./lib/users";
import type {
  Bootstrap,
  LoginConflict,
  Presence,
  PublicBootstrap,
  StreamDeckButtonConfig,
  StreamDeckSettings,
} from "./types";
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

function localDefaultStreamDeckSettings(): StreamDeckSettings {
  return {
    version: 1,
    gridColumns: 5,
    gridRows: 3,
    selectedPage: 0,
    pages: [
      {
        page: 0,
        buttons: Array.from({ length: 15 }, (_, index) => ({ index })),
      },
    ],
  };
}

type StreamDeckRenderRequest = {
  buttonIndex?: number;
  force?: boolean;
};

function mergeStreamDeckRenderRequests(
  current: StreamDeckRenderRequest | null,
  next: StreamDeckRenderRequest,
): StreamDeckRenderRequest {
  if (!current) return next;
  if (current.force || next.force) {
    return { force: true };
  }
  if (
    typeof current.buttonIndex === "number" &&
    typeof next.buttonIndex === "number" &&
    current.buttonIndex === next.buttonIndex
  ) {
    return { buttonIndex: current.buttonIndex };
  }
  return {};
}

function streamDeckButtonRenderSignature(
  page: number,
  button: StreamDeckRenderableButton,
  pressed: boolean,
): string {
  const action = button.action;
  return [
    page,
    button.index,
    button.label || "",
    button.color || "",
    action?.type || "none",
    action?.roomId || "",
    action?.userId || "",
    action?.roleId || "",
    action?.broadcastGroupId || "",
    action?.volumeDelta ?? "",
    button.isListening ? "1" : "0",
    button.attentionActive ? "1" : "0",
    button.attentionPulseOn ? "1" : "0",
    pressed ? "1" : "0",
  ].join("|");
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
  const [operatorLoginError, setOperatorLoginError] = useState("");
  const [adminOverrideActive, setAdminOverrideActive] = useState(false);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [roomListenerCounts, setRoomListenerCounts] = useState<
    Record<string, number>
  >({});
  const [pendingTakeover, setPendingTakeover] = useState<
    | {
        username: string;
        roleId: string;
        conflict: LoginConflict;
        targetAuthMode: "operator" | "admin";
        adminOverrideActive: boolean;
      }
    | null
  >(null);

  // ── UI state ──
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [streamDeckSettings, setStreamDeckSettings] =
    useState<StreamDeckSettings | null>(null);
  const [streamDeckBusy, setStreamDeckBusy] = useState(false);
  const [streamDeckError, setStreamDeckError] = useState("");
  const [streamDeckConnected, setStreamDeckConnected] = useState(false);
  const [streamDeckLastEvent, setStreamDeckLastEvent] = useState("");
  const [streamDeckWebHidSupported] = useState(() => isWebHidSupported());
  const [streamDeckWebHidActive, setStreamDeckWebHidActive] = useState(false);
  const [streamDeckWebHidBusy, setStreamDeckWebHidBusy] = useState(false);
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
  const streamDeckHidSessionRef = useRef<{
    deck: StreamDeckWeb;
    pressedButtons: Set<number>;
    onDown: (
      control:
        | StreamDeckButtonControlDefinition
        | StreamDeckEncoderControlDefinition,
    ) => void;
    onUp: (
      control:
        | StreamDeckButtonControlDefinition
        | StreamDeckEncoderControlDefinition,
    ) => void;
    onError: (error: unknown) => void;
  } | null>(null);
  const handleStreamDeckHardwareCommand = useCallback(
    (cmd: { command: string; brightness?: number }) => {
      const hidSession = streamDeckHidSessionRef.current;
      if (!hidSession) return;
      if (cmd.command === "set_streamdeck_brightness") {
        void hidSession.deck.setBrightness(
          Math.max(0, Math.min(100, cmd.brightness ?? 70)),
        );
      } else if (cmd.command === "clear_streamdeck_panel") {
        void hidSession.deck.clearPanel();
      } else if (cmd.command === "reset_streamdeck") {
        void hidSession.deck.resetToLogo();
      }
    },
    [],
  );
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
    onInputGainChange: settings.onInputGainChange,
    initialListenRoomIds: storedSession.listenRoomIds ?? [],
    initialTalkRoomIds: storedSession.talkRoomIds ?? [],
    hadStoredSessionSettings: settings.hadStoredSessionSettings,
    initialVoiceMode: settings.enableDirectPpt ? "ptt" : "always_on",
    onUpdateAppData: setAppData,
    onUpdatePublicData: setPublicData,
    onRefreshAudioDevices: audioDevices.refreshAudioDevices,
    onSessionRevoked: () => {
      sessionStorage.removeItem(tokenStorageKey);
      localStorage.removeItem(tokenStorageKey);
      setToken(null);
      setAppData(null);
    },
    onStreamDeckHardwareCommand: handleStreamDeckHardwareCommand,
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

  const streamDeckSettingsRef = useRef<StreamDeckSettings | null>(null);
  const appDataRef = useRef<Bootstrap | null>(null);
  const listenRoomIdsRef = useRef<string[]>([]);
  const presenceRef = useRef<Presence[]>([]);
  const lastDirectCallerUserIdRef = useRef<string | null>(null);
  const incomingAttentionRef = useRef(false);
  const streamDeckAttentionPulseOnRef = useRef(false);
  const streamDeckPressedRoleTargetsRef = useRef<Map<string, string>>(new Map());
  const streamDeckRenderInFlightRef = useRef(false);
  const streamDeckPendingRenderRef = useRef<StreamDeckRenderRequest | null>(
    null,
  );
  const streamDeckRenderedSignatureByIndexRef = useRef<Map<number, string>>(
    new Map(),
  );
  useEffect(() => {
    streamDeckSettingsRef.current = streamDeckSettings;
  }, [streamDeckSettings]);

  useEffect(() => {
    appDataRef.current = appData;
  }, [appData]);

  useEffect(() => {
    listenRoomIdsRef.current = session.listenRoomIds;
  }, [session.listenRoomIds]);

  useEffect(() => {
    presenceRef.current = session.presence;
  }, [session.presence]);

  useEffect(() => {
    lastDirectCallerUserIdRef.current = session.lastDirectCallerUserId;
  }, [session.lastDirectCallerUserId]);

  const renderConnectedStreamDeck = useCallback(
    async (options?: StreamDeckRenderRequest) => {
      const request = options || {};
      streamDeckPendingRenderRef.current = mergeStreamDeckRenderRequests(
        streamDeckPendingRenderRef.current,
        request,
      );
      if (streamDeckRenderInFlightRef.current) {
        return;
      }

      streamDeckRenderInFlightRef.current = true;
      try {
        while (streamDeckPendingRenderRef.current) {
          const nextRequest = streamDeckPendingRenderRef.current;
          streamDeckPendingRenderRef.current = null;

          const session = streamDeckHidSessionRef.current;
          const lastDirectCallerUserId = lastDirectCallerUserIdRef.current;
          const settings = streamDeckSettingsRef.current;
          const currentAppData = appDataRef.current;
          const listenRoomIds = listenRoomIdsRef.current;
          const activePresence = presenceRef.current;
          const attentionActive = incomingAttentionRef.current;
          const attentionPulseOn = streamDeckAttentionPulseOnRef.current;
          if (!session || !settings || !currentAppData) {
            break;
          }

          const listeningRoomIds = new Set(listenRoomIds);
          const buttonMap = new Map<number, StreamDeckRenderableButton>(
            getStreamDeckPageButtons(settings).map((rawButton) => [
              rawButton.index,
              {
                ...withResolvedStreamDeckButtonLabel(rawButton, {
                  rooms: currentAppData.rooms,
                  roles: currentAppData.roles,
                  users: currentAppData.users,
                  activeUsers: activePresence.map((entry) => ({
                    id: entry.userId,
                    username: entry.username,
                    roleId: entry.roleId,
                  })),
                  lastDirectCallerUserId,
                  broadcastGroups: currentAppData.broadcastGroups,
                }),
                isListening:
                  (rawButton.action?.type === "ptt_room" ||
                    rawButton.action?.type === "listen_room") &&
                  !!rawButton.action.roomId &&
                  listeningRoomIds.has(rawButton.action.roomId),
                attentionActive,
                attentionPulseOn,
              },
            ]),
          );
          const controls = session.deck.CONTROLS.filter(
            (control): control is StreamDeckButtonControlDefinition =>
              control.type === "button",
          );
          const targetControls =
            typeof nextRequest.buttonIndex === "number"
              ? controls.filter(
                  (control) => control.index === nextRequest.buttonIndex,
                )
              : controls;

          for (const control of targetControls) {
            const button =
              buttonMap.get(control.index) ?? ({ index: control.index } as StreamDeckRenderableButton);
            const pressed = session.pressedButtons.has(control.index);
            const signature = streamDeckButtonRenderSignature(
              settings.selectedPage,
              button,
              pressed,
            );

            if (!nextRequest.force) {
              const previous =
                streamDeckRenderedSignatureByIndexRef.current.get(control.index);
              if (previous === signature) {
                continue;
              }
            }

            await renderStreamDeckButton(session.deck, control, button, pressed);
            streamDeckRenderedSignatureByIndexRef.current.set(
              control.index,
              signature,
            );
          }
        }
      } catch (error) {
        setStreamDeckError(
          error instanceof Error
            ? error.message
            : "Failed to update Stream Deck display.",
        );
      } finally {
        streamDeckRenderInFlightRef.current = false;
      }
    },
    [],
  );

  const emitStreamDeckBridgeEvent = useCallback((payload: unknown) => {
    window.dispatchEvent(
      new CustomEvent(streamDeckButtonEventName, { detail: payload }),
    );
  }, []);

  const handleStreamDeckTestButtonEvent = useCallback(
    (event: { page: number; buttonIndex: number; state: "down" | "up" }) => {
      emitStreamDeckBridgeEvent({
        source: "kesher-streamdeck",
        type: "button",
        page: event.page,
        buttonIndex: event.buttonIndex,
        state: event.state,
      });
    },
    [emitStreamDeckBridgeEvent],
  );

  const disconnectStreamDeckWebHid = useCallback(
    async (options?: { announce?: boolean }) => {
      const session = streamDeckHidSessionRef.current;
      if (!session) return;
      const announce = options?.announce ?? true;
      streamDeckHidSessionRef.current = null;
      streamDeckPendingRenderRef.current = null;
      streamDeckRenderedSignatureByIndexRef.current.clear();

      try {
        session.deck.off("down", session.onDown);
      } catch {
        // Ignore listener cleanup errors.
      }
      try {
        session.deck.off("up", session.onUp);
      } catch {
        // Ignore listener cleanup errors.
      }
      try {
        session.deck.off("error", session.onError);
      } catch {
        // Ignore listener cleanup errors.
      }
      try {
        await session.deck.close();
      } catch {
        // Ignore close errors, state is already reset.
      }

      setStreamDeckConnected(false);
      setStreamDeckWebHidActive(false);
      if (announce) {
        emitStreamDeckBridgeEvent({
          source: "kesher-streamdeck",
          type: "connection",
          status: "disconnected",
          message: "WebHID disconnected",
        });
      }
    },
    [emitStreamDeckBridgeEvent],
  );

  const connectStreamDeckWebHid = useCallback(async () => {
    if (!streamDeckWebHidSupported) {
      setStreamDeckError("WebHID is not available in this browser.");
      return;
    }
    setStreamDeckWebHidBusy(true);
    setStreamDeckError("");
    try {
      await disconnectStreamDeckWebHid({ announce: false });

      const { getStreamDecks, requestStreamDecks } = await import(
        "@elgato-stream-deck/webhid"
      );
      const grantedDecks = await getStreamDecks();
      const deck = grantedDecks[0] ?? (await requestStreamDecks())[0];
      if (!deck) {
        setStreamDeckError(
          "No Stream Deck device was selected. Close Elgato Stream Deck or other apps that may be holding the device, then try again.",
        );
        return;
      }

      const pressedButtons = new Set<number>();

      const onDown = (
        control:
          | StreamDeckButtonControlDefinition
          | StreamDeckEncoderControlDefinition,
      ) => {
        if (control.type !== "button") return;
        pressedButtons.add(control.index);
        void renderConnectedStreamDeck({ buttonIndex: control.index });
        emitStreamDeckBridgeEvent({
          source: "kesher-streamdeck",
          type: "button",
          buttonIndex: control.index,
          state: "down",
        });
      };

      const onUp = (
        control:
          | StreamDeckButtonControlDefinition
          | StreamDeckEncoderControlDefinition,
      ) => {
        if (control.type !== "button") return;
        pressedButtons.delete(control.index);
        void renderConnectedStreamDeck({ buttonIndex: control.index });
        emitStreamDeckBridgeEvent({
          source: "kesher-streamdeck",
          type: "button",
          buttonIndex: control.index,
          state: "up",
        });
      };

      const onError = (error: unknown) => {
        setStreamDeckError(
          error instanceof Error
            ? error.message
            : "Stream Deck connection error.",
        );
      };

      deck.on("down", onDown);
      deck.on("up", onUp);
      deck.on("error", onError);
      streamDeckHidSessionRef.current = { deck, pressedButtons, onDown, onUp, onError };

      await deck.setBrightness(70);

      setStreamDeckWebHidActive(true);
      await renderConnectedStreamDeck({ force: true });
      emitStreamDeckBridgeEvent({
        source: "kesher-streamdeck",
        type: "connection",
        status: "connected",
        message: `WebHID connected: ${deck.PRODUCT_NAME || "Stream Deck"}`,
      });
    } catch (error) {
      setStreamDeckError(
        error instanceof Error
          ? error.message
          : "Failed to connect to Stream Deck via WebHID.",
      );
      setStreamDeckWebHidActive(false);
    } finally {
      setStreamDeckWebHidBusy(false);
    }
  }, [
    disconnectStreamDeckWebHid,
    emitStreamDeckBridgeEvent,
    renderConnectedStreamDeck,
    streamDeckWebHidSupported,
  ]);

  useEffect(() => {
    if (!streamDeckWebHidActive) return;
    void renderConnectedStreamDeck({ force: true });
  }, [
    renderConnectedStreamDeck,
    session.lastDirectCallerUserId,
    session.listenRoomIds,
    streamDeckSettings,
    streamDeckWebHidActive,
  ]);

  useEffect(() => {
    const hasIncomingAttention = !!session.incomingAttention;
    incomingAttentionRef.current = hasIncomingAttention;

    if (!hasIncomingAttention) {
      streamDeckAttentionPulseOnRef.current = false;
      if (streamDeckWebHidActive) {
        void renderConnectedStreamDeck({ force: true });
      }
      return;
    }

    streamDeckAttentionPulseOnRef.current = true;
    if (streamDeckWebHidActive) {
      void renderConnectedStreamDeck({ force: true });
    }

    const pulseInterval = window.setInterval(() => {
      streamDeckAttentionPulseOnRef.current =
        !streamDeckAttentionPulseOnRef.current;
      if (streamDeckWebHidActive) {
        void renderConnectedStreamDeck({ force: true });
      }
    }, 260);

    return () => {
      window.clearInterval(pulseInterval);
    };
  }, [
    renderConnectedStreamDeck,
    session.incomingAttention,
    streamDeckWebHidActive,
  ]);

  useEffect(() => {
    return () => {
      void disconnectStreamDeckWebHid({ announce: false });
    };
  }, [disconnectStreamDeckWebHid]);

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
        if (authMode === "operator") {
          settings.setRoleID(data.self.roleId);
        }
        session.applyBootstrapData(data, true);
      })
      .catch(() => {
        sessionStorage.removeItem(tokenStorageKey);
        setToken(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Stream Deck settings load ──
  useEffect(() => {
    if (!token || authMode !== "operator") {
      setStreamDeckSettings(null);
      setStreamDeckError("");
      setStreamDeckBusy(false);
      return;
    }
    let cancelled = false;
    setStreamDeckBusy(true);
    setStreamDeckError("");
    getStreamDeckSettings(token)
      .then((next) => {
        if (!cancelled) {
          setStreamDeckSettings(next);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStreamDeckSettings(localDefaultStreamDeckSettings());
          setStreamDeckError(
            err instanceof Error
              ? err.message
              : "Failed to load Stream Deck settings.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStreamDeckBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authMode, token]);

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
  async function doLogin(
    overrideUsername?: string,
    overrideRoleId?: string,
    targetAuthMode: "operator" | "admin" = "operator",
  ): Promise<boolean> {
    const useUsername =
      typeof overrideUsername === "string"
        ? overrideUsername
        : settings.username.trim();
    const useRoleId =
      typeof overrideRoleId === "string" ? overrideRoleId : settings.roleId;
    const res = await login(useUsername, useRoleId);
    if ("requiresTakeover" in res) {
      const conflictLabel = res.conflictRoleName || res.conflictRoleId;
      const conflictUser = res.conflictUsername
        ? ` Bereits aktiv: ${res.conflictUsername}.`
        : "";
      const conflictMessage = `Die Rolle ${conflictLabel} ist bereits angemeldet.${conflictUser}`;
      if (targetAuthMode === "admin") {
        setAdminLoginError(conflictMessage);
      } else {
        setOperatorLoginError(conflictMessage);
      }
      setPendingTakeover({
        username: useUsername,
        roleId: useRoleId,
        conflict: res,
        targetAuthMode,
        adminOverrideActive: targetAuthMode === "admin",
      });
      return false;
    }
    setOperatorLoginError("");
    setAdminLoginError("");
    setPendingTakeover(null);
    sessionStorage.setItem(tokenStorageKey, res.token);
    setToken(res.token);
    return true;
  }

  async function handleOperatorLogin() {
    setAuthMode("operator");
    setAdminLoginError("");
    setOperatorLoginError("");
    setPendingTakeover(null);
    try {
      await doLogin(undefined, undefined, "operator");
    } catch (error) {
      setOperatorLoginError(
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
    setAuthMode("admin");
    try {
      const res = await adminLogin(adminPinInput.trim());
      setPendingTakeover(null);
      setOperatorLoginError("");
      sessionStorage.setItem(tokenStorageKey, res.token);
      setToken(res.token);
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
    setOperatorLoginError("");
    setAdminOverrideActive(false);
    setPendingTakeover(null);
    setToken(null);
    setAppData(null);
  }

  async function handleConfirmTakeover() {
    if (!pendingTakeover) return;
    setAdminLoginError("");
    setOperatorLoginError("");
    try {
      const res = await loginTakeover(
        pendingTakeover.username,
        pendingTakeover.roleId,
      );
      setPendingTakeover(null);
      setAuthMode(pendingTakeover.targetAuthMode);
      setAdminOverrideActive(pendingTakeover.adminOverrideActive);
      sessionStorage.setItem(tokenStorageKey, res.token);
      setToken(res.token);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Takeover failed.";
      if (pendingTakeover.targetAuthMode === "admin") {
        setAdminLoginError(message);
      } else {
        setOperatorLoginError(message);
      }
    }
  }

  async function refreshBootstrapData() {
    if (!token) return;
    const data = await bootstrap(token);
    setAppData(data);
    if (authMode === "operator") {
      settings.setRoleID(data.self.roleId);
    }
    setPublicData({
      roles: data.roles,
      rooms: data.rooms,
      broadcastGroups: data.broadcastGroups,
      ackEnabled: data.ackEnabled,
      appVersion: data.appVersion,
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

  useEffect(() => {
    if (!token || authMode !== "operator") {
      void disconnectStreamDeckWebHid({ announce: false });
      setStreamDeckConnected(false);
      setStreamDeckWebHidActive(false);
      setStreamDeckLastEvent("");
      return;
    }

    const handleBridgeAction = (
      payload: ReturnType<typeof parseStreamDeckBridgeEvent>,
    ) => {
      if (!payload) return;
      if (payload.kind === "connection") {
        setStreamDeckConnected(payload.connected);
        if (payload.message) {
          setStreamDeckLastEvent(payload.message);
        }
        return;
      }

      const streamDeckCfg = streamDeckSettingsRef.current;
      const currentAppData = appData;
      if (!streamDeckCfg || !currentAppData) return;
      const effectivePage =
        typeof payload.page === "number"
          ? payload.page
          : streamDeckCfg.selectedPage;
      const action = resolveStreamDeckButtonAction(
        streamDeckCfg,
        effectivePage,
        payload.buttonIndex,
      );

      const roleId = currentAppData.self.roleId;
      const isRoomTalkAllowed = (roomId: string): boolean => {
        const room = currentAppData.rooms.find((entry) => entry.id === roomId);
        return !!room && roleAllowed(room.senderRoleIds, roleId);
      };
      const isRoomListenAllowed = (roomId: string): boolean => {
        const room = currentAppData.rooms.find((entry) => entry.id === roomId);
        return !!room && roleAllowed(room.receiverRoleIds, roleId);
      };
      const isBroadcastActionAllowed = (groupId: string): boolean => {
        const group = currentAppData.broadcastGroups.find(
          (entry) => entry.id === groupId,
        );
        if (!group) return false;
        const allowedRoleIds = Array.isArray(group.allowedRoleIds)
          ? group.allowedRoleIds
          : [];
        const roleAllowedForGroup =
          allowedRoleIds.length === 0 || allowedRoleIds.includes(roleId);
        if (!roleAllowedForGroup) return false;
        return group.roomIds.some((roomId) => isRoomTalkAllowed(roomId));
      };
      const isDirectToRoleAllowed = (targetRoleId: string): boolean => {
        if (!targetRoleId) return false;
        return currentAppData.rooms.some(
          (room) =>
            roleAllowed(room.senderRoleIds, roleId) &&
            roleAllowed(room.receiverRoleIds, targetRoleId),
        );
      };
      const isDirectToUserAllowed = (targetUserId: string): boolean => {
        const targetUser = currentAppData.users.find(
          (user) => user.id === targetUserId,
        );
        if (!targetUser) return false;
        if (targetUser.id === currentAppData.self.id) return false;
        return isDirectToRoleAllowed(targetUser.roleId);
      };

      setStreamDeckConnected(true);
      setStreamDeckLastEvent(
        `P${effectivePage + 1}/B${payload.buttonIndex + 1} ${payload.state}`,
      );

      if (!action) return;

      if (action.type === "none") return;
      if (action.type === "mute_toggle") {
        if (payload.state === "down") {
          session.setAlwaysOn(session.voiceModeRef.current !== "always_on");
        }
        return;
      }
      if (action.type === "volume_delta") {
        if (payload.state === "down") {
          const delta = action.volumeDelta || 0;
          if (delta !== 0) {
            const currentGain = settings.selectedInputGainFor(
              settings.selectedInputDeviceId,
            );
            settings.onInputGainChange(
              settings.selectedInputDeviceId,
              gainWithDbDelta(currentGain, delta),
            );
          }
        }
        return;
      }
      if (action.type === "page_up" || action.type === "page_down") {
        if (payload.state !== "down") {
          return;
        }
        setStreamDeckSettings((prev) => {
          if (!prev || prev.pages.length === 0) {
            return prev;
          }
          const pageOrder = prev.pages
            .map((entry) => entry.page)
            .sort((a, b) => a - b);
          if (pageOrder.length === 0) {
            return prev;
          }
          const currentIndex = pageOrder.findIndex(
            (pageNo) => pageNo === prev.selectedPage,
          );
          const safeIndex = currentIndex >= 0 ? currentIndex : 0;
          const offset = action.type === "page_up" ? 1 : -1;
          const nextIndex = Math.max(
            0,
            Math.min(pageOrder.length - 1, safeIndex + offset),
          );
          const nextPage = pageOrder[nextIndex];
          if (nextPage === undefined || nextPage === prev.selectedPage) {
            return prev;
          }
          setStreamDeckLastEvent(
            `P${safeIndex + 1} -> P${nextIndex + 1} (${action.type === "page_up" ? "page up" : "page down"})`,
          );
          return {
            ...prev,
            selectedPage: nextPage,
          };
        });
        return;
      }
      if (action.type === "ptt_room" && action.roomId) {
        if (payload.state === "down" && !isRoomTalkAllowed(action.roomId)) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        if (payload.state === "down") {
          session.handleChannelPttStart(action.roomId);
        } else {
          session.handleChannelPttStop(action.roomId);
        }
        return;
      }
      if (action.type === "select_talk_room" && action.roomId) {
        if (payload.state !== "down") {
          return;
        }
        if (!isRoomTalkAllowed(action.roomId)) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        session.toggleTalkRoom(action.roomId);
        return;
      }
      if (action.type === "ptt_selected") {
        const selectedTalkRooms = session.talkRoomIds;
        const hasAllowedSelection = selectedTalkRooms.some((roomId) =>
          isRoomTalkAllowed(roomId),
        );
        if (!hasAllowedSelection) {
          if (payload.state === "down") {
            setStreamDeckLastEvent(
              `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
            );
          }
          return;
        }
        if (payload.state === "down") {
          session.startPtt();
        } else {
          session.stopPtt();
        }
        return;
      }
      if (action.type === "listen_room" && action.roomId) {
        if (payload.state !== "down") {
          return;
        }
        if (!isRoomListenAllowed(action.roomId)) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        session.toggleListenRoom(action.roomId);
        return;
      }
      if (action.type === "call_room" && action.roomId) {
        if (payload.state !== "down") {
          return;
        }
        if (!isRoomTalkAllowed(action.roomId)) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        session.sendScopedSignal("room", action.roomId, "call");
        return;
      }
      if (action.type === "direct_role" && action.roleId) {
        const buttonKey = `${effectivePage}:${payload.buttonIndex}`;
        if (payload.state === "down") {
          if (!isDirectToRoleAllowed(action.roleId)) {
            setStreamDeckLastEvent(
              `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
            );
            return;
          }
          const candidates = session.presence
            .filter(
              (entry) =>
                entry.userId !== currentAppData.self.id &&
                entry.roleId === action.roleId &&
                isDirectToUserAllowed(entry.userId),
            )
            .sort((a, b) => a.username.localeCompare(b.username));
          const chosen = candidates[0];
          if (!chosen) {
            setStreamDeckLastEvent(
              `P${effectivePage + 1}/B${payload.buttonIndex + 1} no active user in role`,
            );
            return;
          }
          streamDeckPressedRoleTargetsRef.current.set(buttonKey, chosen.userId);
          session.startDirectPtt(chosen.userId);
        } else {
          const targetUserId =
            streamDeckPressedRoleTargetsRef.current.get(buttonKey);
          if (targetUserId) {
            session.stopDirectPtt(targetUserId);
            streamDeckPressedRoleTargetsRef.current.delete(buttonKey);
          }
        }
        return;
      }
      if (action.type === "direct_user" && action.userId) {
        if (payload.state === "down" && !isDirectToUserAllowed(action.userId)) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        if (payload.state === "down") {
          session.startDirectPtt(action.userId);
        } else {
          session.stopDirectPtt(action.userId);
        }
        return;
      }
      if (action.type === "reply_to_caller") {
        const callerId = session.lastDirectCallerUserId;
        if (!callerId) return;
        if (payload.state === "down" && !isDirectToUserAllowed(callerId)) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        if (payload.state === "down") {
          session.startDirectPtt(callerId);
        } else {
          session.stopDirectPtt(callerId);
        }
        return;
      }
      if (action.type === "broadcast_ptt" && action.broadcastGroupId) {
        if (
          payload.state === "down" &&
          !isBroadcastActionAllowed(action.broadcastGroupId)
        ) {
          setStreamDeckLastEvent(
            `P${effectivePage + 1}/B${payload.buttonIndex + 1} NOT ALLOW`,
          );
          return;
        }
        if (payload.state === "down") {
          session.startBroadcastPtt(action.broadcastGroupId);
        } else {
          session.stopBroadcastPtt(action.broadcastGroupId);
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      const payload = event.data as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object") return;
      const type = typeof payload.type === "string" ? payload.type : "";
      if (type !== "button" && type !== "key" && type !== "connection") {
        return;
      }
      const parsed = parseStreamDeckBridgeEvent(event.data);
      handleBridgeAction(parsed);
    };
    const onBridgeButtonEvent = (event: Event) => {
      const custom = event as CustomEvent<unknown>;
      const parsed = parseStreamDeckBridgeEvent(custom.detail);
      handleBridgeAction(parsed);
    };

    window.addEventListener("message", onMessage);
    window.addEventListener(streamDeckButtonEventName, onBridgeButtonEvent);

    return () => {
      streamDeckPressedRoleTargetsRef.current.clear();
      window.removeEventListener("message", onMessage);
      window.removeEventListener(
        streamDeckButtonEventName,
        onBridgeButtonEvent,
      );
    };
  }, [appData, authMode, disconnectStreamDeckWebHid, session, settings, token]);

  useEffect(() => {
    if (!showDebug) {
      delete window.__kesherStreamDeckDev;
      return;
    }
    window.__kesherStreamDeckDev = createStreamDeckDevTools(window);
    return () => {
      delete window.__kesherStreamDeckDev;
    };
  }, [showDebug]);

  const handleStreamDeckSettingsChange = useCallback(
    (next: StreamDeckSettings) => {
      setStreamDeckSettings(next);
      setStreamDeckError("");
    },
    [],
  );

  const handleSaveStreamDeckSettings = useCallback(async () => {
    if (!token || !streamDeckSettings) return;
    setStreamDeckBusy(true);
    setStreamDeckError("");
    try {
      const saved = await updateStreamDeckSettings(token, streamDeckSettings);
      setStreamDeckSettings(saved);
    } catch (err) {
      setStreamDeckError(
        err instanceof Error ? err.message : "Failed to save Stream Deck settings.",
      );
    } finally {
      setStreamDeckBusy(false);
    }
  }, [streamDeckSettings, token]);

  const handleResetStreamDeckSettings = useCallback(async () => {
    if (!token) return;
    setStreamDeckBusy(true);
    setStreamDeckError("");
    try {
      const reset = await resetStreamDeckSettings(token);
      setStreamDeckSettings(reset);
    } catch (err) {
      setStreamDeckError(
        err instanceof Error ? err.message : "Failed to reset Stream Deck settings.",
      );
    } finally {
      setStreamDeckBusy(false);
    }
  }, [token]);

  const handlePublishUserCompanionProfile = useCallback(async () => {
    if (!token) {
      throw new Error("Not authenticated.");
    }
    return publishUserCompanionProfile(token);
  }, [token]);

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
        loginError={operatorLoginError}
        adminError={adminLoginError}
        takeoverConflict={pendingTakeover?.conflict ?? null}
        onConfirmTakeover={() => void handleConfirmTakeover()}
        onCancelTakeover={() => {
          setPendingTakeover(null);
          setOperatorLoginError("");
          setAdminLoginError("");
          setAdminOverrideActive(false);
        }}
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
  const activeUsersForChat = Array.from(
    new Map(
      [
        ...appData.users
          .filter((u) => u.id !== appData.self.id)
          .map((u) => ({
            userId: u.id,
            username: u.username,
            roleId: u.roleId,
            roleName: roleNameById.get(u.roleId) || u.roleId,
            isWebOnline: false,
          })),
        ...session.presence
          .filter((p) => p.userId !== appData.self.id)
          .map((p) => ({
            userId: p.userId,
            username: p.username,
            roleId: p.roleId,
            roleName: roleNameById.get(p.roleId) || p.roleId,
            isWebOnline: true,
          })),
      ].map((u) => [u.username.toLowerCase(), u]),
    ).values(),
  ).sort((a, b) => a.username.localeCompare(b.username));

  const chatAndSignalBlock = (
    <ChatSignalPanel
      message={session.message}
      onMessageChange={session.setMessage}
      onSendChat={session.sendChat}
      onAcknowledge={session.acknowledgeChatMessage}
      showAckOption={appData.ackEnabled}
      chatMessages={session.chatMessages}
      listenRoomIds={session.listenRoomIds}
      rooms={appData.rooms.map((room) => ({ id: room.id, name: room.name }))}
      roles={appData.roles.map((role) => ({ id: role.id, name: role.name }))}
      activeUsers={activeUsersForChat}
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
    "No party line selected";

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
        token={token}
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
        lastCompanionCommand={session.lastCompanionCommand}
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
        swapPttAndReplyButtons={settings.swapPttAndReplyButtons}
        onSwapPttAndReplyButtonsChange={settings.setSwapPttAndReplyButtons}
        enableBackgroundAudioRecovery={settings.enableBackgroundAudioRecovery}
        onEnableBackgroundAudioRecoveryChange={
          settings.setEnableBackgroundAudioRecovery
        }
        keepScreenAwake={settings.keepScreenAwake}
        onKeepScreenAwakeChange={settings.setKeepScreenAwake}
        showVolumeControls={settings.showVolumeControls}
        onShowVolumeControlsChange={settings.setShowVolumeControls}
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
        streamDeckSettings={streamDeckSettings}
        streamDeckBusy={streamDeckBusy}
        streamDeckError={streamDeckError}
        onStreamDeckSettingsChange={handleStreamDeckSettingsChange}
        onSaveStreamDeckSettings={() => void handleSaveStreamDeckSettings()}
        onResetStreamDeckSettings={() => void handleResetStreamDeckSettings()}
        onPublishCompanionProfile={handlePublishUserCompanionProfile}
        streamDeckWebHidSupported={streamDeckWebHidSupported}
        streamDeckWebHidActive={streamDeckWebHidActive}
        streamDeckWebHidBusy={streamDeckWebHidBusy}
        onConnectStreamDeckWebHid={() => void connectStreamDeckWebHid()}
        onDisconnectStreamDeckWebHid={() =>
          void disconnectStreamDeckWebHid({ announce: true })
        }
        streamDeckBridgeConnected={streamDeckConnected}
        streamDeckBridgeLastEvent={streamDeckLastEvent}
        onStreamDeckTestButtonEvent={handleStreamDeckTestButtonEvent}
      />
      {attentionFlashOverlay}
    </>
  );
}
