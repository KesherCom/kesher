import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Bootstrap,
  BroadcastGroup,
  CompanionProfileResponse,
  Presence,
  StreamDeckActionType,
  StreamDeckButtonConfig,
  StreamDeckPageType,
  StreamDeckSettings,
} from "../types";
import type { KeyboardShortcutSettings } from "../app/settings";
import { renderStreamDeckPreviewImages } from "../api";
import { createHoldButtonProps } from "../lib/holdButton";
import { withResolvedStreamDeckButtonLabel } from "../lib/streamDeckLabels";
import { sortDirectUsersByRoleAndUsername } from "../lib/users";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";

const DB_MIN = -60;
const OUTPUT_DB_MAX = 6; // +6 dB ~ gain 2.0
const INPUT_DB_MAX = 18; // +18 dB ~ gain 7.94
const MUTE_POS = DB_MIN - 1; // sentinel slider position for mute

/** Slider position (dB) -> linear gain. Bottom-of-slider = mute. */
function sliderToGain(sliderDb: number, dbMax = OUTPUT_DB_MAX): number {
  if (sliderDb <= MUTE_POS) return 0;
  return Math.pow(10, Math.max(DB_MIN, Math.min(dbMax, sliderDb)) / 20);
}

/** Linear gain -> slider position (dB). */
function gainToSlider(gain: number, dbMax = OUTPUT_DB_MAX): number {
  if (gain <= 0) return MUTE_POS;
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return MUTE_POS;
  return Math.round(Math.max(DB_MIN, Math.min(dbMax, db)));
}

/** Gain -> display label like "+6 db", "0 db", "-inf". */
function gainToDbLabel(gain: number, dbMax = OUTPUT_DB_MAX): string {
  if (gain <= 0) return "-\u221E";
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return "-\u221E";
  const r = Math.round(Math.max(DB_MIN, Math.min(dbMax, db)));
  if (r === 0) return "0 db";
  return `${r > 0 ? "+" : ""}${r} db`;
}

/** Slider fill percentage for CSS background gradient. */
function sliderFillPercent(gain: number, dbMax = OUTPUT_DB_MAX): number {
  const pos = gainToSlider(gain, dbMax);
  return ((pos - MUTE_POS) / (dbMax - MUTE_POS)) * 100;
}

const METER_DBFS_MIN = -60;
const STREAM_DECK_IMPORT_FORMAT = "kesher-user-streamdeck";
const STREAM_DECK_IMPORT_SCHEMA_VERSION = 1;

type StreamDeckImportDocument = {
  meta?: {
    format?: string;
    schemaVersion?: number;
    exportedAt?: string;
    username?: string;
  };
  settings?: unknown;
};

function normalizeImportedStreamDeckSettings(input: unknown): StreamDeckSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : null;
  if (!pagesRaw || pagesRaw.length === 0) {
    throw new Error("Import failed: settings.pages must be a non-empty array.");
  }
  const gridColumns = Number(raw.gridColumns);
  const gridRows = Number(raw.gridRows);
  if (gridColumns !== 5 || gridRows !== 3) {
    throw new Error("Import failed: only 5x3 Stream Deck layouts are supported.");
  }

  const selectedPage = Number(raw.selectedPage);
  if (!Number.isInteger(selectedPage) || selectedPage < 0) {
    throw new Error("Import failed: selectedPage must be a non-negative integer.");
  }

  const actionTypes = new Set<StreamDeckActionType>([
    "none",
    "ptt_room",
    "select_talk_room",
    "select_listen_room",
    "ptt_selected",
    "listen_room",
    "call_room",
    "direct_user",
    "direct_role",
    "reply_to_caller",
    "incoming_call_indicator",
    "broadcast_ptt",
    "mute_toggle",
    "volume_delta",
    "page_up",
    "page_down",
    "page_jump",
    "page_home",
    "page_back",
  ]);

  const normalizedPages = pagesRaw.map((pageEntry) => {
    const pageRaw = (pageEntry ?? {}) as Record<string, unknown>;
    const page = Number(pageRaw.page);
    const buttonsRaw = Array.isArray(pageRaw.buttons) ? pageRaw.buttons : null;
    if (!Number.isInteger(page) || page < 0 || !buttonsRaw || buttonsRaw.length !== 15) {
      throw new Error("Import failed: each page must have a valid page id and exactly 15 buttons.");
    }
    const seenIndices = new Set<number>();
    const buttons = buttonsRaw.map((buttonEntry) => {
      const buttonRaw = (buttonEntry ?? {}) as Record<string, unknown>;
      const index = Number(buttonRaw.index);
      if (!Number.isInteger(index) || index < 0 || index >= 15 || seenIndices.has(index)) {
        throw new Error("Import failed: button indices must be unique integers from 0 to 14.");
      }
      seenIndices.add(index);

      const actionRaw = buttonRaw.action as Record<string, unknown> | undefined;
      if (!actionRaw) {
        return {
          index,
          label: typeof buttonRaw.label === "string" ? buttonRaw.label : "",
          color: typeof buttonRaw.color === "string" ? buttonRaw.color : "",
        };
      }

      const type = actionRaw.type;
      if (typeof type !== "string" || !actionTypes.has(type as StreamDeckActionType)) {
        throw new Error("Import failed: unsupported button action type.");
      }

      return {
        index,
        label: typeof buttonRaw.label === "string" ? buttonRaw.label : "",
        color: typeof buttonRaw.color === "string" ? buttonRaw.color : "",
        action: {
          type: type as StreamDeckActionType,
          roomId: typeof actionRaw.roomId === "string" ? actionRaw.roomId : undefined,
          userId: typeof actionRaw.userId === "string" ? actionRaw.userId : undefined,
          roleId: typeof actionRaw.roleId === "string" ? actionRaw.roleId : undefined,
          broadcastGroupId:
            typeof actionRaw.broadcastGroupId === "string"
              ? actionRaw.broadcastGroupId
              : undefined,
          volumeDelta:
            typeof actionRaw.volumeDelta === "number" && Number.isFinite(actionRaw.volumeDelta)
              ? actionRaw.volumeDelta
              : undefined,
          targetPage:
            typeof actionRaw.targetPage === "number" && Number.isFinite(actionRaw.targetPage)
              ? actionRaw.targetPage
              : undefined,
        },
      };
    });

    const pageTypeCandidate =
      typeof pageRaw.pageType === "string" ? pageRaw.pageType : "manual";
    const pageType =
      pageTypeCandidate === "all_roles" || pageTypeCandidate === "all_party_lines"
        ? (pageTypeCandidate as StreamDeckPageType)
        : ("manual" as StreamDeckPageType);
    const parentPage = Number(pageRaw.parentPage);

    return {
      page,
      title: typeof pageRaw.title === "string" ? pageRaw.title : "",
      pageType,
      parentPage: Number.isInteger(parentPage) && parentPage >= 0 ? parentPage : undefined,
      buttons,
    };
  });

  if (!normalizedPages.some((entry) => entry.page === selectedPage)) {
    throw new Error("Import failed: selectedPage does not exist in pages.");
  }

  return {
    version:
      typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version > 0
        ? raw.version
        : 1,
    gridColumns,
    gridRows,
    selectedPage,
    pages: normalizedPages,
  };
}

function parseStreamDeckImportDocument(text: string): StreamDeckSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Import failed: invalid JSON.");
  }

  const doc = (parsed ?? {}) as StreamDeckImportDocument;
  if (doc && typeof doc === "object" && doc.settings !== undefined) {
    const format = doc.meta?.format;
    const schemaVersion = doc.meta?.schemaVersion;
    if (format && format !== STREAM_DECK_IMPORT_FORMAT) {
      throw new Error(`Import failed: expected format ${STREAM_DECK_IMPORT_FORMAT}.`);
    }
    if (
      typeof schemaVersion === "number" &&
      schemaVersion !== STREAM_DECK_IMPORT_SCHEMA_VERSION
    ) {
      throw new Error("Import failed: unsupported schemaVersion.");
    }
    return normalizeImportedStreamDeckSettings(doc.settings);
  }

  // Backward-compatible fallback: allow raw StreamDeckSettings JSON.
  return normalizeImportedStreamDeckSettings(parsed);
}

function createEmptyStreamDeckButtons(count: number) {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

function cloneStreamDeckButtonConfig(
  button: StreamDeckButtonConfig,
): StreamDeckButtonConfig {
  return {
    ...button,
    action: button.action ? { ...button.action } : undefined,
  };
}

function cloneStreamDeckSettings(settings: StreamDeckSettings): StreamDeckSettings {
  return {
    ...settings,
    pages: settings.pages.map((page) => ({
      ...page,
      buttons: page.buttons.map((button) => cloneStreamDeckButtonConfig(button)),
    })),
  };
}

function streamDeckPreviewSignature(
  button: StreamDeckButtonConfig & {
    isListening?: boolean;
    isPttSelected?: boolean;
  },
  pressed: boolean,
): string {
  const action = button.action;
  return [
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
    button.isPttSelected ? "1" : "0",
    pressed ? "1" : "0",
  ].join("|");
}

function splitStreamDeckLabel(label?: string): { primary: string; subtitle: string } {
  const text = (label ?? "").trim();
  if (!text) {
    return { primary: "", subtitle: "" };
  }
  const parts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    primary: parts[0] ?? "",
    subtitle: parts[1] ?? "",
  };
}

function meterDbFsToPercent(dbFs: number): number {
  const clamped = Math.max(METER_DBFS_MIN, Math.min(0, dbFs));
  return ((clamped - METER_DBFS_MIN) / (0 - METER_DBFS_MIN)) * 100;
}

function formatDbFs(dbFs: number): string {
  if (!Number.isFinite(dbFs) || dbFs <= METER_DBFS_MIN) return "-inf dBFS";
  if (Math.abs(dbFs) < 0.05) return "0.0 dBFS";
  return `${dbFs.toFixed(1)} dBFS`;
}

function formatGateThresholdDb(dbFs: number): string {
  return `${Math.round(dbFs)} dBFS`;
}

type StationIntercomViewProps = {
  token: string;
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  appData: Bootstrap;
  doLogout: () => void;
  listenRoomIds: string[];
  talkRoomIds: string[];
  canRoleSendToRoom: (roomId: string, currentRoleId: string) => boolean;
  canRoleReceiveFromRoom: (roomId: string, currentRoleId: string) => boolean;
  toggleTalkRoom: (roomId: string) => void;
  toggleListenRoom: (roomId: string) => void;
  isReceivingRoom: (roomId: string) => boolean;
  isReceivingBroadcast: (groupId: string) => boolean;
  isReceivingDirect: (userId: string) => boolean;
  broadcastPttPressed: string | null;
  startBroadcastPtt: (groupId: string) => void;
  stopBroadcastPtt: (groupId: string) => void;
  broadcastGroups: BroadcastGroup[];
  presence: Presence[];
  roomListenerCounts: Record<string, number>;
  roleNameById: Map<string, string>;
  lastDirectCallerUserId: string | null;
  directPttPressedUserId: string | null;
  startDirectPtt: (userId: string) => void;
  stopDirectPtt: (userId: string) => void;
  sendScopedSignal: (
    scopeValue: "direct" | "room" | "broadcast",
    scopedTargetId: string,
    signal: string,
  ) => void;
  pttPressed: boolean;
  startPtt: () => void;
  stopPtt: () => void;
  voiceMode: "always_on" | "ptt";
  setAlwaysOn: (enabled: boolean) => void;
  chatAndSignalPanel: React.ReactNode;
  showDebug: boolean;
  realtimeDebugBlock: React.ReactNode;
  enableDirectPpt: boolean;
  onEnableDirectPptChange: (enabled: boolean) => void;
  enableDirectTabs: boolean;
  onEnableDirectTabsChange: (enabled: boolean) => void;
  swapPttAndReplyButtons: boolean;
  onSwapPttAndReplyButtonsChange: (enabled: boolean) => void;
  enableBackgroundAudioRecovery: boolean;
  onEnableBackgroundAudioRecoveryChange: (enabled: boolean) => void;
  keepScreenAwake: boolean;
  onKeepScreenAwakeChange: (enabled: boolean) => void;
  showVolumeControls: boolean;
  onShowVolumeControlsChange: (enabled: boolean) => void;
  mediaSessionSupported: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  isStandaloneDisplayMode: boolean;
  onChannelPptStart: (channelId: string) => void;
  onChannelPptStop: (channelId: string) => void;
  pptPressedChannelId: string | null;
  pinnedRoomIds: string[];
  pinnedUserIds: string[];
  showPinnedOnly: boolean;
  onTogglePinnedRoom: (roomId: string) => void;
  onTogglePinnedUser: (userId: string) => void;
  onShowPinnedOnlyChange: (value: boolean) => void;
  isUserSettingsOpen: boolean;
  setIsUserSettingsOpen: (value: boolean) => void;
  roomGainById: Record<string, number>;
  directGainByUserId: Record<string, number>;
  onRoomGainChange: (roomId: string, gain: number) => void;
  onDirectGainChange: (userId: string, gain: number) => void;
  // Keyboard shortcuts
  keyboardShortcuts: KeyboardShortcutSettings;
  onKeyboardShortcutsChange: (next: KeyboardShortcutSettings) => void;
  onRecordingShortcutChange: (recording: boolean) => void;
  // Audio device props
  inputDevices: MediaDeviceInfo[];
  selectedInputDeviceId: string;
  selectedMicLabel: string;
  setSelectedInputDeviceId: (value: string) => void;
  inputLevelDbFs: number;
  inputGain: number;
  inputClipping: boolean;
  isLocalMonitorActive: boolean;
  onToggleLocalMonitor: () => void;
  onInputGainChange: (deviceId: string, gain: number) => void;
  audioGateEnabled: boolean;
  onAudioGateEnabledChange: (enabled: boolean) => void;
  audioGateThresholdDb: number;
  onAudioGateThresholdDbChange: (db: number) => void;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  selectedOutputLabel: string;
  outputSelectionSupported: boolean;
  setSelectedOutputDeviceId: (value: string) => void;
  streamDeckSettings: StreamDeckSettings | null;
  streamDeckBusy: boolean;
  streamDeckError: string;
  onStreamDeckSettingsChange: (next: StreamDeckSettings) => void;
  onSaveStreamDeckSettings: () => void;
  onResetStreamDeckSettings: () => void;
  onPublishCompanionProfile: () => Promise<CompanionProfileResponse>;
  streamDeckWebHidSupported: boolean;
  streamDeckWebHidActive: boolean;
  streamDeckWebHidBusy: boolean;
  onConnectStreamDeckWebHid: () => void;
  onDisconnectStreamDeckWebHid: () => void;
  streamDeckBridgeConnected: boolean;
  streamDeckBridgeLastEvent: string;
  lastCompanionCommand: {
    command: string;
    status: "executing" | "executed" | "rejected" | "failed";
    error?: string;
    at: number;
  } | null;
  onStreamDeckTestButtonEvent: (event: {
    page: number;
    buttonIndex: number;
    state: "down" | "up";
  }) => void;
};

export function StationIntercomView({
  token,
  connectionState,
  appData,
  doLogout,
  listenRoomIds,
  talkRoomIds,
  canRoleSendToRoom,
  canRoleReceiveFromRoom,
  toggleTalkRoom,
  toggleListenRoom,
  isReceivingRoom,
  isReceivingBroadcast,
  isReceivingDirect,
  broadcastPttPressed,
  startBroadcastPtt,
  stopBroadcastPtt,
  broadcastGroups,
  presence,
  roomListenerCounts,
  roleNameById,
  lastDirectCallerUserId,
  directPttPressedUserId,
  startDirectPtt,
  stopDirectPtt,
  sendScopedSignal,
  pttPressed,
  startPtt,
  stopPtt,
  voiceMode,
  setAlwaysOn,
  chatAndSignalPanel,
  showDebug,
  realtimeDebugBlock,
  enableDirectPpt,
  onEnableDirectPptChange,
  enableDirectTabs,
  onEnableDirectTabsChange,
  swapPttAndReplyButtons,
  onSwapPttAndReplyButtonsChange,
  enableBackgroundAudioRecovery,
  onEnableBackgroundAudioRecoveryChange,
  keepScreenAwake,
  onKeepScreenAwakeChange,
  showVolumeControls,
  onShowVolumeControlsChange,
  mediaSessionSupported,
  wakeLockSupported,
  wakeLockActive,
  isStandaloneDisplayMode,
  onChannelPptStart,
  onChannelPptStop,
  pptPressedChannelId,
  pinnedRoomIds,
  pinnedUserIds,
  showPinnedOnly,
  onTogglePinnedRoom,
  onTogglePinnedUser,
  onShowPinnedOnlyChange,
  isUserSettingsOpen,
  setIsUserSettingsOpen,
  roomGainById,
  directGainByUserId,
  onRoomGainChange,
  onDirectGainChange,
  keyboardShortcuts,
  onKeyboardShortcutsChange,
  onRecordingShortcutChange,
  inputDevices,
  selectedInputDeviceId,
  selectedMicLabel,
  setSelectedInputDeviceId,
  inputLevelDbFs,
  inputGain,
  inputClipping,
  isLocalMonitorActive,
  onToggleLocalMonitor,
  onInputGainChange,
  audioGateEnabled,
  onAudioGateEnabledChange,
  audioGateThresholdDb,
  onAudioGateThresholdDbChange,
  outputDevices,
  selectedOutputDeviceId,
  selectedOutputLabel,
  outputSelectionSupported,
  setSelectedOutputDeviceId,
  streamDeckSettings,
  streamDeckBusy,
  streamDeckError,
  onStreamDeckSettingsChange,
  onSaveStreamDeckSettings,
  onResetStreamDeckSettings,
  onPublishCompanionProfile,
  streamDeckWebHidSupported,
  streamDeckWebHidActive,
  streamDeckWebHidBusy,
  onConnectStreamDeckWebHid,
  onDisconnectStreamDeckWebHid,
  streamDeckBridgeConnected,
  streamDeckBridgeLastEvent,
  lastCompanionCommand,
  onStreamDeckTestButtonEvent,
}: StationIntercomViewProps) {
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [isOutputMenuOpen, setIsOutputMenuOpen] = useState(false);
  const micMenuRef = useRef<HTMLDivElement>(null);
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const [isAudioOpen, setIsAudioOpen] = useState(false);
  const [isStreamDeckOpen, setIsStreamDeckOpen] = useState(false);
  const [streamDeckTestMode, setStreamDeckTestMode] = useState(false);
  const streamDeckImportInputRef = useRef<HTMLInputElement>(null);
  const [streamDeckTransferMessage, setStreamDeckTransferMessage] = useState("");
  const [streamDeckTransferError, setStreamDeckTransferError] = useState("");
  const [companionPublishBusy, setCompanionPublishBusy] = useState(false);
  const [streamDeckPreviewPressedIndexes, setStreamDeckPreviewPressedIndexes] =
    useState<number[]>([]);
  const [activeDirectTab, setActiveDirectTab] = useState<string>("all");
  const [streamDeckSelectedButtonIndex, setStreamDeckSelectedButtonIndex] =
    useState(0);
  const [streamDeckClipboardButton, setStreamDeckClipboardButton] = useState<
    StreamDeckButtonConfig | null
  >(null);
  const [streamDeckDragSourceIndex, setStreamDeckDragSourceIndex] = useState<
    number | null
  >(null);
  const [streamDeckDropTargetIndex, setStreamDeckDropTargetIndex] = useState<
    number | null
  >(null);
  const [streamDeckUndoStack, setStreamDeckUndoStack] = useState<
    StreamDeckSettings[]
  >([]);
  const streamDeckPreviewCacheRef = useRef<
    Map<number, { signature: string; dataUrl: string }>
  >(new Map());

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        micMenuRef.current &&
        !micMenuRef.current.contains(event.target as Node)
      ) {
        setIsMicMenuOpen(false);
      }
      if (
        outputMenuRef.current &&
        !outputMenuRef.current.contains(event.target as Node)
      ) {
        setIsOutputMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const allDirectOnlineTargets = useMemo(() => {
    const directCandidates = presence.filter(
      (p) =>
        p.userId !== appData.self.id && p.username.toLowerCase() !== "admin",
    );
    return sortDirectUsersByRoleAndUsername(directCandidates, roleNameById);
  }, [appData.self.id, presence, roleNameById]);

  const directOnlineTargets = useMemo(
    () =>
      showPinnedOnly
        ? allDirectOnlineTargets.filter((p) => pinnedUserIds.includes(p.userId))
        : allDirectOnlineTargets,
    [allDirectOnlineTargets, pinnedUserIds, showPinnedOnly],
  );

  const directGroups = useMemo(() => {
    if (!enableDirectTabs) return [];

    const groups: Array<{
      tabId: string;
      label: string;
      count: number;
      users: typeof allDirectOnlineTargets;
    }> = [];

    // When tabs are enabled, always use allDirectOnlineTargets (ignore showPinnedOnly)

    // Favorites tab
    const favorites = allDirectOnlineTargets.filter((p) =>
      pinnedUserIds.includes(p.userId),
    );
    groups.push({
      tabId: "favorites",
      label: "Favorites",
      count: favorites.length,
      users: favorites,
    });

    // Role-based tabs
    const roleGroups = new Map<string, typeof allDirectOnlineTargets>();
    for (const p of allDirectOnlineTargets) {
      if (!roleGroups.has(p.roleId)) {
        roleGroups.set(p.roleId, []);
      }
      roleGroups.get(p.roleId)!.push(p);
    }
    for (const [roleId, users] of roleGroups) {
      const roleLabel = roleNameById.get(roleId) || roleId || "Unknown";
      groups.push({
        tabId: roleId,
        label: roleLabel,
        count: users.length,
        users,
      });
    }

    // All tab
    groups.push({
      tabId: "all",
      label: "All",
      count: allDirectOnlineTargets.length,
      users: allDirectOnlineTargets,
    });

    return groups;
  }, [enableDirectTabs, allDirectOnlineTargets, pinnedUserIds, roleNameById]);

  const displayedDirectUsers = useMemo(() => {
    if (!enableDirectTabs) return directOnlineTargets;
    const group = directGroups.find((g) => g.tabId === activeDirectTab);
    return group ? group.users : [];
  }, [enableDirectTabs, directGroups, activeDirectTab, directOnlineTargets]);

  // Reset active tab if it no longer exists
  useEffect(() => {
    if (enableDirectTabs && directGroups.length > 0) {
      const tabExists = directGroups.some((g) => g.tabId === activeDirectTab);
      if (!tabExists) {
        setActiveDirectTab("all");
      }
    }
  }, [enableDirectTabs, directGroups, activeDirectTab]);

  const visibleRooms = useMemo(
    () =>
      showPinnedOnly
        ? appData.rooms.filter((room) => pinnedRoomIds.includes(room.id))
        : appData.rooms,
    [appData.rooms, pinnedRoomIds, showPinnedOnly],
  );

  // Helper: get max priority for a user based on their active talk rooms and broadcasts
  const getMaxUserChannelPriority = (user: Presence): number | null => {
    let maxPriority: number | null = null;

    // Check talk rooms
    for (const roomId of user.talkRooms) {
      const room = appData.rooms.find((r) => r.id === roomId);
      if (room) {
        const p = room.priorityLevel ?? 1;
        if (maxPriority === null || p > maxPriority) {
          maxPriority = p;
        }
      }
    }

    // Check broadcast active
    if (user.broadcastActive) {
      for (const group of appData.broadcastGroups) {
        // User is broadcast active if they're in the broadcast group or an admin
        const p = group.priorityLevel ?? 1;
        if (maxPriority === null || p > maxPriority) {
          maxPriority = p;
        }
      }
    }

    return maxPriority;
  };

  const streamDeckPageOrder = useMemo(
    () =>
      (streamDeckSettings?.pages || [])
        .map((page) => page.page)
        .sort((a, b) => a - b),
    [streamDeckSettings],
  );

  const streamDeckCurrentPage = useMemo(() => {
    if (!streamDeckSettings || streamDeckSettings.pages.length === 0) {
      return null;
    }
    return (
      streamDeckSettings.pages.find(
        (page) => page.page === streamDeckSettings.selectedPage,
      ) || streamDeckSettings.pages[0]
    );
  }, [streamDeckSettings]);

  const streamDeckCurrentButtons = useMemo(
    () =>
      [...(streamDeckCurrentPage?.buttons || [])].sort(
        (a, b) => a.index - b.index,
      ),
    [streamDeckCurrentPage],
  );

  const streamDeckSelectedButton = useMemo(
    () =>
      streamDeckCurrentButtons.find(
        (button) => button.index === streamDeckSelectedButtonIndex,
      ) || streamDeckCurrentButtons[0] || null,
    [streamDeckCurrentButtons, streamDeckSelectedButtonIndex],
  );

  const streamDeckLabelLookup = useMemo(
    () => ({
      rooms: appData.rooms,
      roles: appData.roles,
      users: appData.users,
      activeUsers: presence.map((entry) => ({
        id: entry.userId,
        username: entry.username,
        roleId: entry.roleId,
      })),
      broadcastGroups,
    }),
    [appData.rooms, appData.roles, appData.users, broadcastGroups, presence],
  );

  const streamDeckPreviewPressedSet = useMemo(
    () => new Set(streamDeckPreviewPressedIndexes),
    [streamDeckPreviewPressedIndexes],
  );

  const [streamDeckPreviewImageByIndex, setStreamDeckPreviewImageByIndex] =
    useState<Map<number, string>>(new Map());

  const streamDeckPreviewRenderInputs = useMemo(() => {
    const cache = streamDeckPreviewCacheRef.current;
    const listeningRoomIds = new Set(listenRoomIds);
    const selectedTalkRoomIds = new Set(talkRoomIds);
    const visibleButtonIndices = new Set(
      streamDeckCurrentButtons.map((button) => button.index),
    );

    for (const cachedIndex of Array.from(cache.keys())) {
      if (!visibleButtonIndices.has(cachedIndex)) {
        cache.delete(cachedIndex);
      }
    }

    return streamDeckCurrentButtons.map((rawButton) => {
      const resolvedButton = withResolvedStreamDeckButtonLabel(
        rawButton,
        streamDeckLabelLookup,
      );
      const isListening =
        (rawButton.action?.type === "ptt_room" ||
          rawButton.action?.type === "select_talk_room" ||
          rawButton.action?.type === "select_listen_room" ||
          rawButton.action?.type === "listen_room") &&
        !!rawButton.action.roomId &&
        listeningRoomIds.has(rawButton.action.roomId);
      const isPttSelected =
        (rawButton.action?.type === "select_talk_room" ||
          rawButton.action?.type === "select_listen_room") &&
        !!rawButton.action.roomId &&
        selectedTalkRoomIds.has(rawButton.action.roomId);
      const button = {
        ...resolvedButton,
        isListening,
        isPttSelected,
      };
      const pressed = streamDeckPreviewPressedSet.has(rawButton.index);
      const signature = streamDeckPreviewSignature(button, pressed);
      const labels = splitStreamDeckLabel(resolvedButton.label);
      const previewState: "IDLE" | "TALK" | "LISTEN" | "BROADCAST" = pressed
        ? rawButton.action?.type === "broadcast_ptt"
          ? "BROADCAST"
          : "TALK"
        : isListening
          ? "LISTEN"
          : "IDLE";

      return {
        buttonIndex: rawButton.index,
        signature,
        payload: {
          buttonIndex: rawButton.index,
          label: labels.primary,
          subtitle: labels.subtitle,
          actionType: rawButton.action?.type,
          color: rawButton.color,
          state: previewState,
          channel:
            rawButton.action?.roomId ||
            rawButton.action?.broadcastGroupId ||
            rawButton.action?.roleId ||
            rawButton.action?.userId ||
            "",
          isListening,
          isPttSelected,
          isActive: pressed,
        },
      };
    });
  }, [
    listenRoomIds,
    talkRoomIds,
    streamDeckLabelLookup,
    streamDeckCurrentButtons,
    streamDeckPreviewPressedSet,
  ]);

  useEffect(() => {
    const cache = streamDeckPreviewCacheRef.current;
    const initial = new Map<number, string>();
    const missingPayload: Array<{
      buttonIndex: number;
      label?: string;
      subtitle?: string;
      actionType?: StreamDeckActionType;
      color?: string;
      state?: "IDLE" | "TALK" | "LISTEN" | "BROADCAST";
      channel?: string;
      isListening?: boolean;
      isPttSelected?: boolean;
      isActive?: boolean;
    }> = [];

    for (const item of streamDeckPreviewRenderInputs) {
      const cached = cache.get(item.buttonIndex);
      if (cached && cached.signature === item.signature) {
        initial.set(item.buttonIndex, cached.dataUrl);
      } else {
        missingPayload.push(item.payload);
      }
    }

    setStreamDeckPreviewImageByIndex(initial);

    if (missingPayload.length === 0) {
      return;
    }

    const abortController = new AbortController();

    void (async () => {
      try {
        const renderedByIndex = await renderStreamDeckPreviewImages(
          token,
          {
            width: 112,
            height: 112,
            buttons: missingPayload,
          },
          abortController.signal,
        );
        if (abortController.signal.aborted) {
          return;
        }

        for (const item of streamDeckPreviewRenderInputs) {
          const image = renderedByIndex.get(item.buttonIndex);
          if (!image) continue;
          cache.set(item.buttonIndex, {
            signature: item.signature,
            dataUrl: image,
          });
        }

        const nextMap = new Map<number, string>();
        for (const item of streamDeckPreviewRenderInputs) {
          const cached = cache.get(item.buttonIndex);
          if (!cached || cached.signature !== item.signature) continue;
          nextMap.set(item.buttonIndex, cached.dataUrl);
        }
        setStreamDeckPreviewImageByIndex(nextMap);
      } catch {
        if (abortController.signal.aborted) {
          return;
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [streamDeckPreviewRenderInputs, token]);

  const startStreamDeckPreviewPress = (buttonIndex: number) => {
    if (!streamDeckSettings || !streamDeckTestMode) return;
    setStreamDeckPreviewPressedIndexes((prev) =>
      prev.includes(buttonIndex) ? prev : [...prev, buttonIndex],
    );
    onStreamDeckTestButtonEvent({
      page: streamDeckSettings.selectedPage,
      buttonIndex,
      state: "down",
    });
  };

  const stopStreamDeckPreviewPress = (buttonIndex: number) => {
    if (!streamDeckSettings || !streamDeckTestMode) return;
    setStreamDeckPreviewPressedIndexes((prev) => {
      if (!prev.includes(buttonIndex)) return prev;
      return prev.filter((index) => index !== buttonIndex);
    });
    onStreamDeckTestButtonEvent({
      page: streamDeckSettings.selectedPage,
      buttonIndex,
      state: "up",
    });
  };

  useEffect(() => {
    if (streamDeckTestMode) return;
    setStreamDeckPreviewPressedIndexes([]);
  }, [streamDeckTestMode]);

  const applyStreamDeckSettings = (
    nextSettings: StreamDeckSettings,
    options?: {
      recordUndo?: boolean;
      message?: string;
      error?: string;
    },
  ) => {
    if (streamDeckSettings && options?.recordUndo !== false) {
      setStreamDeckUndoStack((prev) => [
        ...prev.slice(-24),
        cloneStreamDeckSettings(streamDeckSettings),
      ]);
    }
    onStreamDeckSettingsChange(nextSettings);
    if (options?.error !== undefined) {
      setStreamDeckTransferError(options.error);
    }
    if (options?.message !== undefined) {
      setStreamDeckTransferMessage(options.message);
    }
  };

  const undoLastStreamDeckChange = () => {
    const previousSettings = streamDeckUndoStack[streamDeckUndoStack.length - 1];
    if (!previousSettings) {
      return;
    }
    setStreamDeckUndoStack((prev) => prev.slice(0, -1));
    onStreamDeckSettingsChange(cloneStreamDeckSettings(previousSettings));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage("Last Stream Deck change undone.");
  };

  useEffect(() => {
    if (!streamDeckCurrentButtons.length) return;
    const exists = streamDeckCurrentButtons.some(
      (button) => button.index === streamDeckSelectedButtonIndex,
    );
    if (!exists) {
      setStreamDeckSelectedButtonIndex(streamDeckCurrentButtons[0].index);
    }
  }, [streamDeckCurrentButtons, streamDeckSelectedButtonIndex]);

  const updateStreamDeckSelectedButton = (
    updater: (button: NonNullable<typeof streamDeckSelectedButton>) => {
      index: number;
      label?: string;
      color?: string;
      action?: {
        type: StreamDeckActionType;
        roomId?: string;
        userId?: string;
        roleId?: string;
        broadcastGroupId?: string;
        volumeDelta?: number;
        targetPage?: number;
      };
    },
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage || !streamDeckSelectedButton) {
      return;
    }
    const nextSelected = updater(streamDeckSelectedButton);
    const nextButtons = streamDeckCurrentPage.buttons.map((button) =>
      button.index === streamDeckSelectedButton.index ? nextSelected : button,
    );
    applyStreamDeckSettings({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page !== streamDeckCurrentPage.page
          ? page
          : {
              ...page,
              buttons: nextButtons,
            },
      ),
    });
  };

  const updateStreamDeckCurrentPageButtons = (
    updater: (buttons: StreamDeckButtonConfig[]) => StreamDeckButtonConfig[],
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage) {
      return;
    }
    const nextButtons = updater(streamDeckCurrentPage.buttons);
    applyStreamDeckSettings({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page !== streamDeckCurrentPage.page
          ? page
          : {
              ...page,
              buttons: nextButtons,
            },
      ),
    });
  };

  const copySelectedStreamDeckButton = () => {
    if (!streamDeckSelectedButton) {
      return;
    }
    setStreamDeckClipboardButton(cloneStreamDeckButtonConfig(streamDeckSelectedButton));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Button ${streamDeckSelectedButton.index + 1} copied.`,
    );
  };

  const pasteIntoSelectedStreamDeckButton = () => {
    if (!streamDeckClipboardButton || !streamDeckSelectedButton) {
      return;
    }
    updateStreamDeckSelectedButton((button) => ({
      ...cloneStreamDeckButtonConfig(streamDeckClipboardButton),
      index: button.index,
    }));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Pasted into button ${streamDeckSelectedButton.index + 1}.`,
    );
  };

  const clearSelectedStreamDeckButton = () => {
    if (!streamDeckSelectedButton) {
      return;
    }
    updateStreamDeckSelectedButton((button) => ({ index: button.index }));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Button ${streamDeckSelectedButton.index + 1} cleared.`,
    );
  };

  const swapStreamDeckButtons = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) {
      return;
    }
    updateStreamDeckCurrentPageButtons((buttons) => {
      const source = buttons.find((button) => button.index === fromIndex);
      const target = buttons.find((button) => button.index === toIndex);
      if (!source || !target) {
        return buttons;
      }
      const sourceClone = cloneStreamDeckButtonConfig(source);
      const targetClone = cloneStreamDeckButtonConfig(target);
      return buttons.map((button) => {
        if (button.index === fromIndex) {
          return { ...targetClone, index: fromIndex };
        }
        if (button.index === toIndex) {
          return { ...sourceClone, index: toIndex };
        }
        return button;
      });
    });
    setStreamDeckSelectedButtonIndex(toIndex);
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Moved button ${fromIndex + 1} to ${toIndex + 1}.`,
    );
  };

  const handleStreamDeckButtonDragStart = (buttonIndex: number) => {
    setStreamDeckDragSourceIndex(buttonIndex);
    setStreamDeckDropTargetIndex(buttonIndex);
    setStreamDeckSelectedButtonIndex(buttonIndex);
  };

  const handleStreamDeckButtonDrop = (buttonIndex: number) => {
    if (streamDeckDragSourceIndex === null) {
      return;
    }
    swapStreamDeckButtons(streamDeckDragSourceIndex, buttonIndex);
    setStreamDeckDragSourceIndex(null);
    setStreamDeckDropTargetIndex(null);
  };

  const resetStreamDeckDragState = () => {
    setStreamDeckDragSourceIndex(null);
    setStreamDeckDropTargetIndex(null);
  };

  const setStreamDeckActionType = (type: StreamDeckActionType) => {
    updateStreamDeckSelectedButton((button) => {
      if (type === "none") {
        return { ...button, action: undefined };
      }
      if (type === "page_home" || type === "page_jump") {
        const pageOrder = (streamDeckSettings?.pages ?? [])
          .map((page) => page.page)
          .sort((a, b) => a - b);
        const homePage = pageOrder[0] ?? 0;
        const defaultTargetPage =
          button.action?.type === "page_jump" && button.action.targetPage !== undefined
            ? button.action.targetPage
            : homePage;
        return {
          ...button,
          action: {
            type,
            targetPage: type === "page_home" ? homePage : defaultTargetPage,
          },
        };
      }
      if (
        type === "ptt_room" ||
        type === "select_talk_room" ||
        type === "select_listen_room" ||
        type === "listen_room" ||
        type === "call_room"
      ) {
        return {
          ...button,
          action: {
            type,
            roomId:
              button.action?.type === "ptt_room" ||
              button.action?.type === "select_talk_room" ||
              button.action?.type === "select_listen_room" ||
              button.action?.type === "listen_room" ||
              button.action?.type === "call_room"
                ? button.action.roomId
                : appData.rooms[0]?.id,
          },
        };
      }
      if (type === "direct_user") {
        return {
          ...button,
          action: {
            type,
            userId:
              button.action?.type === "direct_user"
                ? button.action.userId
                : appData.users[0]?.id,
          },
        };
      }
      if (type === "direct_role") {
        return {
          ...button,
          action: {
            type,
            roleId:
              button.action?.type === "direct_role"
                ? button.action.roleId
                : appData.roles[0]?.id,
          },
        };
      }
      if (type === "broadcast_ptt") {
        return {
          ...button,
          action: {
            type,
            broadcastGroupId:
              button.action?.type === "broadcast_ptt"
                ? button.action.broadcastGroupId
                : broadcastGroups[0]?.id,
          },
        };
      }
      if (type === "volume_delta") {
        return {
          ...button,
          action: {
            type,
            volumeDelta:
              button.action?.type === "volume_delta"
                ? button.action.volumeDelta || 1
                : 1,
          },
        };
      }
      return { ...button, action: { type } };
    });
  };

  const updateStreamDeckCurrentPageMeta = (
    updater: (page: NonNullable<typeof streamDeckCurrentPage>) => {
      page: number;
      title?: string;
      pageType?: StreamDeckPageType;
      parentPage?: number;
      buttons: StreamDeckButtonConfig[];
    },
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage) {
      return;
    }
    const nextPage = updater(streamDeckCurrentPage);
    applyStreamDeckSettings({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page === streamDeckCurrentPage.page ? nextPage : page,
      ),
    });
  };

  const goToStreamDeckPage = (direction: -1 | 1) => {
    if (!streamDeckSettings || streamDeckPageOrder.length === 0) return;
    const currentPageIndex = streamDeckPageOrder.findIndex(
      (pageNo) => pageNo === streamDeckSettings.selectedPage,
    );
    const safeCurrentIndex = currentPageIndex >= 0 ? currentPageIndex : 0;
    const nextIndex = Math.max(
      0,
      Math.min(streamDeckPageOrder.length - 1, safeCurrentIndex + direction),
    );
    const nextPage = streamDeckPageOrder[nextIndex];
    if (nextPage === undefined || nextPage === streamDeckSettings.selectedPage) {
      return;
    }
    applyStreamDeckSettings({
      ...streamDeckSettings,
      selectedPage: nextPage,
    });
  };

  const addStreamDeckPage = () => {
    if (!streamDeckSettings) return;
    const existing = new Set(streamDeckSettings.pages.map((page) => page.page));
    let nextPageNumber = 0;
    while (existing.has(nextPageNumber)) {
      nextPageNumber += 1;
    }
    const buttonCount = streamDeckSettings.gridColumns * streamDeckSettings.gridRows;
    applyStreamDeckSettings({
      ...streamDeckSettings,
      selectedPage: nextPageNumber,
      pages: [
        ...streamDeckSettings.pages,
        {
          page: nextPageNumber,
          title: "",
          pageType: "manual",
          buttons: createEmptyStreamDeckButtons(buttonCount),
        },
      ],
    });
  };

  const removeCurrentStreamDeckPage = () => {
    if (!streamDeckSettings || streamDeckSettings.pages.length <= 1) {
      return;
    }
    const nextPages = streamDeckSettings.pages.filter(
      (page) => page.page !== streamDeckSettings.selectedPage,
    );
    const nextOrder = nextPages.map((page) => page.page).sort((a, b) => a - b);
    const fallbackPage =
      nextOrder.find((pageNo) => pageNo > streamDeckSettings.selectedPage) ??
      nextOrder[nextOrder.length - 1];
    if (fallbackPage === undefined) {
      return;
    }
    applyStreamDeckSettings({
      ...streamDeckSettings,
      selectedPage: fallbackPage,
      pages: nextPages.map((page) => ({
        ...page,
        parentPage:
          page.parentPage === streamDeckSettings.selectedPage
            ? undefined
            : page.parentPage,
        buttons: page.buttons.map((button) => {
          if (
            button.action?.type === "page_jump" &&
            button.action.targetPage === streamDeckSettings.selectedPage
          ) {
            return {
              ...button,
              action: {
                type: "page_jump",
                targetPage: fallbackPage,
              },
            };
          }
          return button;
        }),
      })),
    });
  };

  const exportStreamDeckSettings = () => {
    if (!streamDeckSettings) {
      return;
    }
    const nowIso = new Date().toISOString();
    const payload = {
      meta: {
        format: STREAM_DECK_IMPORT_FORMAT,
        schemaVersion: STREAM_DECK_IMPORT_SCHEMA_VERSION,
        exportedAt: nowIso,
        username: appData.self.username,
      },
      settings: streamDeckSettings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = window.URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    const username = appData.self.username.replace(/[^a-zA-Z0-9_-]/g, "_");
    anchor.href = url;
    anchor.download = `kesher-streamdeck-${username}-${nowIso.replace(/[:]/g, "-")}.json`;
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage("Stream Deck profile exported.");
  };

  const openStreamDeckImportPicker = () => {
    streamDeckImportInputRef.current?.click();
  };

  const importStreamDeckSettingsFromFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const nextSettings = parseStreamDeckImportDocument(text);
      applyStreamDeckSettings(nextSettings, {
        message: `${file.name} loaded. Click Save to persist it to your account.`,
        error: "",
      });
    } catch (error) {
      setStreamDeckTransferMessage("");
      setStreamDeckTransferError(
        error instanceof Error ? error.message : "Import failed.",
      );
    } finally {
      event.target.value = "";
    }
  };

  const publishCompanionProfile = async () => {
    setCompanionPublishBusy(true);
    try {
      const published = await onPublishCompanionProfile();
      setStreamDeckTransferError("");
      setStreamDeckTransferMessage(
        `Companion profile published as v${published.profileVersion} for role ${published.roleId}.`,
      );
    } catch (error) {
      setStreamDeckTransferMessage("");
      setStreamDeckTransferError(
        error instanceof Error ? error.message : "Companion publish failed.",
      );
    } finally {
      setCompanionPublishBusy(false);
    }
  };

  const replyTarget =
    allDirectOnlineTargets.find((p) => p.userId === lastDirectCallerUserId) ||
    null;
  const replyTargetUserId = lastDirectCallerUserId;

  // Is user actively sending audio on their main talk rooms?
  // Not when direct PTT or broadcast PTT is active (audio goes there instead).
  const isSendingOnTalkRooms =
    (pttPressed || voiceMode === "always_on") &&
    !directPttPressedUserId &&
    !broadcastPttPressed;
  const mainPttButtonProps = createHoldButtonProps<HTMLButtonElement>({
    onStart: startPtt,
    onStop: stopPtt,
  });
  const replyButtonProps = createHoldButtonProps<HTMLButtonElement>({
    disabled: !replyTargetUserId,
    onStart: () => {
      if (replyTargetUserId) {
        startDirectPtt(replyTargetUserId);
      }
    },
    onStop: () => {
      if (replyTargetUserId) {
        stopDirectPtt(replyTargetUserId);
      }
    },
  });
  const mainPttButton = (
    <button
      key="ptt"
      className={`station-ptt hold-button ${pttPressed ? "active" : ""}`}
      {...mainPttButtonProps}
    >
      Hold to talk
    </button>
  );
  const replyButton = (
    <button
      key="reply"
      className={`station-reply hold-button ${replyTargetUserId ? "" : "disabled"} ${
        replyTargetUserId && directPttPressedUserId === replyTargetUserId
          ? "active"
          : ""
      }`}
      disabled={!replyTargetUserId}
      {...replyButtonProps}
    >
      Reply to caller
      <small>
        {replyTarget
          ? replyTarget.username
          : replyTargetUserId
            ? "Recent caller"
            : "No active caller"}
      </small>
    </button>
  );
  const footerButtons = swapPttAndReplyButtons
    ? [mainPttButton, replyButton]
    : [replyButton, mainPttButton];
  const hasChatAndSignalPanel = Boolean(chatAndSignalPanel);

  return (
    <div className="root app station-shell">
      {connectionState !== "connected" && (
        <div className="connection-offline-banner">
          <span className="connection-offline-icon" />
          {connectionState === "reconnecting"
            ? "Reconnecting..."
            : connectionState === "connecting"
              ? "Connecting..."
              : "Offline"}
        </div>
      )}
      <div className="station-header">
        <div className="station-topbar">
          <div className="station-live">
            <div className="station-live-name">
              <span
                className={`station-live-dot ${
                  connectionState === "connected" ? "connected" : "disconnected"
                }`}
              />
              Live: {appData.self.username.toUpperCase()}
            </div>
            <div className="station-live-role">
              {roleNameById.get(appData.self.roleId) || appData.self.roleId}
            </div>
          </div>
          <div className="station-top-actions">
            <button
              className="station-top-admin"
              onClick={() => setIsUserSettingsOpen(true)}
            >
              User settings
            </button>
            <button className="station-top-logout" onClick={doLogout}>
              Logout / Lock
            </button>
          </div>
        </div>

        <section
          className={`station-controls ${
            isUserSettingsOpen ? "station-controls-hidden-mobile" : ""
          }`}
        >
          {footerButtons}
          <button
            type="button"
            role="switch"
            aria-checked={voiceMode === "always_on"}
            className={`station-always-on ${voiceMode === "always_on" ? "active" : ""}`}
            onClick={() => setAlwaysOn(voiceMode !== "always_on")}
          >
            <span className="station-always-on-indicator" aria-hidden="true" />
            <span className="station-always-on-text">Always on</span>
          </button>
        </section>
      </div>

      <div className="station-content-grid">
        <div className="station-primary-column">
          <section className="station-block station-talk-section">
            <h3>Talk channels</h3>
            <div className="station-filter-bar small">
              <span className="station-filter-hint">
                Pin party lines or users to keep focus when things get busy.
              </span>
            </div>
            {visibleRooms.length === 0 ? (
              <p className="station-empty">No channels to show.</p>
            ) : null}
            <div className="station-talk-grid">
              {visibleRooms.map((room) => {
                const listening = listenRoomIds.includes(room.id);
                const talking = talkRoomIds.includes(room.id);
                const canTalk = canRoleSendToRoom(room.id, appData.self.roleId);
                const canListen = canRoleReceiveFromRoom(
                  room.id,
                  appData.self.roleId,
                );
                const isForced = (room.forcedListenRoleIds ?? []).includes(
                  appData.self.roleId,
                );
                const isPttPressed =
                  enableDirectPpt && pptPressedChannelId === room.id;

                const handleTalkPointerDown = () => {
                  if (enableDirectPpt) {
                    onChannelPptStart(room.id);
                  }
                };

                const handleTalkPointerUp = () => {
                  if (enableDirectPpt) {
                    onChannelPptStop(room.id);
                  }
                };
                const talkButtonHoldProps =
                  canTalk && enableDirectPpt
                    ? createHoldButtonProps<HTMLButtonElement>({
                        onStart: handleTalkPointerDown,
                        onStop: handleTalkPointerUp,
                      })
                    : {};

                const listenerCount = roomListenerCounts[room.id] ?? 0;
                const talkButtonClassName = `station-card-head ${
                  enableDirectPpt ? "hold-button " : ""
                }${
                  enableDirectPpt
                    ? isPttPressed && canTalk
                      ? "ppt-active"
                      : ""
                    : ""
                } ${canTalk ? "" : "disabled"}${
                  !enableDirectPpt && talking && canTalk ? " talk-armed" : ""
                }${
                  !enableDirectPpt && talking && canTalk && isSendingOnTalkRooms
                    ? " talk-live"
                    : ""
                }`;

                return (
                  <article
                    key={`station-room-${room.id}`}
                    className="station-card"
                  >
                    {listenerCount > 0 ? (
                      <span
                        className="station-presence-badge"
                        title={`${listenerCount} listener(s)`}
                      >
                        <span className="station-presence-dot" />
                        {listenerCount}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={`station-pin-top ${pinnedRoomIds.includes(room.id) ? "active" : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePinnedRoom(room.id);
                      }}
                      title={
                        pinnedRoomIds.includes(room.id)
                          ? "Remove channel from favorites"
                          : "Add channel to favorites"
                      }
                    >
                      *
                    </button>
                    <button
                      className={talkButtonClassName}
                      {...talkButtonHoldProps}
                      onClick={
                        !enableDirectPpt && canTalk
                          ? () => toggleTalkRoom(room.id)
                          : undefined
                      }
                      disabled={!canTalk}
                      title={
                        canTalk
                          ? ""
                          : "Your role is not allowed to send to this party line"
                      }
                    >
                      {isReceivingRoom(room.id) ? (
                        <span className="station-receiving-badge">RX</span>
                      ) : null}
                      <small>Talk</small>
                      <strong>{room.name}</strong>
                      {(() => {
                        const p = room.priorityLevel ?? 1;
                        if (p === 1) return null;
                        const priorityLabels: Record<number, string> = {
                          0: "L",
                          2: "H",
                          3: "C",
                        };
                        return (
                          <span className={`priority-badge priority-${p}`}>
                            {priorityLabels[p] || "?"}
                          </span>
                        );
                      })()}
                    </button>
                    {showVolumeControls ? (
                      <div className="station-gain-control">
                        <label htmlFor={`room-gain-${room.id}`}>
                          {gainToDbLabel(roomGainById[room.id] ?? 1)}
                        </label>
                        <input
                          id={`room-gain-${room.id}`}
                          type="range"
                          min={MUTE_POS}
                          max={OUTPUT_DB_MAX}
                          step={1}
                          value={gainToSlider(roomGainById[room.id] ?? 1)}
                          style={
                            {
                              "--fill": `${sliderFillPercent(roomGainById[room.id] ?? 1)}%`,
                            } as React.CSSProperties
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onRoomGainChange(
                              room.id,
                              sliderToGain(Number(event.currentTarget.value)),
                            )
                          }
                        />
                      </div>
                    ) : null}
                    <div className="station-card-actions">
                      <button
                        className={`listen ${listening && canListen ? "on" : ""} ${canListen ? "" : "disabled"} ${isForced ? "forced" : ""}`}
                        onClick={() => toggleListenRoom(room.id)}
                        disabled={!canListen || isForced}
                        title={
                          isForced
                            ? "Forced listen - cannot be deselected"
                            : canListen
                              ? ""
                              : "Your role is not allowed to receive from this party line"
                        }
                      >
                        {isForced ? "Locked Listen" : "Listen"}
                      </button>
                      <button
                        className={`call ${canTalk ? "" : "disabled"}`}
                        onClick={() =>
                          sendScopedSignal("room", room.id, "call")
                        }
                        disabled={!canTalk}
                        title={
                          canTalk
                            ? ""
                            : "Your role is not allowed to send to this room"
                        }
                      >
                        Call
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="station-block station-direct-section">
            <h3>Direct communication</h3>
            {enableDirectTabs && directGroups.length > 0 ? (
              <>
                <div
                  className="station-direct-tabs"
                  role="tablist"
                  aria-label="Direct communication tabs"
                >
                  {directGroups.map((group) => (
                    <button
                      key={`direct-tab-${group.tabId}`}
                      role="tab"
                      className={`station-direct-tab ${activeDirectTab === group.tabId ? "active" : ""}`}
                      aria-selected={activeDirectTab === group.tabId}
                      onClick={() => setActiveDirectTab(group.tabId)}
                    >
                      <span>{group.label}</span>
                      <small>{group.count}</small>
                    </button>
                  ))}
                </div>
                {displayedDirectUsers.length === 0 ? (
                  <p className="station-empty">No users in this tab.</p>
                ) : (
                  <div className="station-direct-grid">
                    {displayedDirectUsers.map((p) => (
                      <article
                        key={`station-direct-${p.userId}`}
                        className="station-card station-direct-card"
                      >
                        <button
                          type="button"
                          className={`station-pin-top ${pinnedUserIds.includes(p.userId) ? "active" : ""}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onTogglePinnedUser(p.userId);
                          }}
                          title={
                            pinnedUserIds.includes(p.userId)
                              ? "Remove user from favorites"
                              : "Add user to favorites"
                          }
                        >
                          *
                        </button>
                        <button
                          className={`station-card-head direct-ptt hold-button ${directPttPressedUserId === p.userId ? "active" : ""}`}
                          {...createHoldButtonProps<HTMLButtonElement>({
                            onStart: () => startDirectPtt(p.userId),
                            onStop: () => stopDirectPtt(p.userId),
                          })}
                        >
                          {isReceivingDirect(p.userId) ? (
                            <span className="station-receiving-badge">RX</span>
                          ) : null}
                          <small>Direct</small>
                          <strong>{p.username}</strong>
                          {(() => {
                            const maxP = getMaxUserChannelPriority(p);
                            if (maxP === null || maxP === 1) return null;
                            const priorityLabels: Record<number, string> = {
                              0: "L",
                              2: "H",
                              3: "C",
                            };
                            return (
                              <span className={`priority-badge priority-${maxP}`}>
                                {priorityLabels[maxP] || "?"}
                              </span>
                            );
                          })()}
                          <em>
                            {roleNameById.get(p.roleId) ||
                              p.roleId ||
                              "Unknown role"}
                          </em>
                        </button>
                        {showVolumeControls ? (
                          <div className="station-gain-control">
                            <label htmlFor={`direct-gain-${p.userId}`}>
                              {gainToDbLabel(directGainByUserId[p.userId] ?? 1)}
                            </label>
                            <input
                              id={`direct-gain-${p.userId}`}
                              type="range"
                              min={MUTE_POS}
                              max={OUTPUT_DB_MAX}
                              step={1}
                              value={gainToSlider(
                                directGainByUserId[p.userId] ?? 1,
                              )}
                              style={
                                {
                                  "--fill": `${sliderFillPercent(directGainByUserId[p.userId] ?? 1)}%`,
                                } as React.CSSProperties
                              }
                              onPointerDown={(event) => event.stopPropagation()}
                              onPointerUp={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                onDirectGainChange(
                                  p.userId,
                                  sliderToGain(Number(event.currentTarget.value)),
                                )
                              }
                            />
                          </div>
                        ) : null}
                        <div className="station-card-actions single">
                          <button
                            className={`call ${/* disabled handled by class */ ""}`}
                            onClick={() =>
                              sendScopedSignal("direct", p.userId, "call")
                            }
                            title="Call user"
                          >
                            Call
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            ) : directOnlineTargets.length === 0 ? (
              <p className="station-empty">
                {showPinnedOnly
                  ? "No favorite users online."
                  : "No other users online."}
              </p>
            ) : (
              <div className="station-direct-grid">
                {directOnlineTargets.map((p) => (
                  <article
                    key={`station-direct-${p.userId}`}
                    className="station-card station-direct-card"
                  >
                    <button
                      type="button"
                      className={`station-pin-top ${pinnedUserIds.includes(p.userId) ? "active" : ""}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePinnedUser(p.userId);
                      }}
                      title={
                        pinnedUserIds.includes(p.userId)
                          ? "Remove user from favorites"
                          : "Add user to favorites"
                      }
                    >
                      *
                    </button>
                    <button
                      className={`station-card-head direct-ptt hold-button ${directPttPressedUserId === p.userId ? "active" : ""}`}
                      {...createHoldButtonProps<HTMLButtonElement>({
                        onStart: () => startDirectPtt(p.userId),
                        onStop: () => stopDirectPtt(p.userId),
                      })}
                    >
                      {isReceivingDirect(p.userId) ? (
                        <span className="station-receiving-badge">RX</span>
                      ) : null}
                      <small>Direct</small>
                      <strong>{p.username}</strong>
                      <em>
                        {roleNameById.get(p.roleId) ||
                          p.roleId ||
                          "Unknown role"}
                      </em>
                    </button>
                    {showVolumeControls ? (
                      <div className="station-gain-control">
                        <label htmlFor={`direct-gain-${p.userId}`}>
                          {gainToDbLabel(directGainByUserId[p.userId] ?? 1)}
                        </label>
                        <input
                          id={`direct-gain-${p.userId}`}
                          type="range"
                          min={MUTE_POS}
                          max={OUTPUT_DB_MAX}
                          step={1}
                          value={gainToSlider(directGainByUserId[p.userId] ?? 1)}
                          style={
                            {
                              "--fill": `${sliderFillPercent(directGainByUserId[p.userId] ?? 1)}%`,
                            } as React.CSSProperties
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onDirectGainChange(
                              p.userId,
                              sliderToGain(Number(event.currentTarget.value)),
                            )
                          }
                        />
                      </div>
                    ) : null}
                    <div className="station-card-actions single">
                      <button
                        className={`call ${/* disabled handled by class */ ""}`}
                        onClick={() =>
                          sendScopedSignal("direct", p.userId, "call")
                        }
                        title="Call user"
                      >
                        Call
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {broadcastGroups.length > 0 ? (
            <section className="station-block station-broadcast-section">
              <h3>Broadcast channels</h3>
              <div className="station-broadcast-grid">
                {broadcastGroups.map((group) => {
                  const allowedRoleIds = Array.isArray(group.allowedRoleIds)
                    ? group.allowedRoleIds
                    : [];
                  const canSend =
                    allowedRoleIds.length === 0 ||
                    allowedRoleIds.includes(appData.self.roleId);
                  return (
                    <button
                      key={group.id}
                      className={`station-broadcast-button hold-button ${broadcastPttPressed === group.id ? "active" : ""} ${
                        canSend ? "" : "disabled"
                      }`}
                      {...createHoldButtonProps<HTMLButtonElement>({
                        disabled: !canSend,
                        onStart: () => {
                          if (canSend) {
                            startBroadcastPtt(group.id);
                          }
                        },
                        onStop: () => {
                          if (canSend) {
                            stopBroadcastPtt(group.id);
                          }
                        },
                      })}
                      disabled={!canSend}
                      title={
                        canSend
                          ? ""
                          : "Your role is not allowed to send to this broadcast channel"
                      }
                    >
                      {isReceivingBroadcast(group.id) ? (
                        <span className="station-broadcast-receiving">RX</span>
                      ) : null}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.15rem" }}>
                        <span>{group.name}</span>
                        {(() => {
                          const p = group.priorityLevel ?? 1;
                          if (p === 1) return null;
                          const priorityLabels: Record<number, string> = {
                            0: "L",
                            2: "H",
                            3: "C",
                          };
                          return (
                            <span className={`priority-badge priority-${p}`}>
                              {priorityLabels[p] || "?"}
                            </span>
                          );
                        })()}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        {hasChatAndSignalPanel ? (
          <aside className="station-secondary-column">
            <section className="station-block station-utility station-utility-section">
              <h3>Chat</h3>
              <div className="panel station-chat-panel">
                {chatAndSignalPanel}
              </div>
            </section>
          </aside>
        ) : null}
      </div>
      {showDebug ? (
        <section className="panel">{realtimeDebugBlock}</section>
      ) : null}
      {isUserSettingsOpen ? (
        <div
          className="station-modal-backdrop"
          onClick={() => setIsUserSettingsOpen(false)}
        >
          <section
            className="station-modal panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="station-modal-header">
              <h3>User settings</h3>
              <button
                className="station-modal-close"
                onClick={() => setIsUserSettingsOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="station-modal-body">
              <section className="station-settings-section">
                <h4 className="station-settings-section-title">Layout</h4>
                <div className="station-settings-grid">
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={showPinnedOnly}
                      onChange={(e) => onShowPinnedOnlyChange(e.target.checked)}
                    />
                    <span>Show only favorites</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={enableDirectTabs}
                      onChange={(e) =>
                        onEnableDirectTabsChange(e.target.checked)
                      }
                    />
                    <span>Show direct communication as tabs</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={showVolumeControls}
                      onChange={(e) =>
                        onShowVolumeControlsChange(e.target.checked)
                      }
                    />
                    <span>Show volume controls</span>
                  </label>
                </div>
              </section>

              <section className="station-settings-section">
                <h4 className="station-settings-section-title">Interaction</h4>
                <div className="station-settings-grid">
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={enableDirectPpt}
                      onChange={(e) =>
                        onEnableDirectPptChange(e.target.checked)
                      }
                    />
                    <span>Direct PTT Mode (press channel to talk)</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={swapPttAndReplyButtons}
                      onChange={(e) =>
                        onSwapPttAndReplyButtonsChange(e.target.checked)
                      }
                    />
                    <span>Swap PTT and reply buttons</span>
                  </label>
                </div>
              </section>

              <section className="station-settings-section">
                <h4 className="station-settings-section-title">System</h4>
                <div className="station-settings-grid">
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={enableBackgroundAudioRecovery}
                      onChange={(e) =>
                        onEnableBackgroundAudioRecoveryChange(e.target.checked)
                      }
                    />
                    <span>Background audio assist</span>
                  </label>
                  <label className="station-setting">
                    <input
                      type="checkbox"
                      checked={keepScreenAwake}
                      disabled={!wakeLockSupported}
                      onChange={(e) => onKeepScreenAwakeChange(e.target.checked)}
                    />
                    <span>Keep device awake while connected</span>
                  </label>
                </div>
              </section>

              <section className="station-settings-section station-settings-status">
                <small className="station-settings-meta">
                  Media controls: {mediaSessionSupported ? "supported" : "not supported"} | Wake
                  lock: {wakeLockSupported ? (wakeLockActive ? "active" : "available") : "not supported"} | Install mode: {isStandaloneDisplayMode ? "installed app" : "browser tab"}
                </small>
                <small className="station-settings-meta">
                  For best mobile reliability, keep background audio assist
                  enabled and install the app to your home screen.
                </small>
              </section>

              <KeyboardShortcutsSettings
                shortcuts={keyboardShortcuts}
                onShortcutsChange={onKeyboardShortcutsChange}
                onRecordingChange={onRecordingShortcutChange}
              />

              <section className="station-settings-section streamdeck-settings-section">
                <div className={`audio-box ${isStreamDeckOpen ? "" : "collapsed"}`}>
                  <div className="audio-box-header">
                    <button
                      type="button"
                      className="audio-box-toggle"
                      onClick={() => setIsStreamDeckOpen((value) => !value)}
                      aria-expanded={isStreamDeckOpen}
                    >
                      Stream Deck
                      <span className={`chev ${isStreamDeckOpen ? "open" : ""}`}>▾</span>
                    </button>
                  </div>
                  {isStreamDeckOpen ? (
                    <div className="audio-box-body">
                      <div className="streamdeck-settings-header">
                        <h4 className="station-settings-section-title">
                          Configuration
                        </h4>
                        <div className="streamdeck-settings-actions">
                          <input
                            ref={streamDeckImportInputRef}
                            type="file"
                            accept="application/json,.json"
                            data-testid="streamdeck-import-input"
                            className="streamdeck-import-input"
                            onChange={(event) => {
                              void importStreamDeckSettingsFromFile(event);
                            }}
                            disabled={streamDeckBusy}
                          />
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={
                              streamDeckWebHidActive
                                ? onDisconnectStreamDeckWebHid
                                : onConnectStreamDeckWebHid
                            }
                            disabled={streamDeckWebHidBusy || !streamDeckWebHidSupported}
                          >
                            {streamDeckWebHidBusy
                              ? "Working..."
                              : streamDeckWebHidActive
                                ? "Disconnect device"
                                : "Connect device"}
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={exportStreamDeckSettings}
                            disabled={streamDeckBusy || !streamDeckSettings}
                          >
                            Export
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={openStreamDeckImportPicker}
                            disabled={streamDeckBusy || !streamDeckSettings}
                          >
                            Import
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={onSaveStreamDeckSettings}
                            disabled={streamDeckBusy || !streamDeckSettings}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={() => void publishCompanionProfile()}
                            disabled={
                              streamDeckBusy ||
                              companionPublishBusy ||
                              !streamDeckSettings
                            }
                          >
                            {companionPublishBusy
                              ? "Publishing..."
                              : "Publish to Companion"}
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-clear"
                            onClick={onResetStreamDeckSettings}
                            disabled={streamDeckBusy || !streamDeckSettings}
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    <div className="streamdeck-settings-actions" style={{ marginBottom: "0.6rem" }}>
                      <small className="station-settings-meta">
                        Configure your Stream Deck layout here and click Save.
                        Companion sync is triggered automatically. Use Publish to
                        Companion only as a manual retry.
                      </small>
                    </div>
                    {streamDeckError ? (
                      <small className="streamdeck-error">{streamDeckError}</small>
                    ) : null}
                    {streamDeckTransferError ? (
                      <small className="streamdeck-error">{streamDeckTransferError}</small>
                    ) : null}
                    {streamDeckTransferMessage ? (
                      <small className="station-settings-meta">{streamDeckTransferMessage}</small>
                    ) : null}
                    <small className="station-settings-meta">
                      WebHID: {
                        streamDeckWebHidSupported
                          ? streamDeckWebHidActive
                            ? "connected"
                            : "ready"
                          : "not supported"
                      }
                      {" | "}
                      Input: {streamDeckBridgeConnected ? "connected" : "waiting"}
                      {streamDeckBridgeLastEvent
                        ? ` | Last event: ${streamDeckBridgeLastEvent}`
                        : ""}
                    </small>
                    {lastCompanionCommand ? (
                      <small className="station-settings-meta">
                        Companion: {lastCompanionCommand.command || "unknown"}
                        {` | ${lastCompanionCommand.status}`}
                        {lastCompanionCommand.error
                          ? ` | ${lastCompanionCommand.error}`
                          : ""}
                        {` | ${new Date(lastCompanionCommand.at).toLocaleTimeString()}`}
                      </small>
                    ) : null}
                    {showDebug ? (
                      <small className="station-settings-meta">
                        Debug: use window.__kesherStreamDeckDev.buttonTap(0, 0)
                        or buttonDown/buttonUp in browser console. Use
                        window.__kesherStreamDeckDev.listHidDevices() to show
                        granted HID devices or
                        window.__kesherStreamDeckDev.requestAndListHidDevices()
                        to re-open the device picker.
                      </small>
                    ) : null}
                    {!streamDeckSettings ? (
                      <small className="station-settings-meta">
                        Loading Stream Deck settings...
                      </small>
                    ) : (
                      <div className="streamdeck-editor-shell">
                        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
                        <div className="streamdeck-toolbar">
                          <label className="streamdeck-control">
                            <span>Profile</span>
                            <select value="default" disabled>
                              <option value="default">Default</option>
                            </select>
                          </label>
                          <div className="streamdeck-page-nav" aria-label="Page selector">
                            <button
                              type="button"
                              className="shortcut-btn"
                              onClick={() => goToStreamDeckPage(-1)}
                              disabled={
                                streamDeckBusy ||
                                streamDeckPageOrder[0] ===
                                  streamDeckSettings.selectedPage
                              }
                            >
                              {"<"}
                            </button>
                            <span>
                              Page {streamDeckSettings.selectedPage + 1}
                            </span>
                            <button
                              type="button"
                              className="shortcut-btn"
                              onClick={() => goToStreamDeckPage(1)}
                              disabled={
                                streamDeckBusy ||
                                streamDeckPageOrder[streamDeckPageOrder.length - 1] ===
                                  streamDeckSettings.selectedPage
                              }
                            >
                              {">"}
                            </button>
                          </div>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={addStreamDeckPage}
                            disabled={streamDeckBusy || !streamDeckSettings}
                          >
                            + Page
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-clear"
                            onClick={removeCurrentStreamDeckPage}
                            disabled={
                              streamDeckBusy ||
                              !streamDeckSettings ||
                              streamDeckSettings.pages.length <= 1
                            }
                          >
                            - Page
                          </button>
                          <button
                            type="button"
                            className={`shortcut-btn ${streamDeckTestMode ? "active" : ""}`}
                            onClick={() => setStreamDeckTestMode((value) => !value)}
                            disabled={streamDeckBusy}
                            aria-pressed={streamDeckTestMode}
                            title="Test Stream Deck actions directly in the browser"
                          >
                            {streamDeckTestMode ? "Test mode on" : "Test mode off"}
                          </button>
                        </div>
                        {streamDeckTestMode ? (
                          <small className="station-settings-meta">
                            Test mode active: press and hold any key in the grid to trigger down/up events without a physical Stream Deck.
                          </small>
                        ) : null}
                        <small className="station-settings-meta">
                          Drag one key onto another to swap them. Use Copy and Paste to duplicate button setups.
                        </small>
                        {streamDeckCurrentPage ? (
                          <div className="streamdeck-toolbar" style={{ marginTop: "0.65rem" }}>
                            <label className="streamdeck-control">
                              <span>Page title</span>
                              <input
                                type="text"
                                value={streamDeckCurrentPage.title || ""}
                                onChange={(event) =>
                                  updateStreamDeckCurrentPageMeta((page) => ({
                                    ...page,
                                    title: event.target.value,
                                  }))
                                }
                                placeholder="Optional folder title"
                              />
                            </label>
                            <label className="streamdeck-control">
                              <span>Page type</span>
                              <select
                                value={streamDeckCurrentPage.pageType || "manual"}
                                onChange={(event) =>
                                  updateStreamDeckCurrentPageMeta((page) => ({
                                    ...page,
                                    pageType: event.target.value as StreamDeckPageType,
                                  }))
                                }
                              >
                                <option value="manual">Manual page / folder</option>
                                <option value="all_roles">Auto folder: all roles</option>
                                <option value="all_party_lines">Auto folder: all party-lines</option>
                              </select>
                            </label>
                            <label className="streamdeck-control">
                              <span>Parent page</span>
                              <select
                                value={String(streamDeckCurrentPage.parentPage ?? "")}
                                onChange={(event) =>
                                  updateStreamDeckCurrentPageMeta((page) => ({
                                    ...page,
                                    parentPage:
                                      event.target.value === ""
                                        ? undefined
                                        : Number(event.target.value),
                                  }))
                                }
                              >
                                <option value="">Root level</option>
                                {(streamDeckSettings?.pages ?? [])
                                  .filter((page) => page.page !== streamDeckCurrentPage.page)
                                  .sort((a, b) => a.page - b.page)
                                  .map((page, index) => (
                                    <option key={`sd-parent-page-${page.page}`} value={String(page.page)}>
                                      {page.title?.trim() || `Page ${index + 1}`}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          </div>
                        ) : null}

                        <div className="streamdeck-layout">
                          <div className="streamdeck-grid" role="grid" aria-label="Stream Deck 5x3 grid">
                            {streamDeckCurrentButtons.map((button) => {
                              const previewImage =
                                streamDeckPreviewImageByIndex.get(button.index) || "";
                              const isPressedInPreview =
                                streamDeckPreviewPressedIndexes.includes(button.index);
                              const showPressedRing =
                                isPressedInPreview &&
                                button.action?.type !== "listen_room" &&
                                button.action?.type !== "select_listen_room";
                              return (
                                <button
                                  type="button"
                                  key={`streamdeck-button-${button.index}`}
                                  aria-label={`Deck key ${button.index + 1}`}
                                  className={`streamdeck-button ${
                                    streamDeckSelectedButton?.index === button.index
                                      ? "active"
                                      : ""
                                  } ${showPressedRing ? "test-pressed" : ""} ${
                                    streamDeckDragSourceIndex === button.index
                                      ? "drag-source"
                                      : ""
                                  } ${
                                    streamDeckDropTargetIndex === button.index &&
                                    streamDeckDragSourceIndex !== button.index
                                      ? "drag-target"
                                      : ""
                                  }`}
                                  draggable={!streamDeckTestMode}
                                  onClick={() => setStreamDeckSelectedButtonIndex(button.index)}
                                  onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = "move";
                                    handleStreamDeckButtonDragStart(button.index);
                                  }}
                                  onDragOver={(event) => {
                                    event.preventDefault();
                                    if (streamDeckDragSourceIndex !== null) {
                                      event.dataTransfer.dropEffect = "move";
                                      setStreamDeckDropTargetIndex(button.index);
                                    }
                                  }}
                                  onDragEnter={() => {
                                    if (streamDeckDragSourceIndex !== null) {
                                      setStreamDeckDropTargetIndex(button.index);
                                    }
                                  }}
                                  onDragEnd={resetStreamDeckDragState}
                                  onDrop={(event) => {
                                    event.preventDefault();
                                    handleStreamDeckButtonDrop(button.index);
                                  }}
                                  onPointerDown={() =>
                                    startStreamDeckPreviewPress(button.index)
                                  }
                                  onPointerUp={() =>
                                    stopStreamDeckPreviewPress(button.index)
                                  }
                                  onPointerCancel={() =>
                                    stopStreamDeckPreviewPress(button.index)
                                  }
                                  onPointerLeave={() =>
                                    stopStreamDeckPreviewPress(button.index)
                                  }
                                >
                                  {previewImage ? (
                                    <img
                                      src={previewImage}
                                      alt={`Preview of Stream Deck button ${button.index + 1}`}
                                      className="streamdeck-button-preview"
                                      draggable={false}
                                    />
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>

                          <div className="streamdeck-editor panel">
                        <h5>
                          Button {(streamDeckSelectedButton?.index || 0) + 1}
                        </h5>
                        <div className="streamdeck-editor-actions">
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={undoLastStreamDeckChange}
                            disabled={streamDeckUndoStack.length === 0}
                          >
                            Undo
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={copySelectedStreamDeckButton}
                            disabled={!streamDeckSelectedButton}
                          >
                            Copy
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={pasteIntoSelectedStreamDeckButton}
                            disabled={!streamDeckSelectedButton || !streamDeckClipboardButton}
                          >
                            Paste
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-clear"
                            onClick={clearSelectedStreamDeckButton}
                            disabled={!streamDeckSelectedButton}
                          >
                            Clear
                          </button>
                        </div>
                        <label className="streamdeck-control">
                          <span>Label</span>
                          <input
                            type="text"
                            value={streamDeckSelectedButton?.label || ""}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                label: event.target.value,
                              }))
                            }
                            placeholder="Optional label"
                          />
                        </label>
                        <label className="streamdeck-control">
                          <span>Color</span>
                          <input
                            type="text"
                            value={streamDeckSelectedButton?.color || ""}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                color: event.target.value,
                              }))
                            }
                            placeholder="#1f3f5f"
                          />
                        </label>
                        <label className="streamdeck-control">
                          <span>Function</span>
                          <select
                            aria-label="Stream Deck function"
                            value={streamDeckSelectedButton?.action?.type || "none"}
                            onChange={(event) =>
                              setStreamDeckActionType(
                                event.target.value as StreamDeckActionType,
                              )
                            }
                          >
                            <option value="none">None</option>
                            <optgroup label="Talk channels">
                              <option value="select_talk_room">Select talk channel</option>
                              <option value="select_listen_room">Select + listen channel (hold)</option>
                              <option value="ptt_selected">PTT selected channels</option>
                              <option value="ptt_room">PTT fixed channel</option>
                              <option value="listen_room">Listen channel</option>
                              <option value="call_room">Call channel</option>
                            </optgroup>
                            <optgroup label="Direct communication">
                              <option value="direct_user">Direct user</option>
                              <option value="direct_role">Direct role</option>
                              <option value="reply_to_caller">Reply to caller</option>
                              <option value="incoming_call_indicator">Incoming calls indicator</option>
                            </optgroup>
                            <optgroup label="Broadcast and audio">
                              <option value="broadcast_ptt">Broadcast PTT</option>
                            </optgroup>
                            <optgroup label="Stream Deck navigation">
                              <option value="page_up">Page up</option>
                              <option value="page_down">Page down</option>
                              <option value="page_home">Home (page 1)</option>
                              <option value="page_jump">Open page / folder</option>
                            </optgroup>
                            <optgroup label="Volume">
                              <option value="volume_delta">Volume +/-</option>
                            </optgroup>
                          </select>
                        </label>

                        {streamDeckSelectedButton?.action?.type === "ptt_room" ||
                        streamDeckSelectedButton?.action?.type === "select_talk_room" ||
                        streamDeckSelectedButton?.action?.type === "select_listen_room" ||
                        streamDeckSelectedButton?.action?.type === "listen_room" ||
                        streamDeckSelectedButton?.action?.type === "call_room" ? (
                          <label className="streamdeck-control">
                            <span>Channel</span>
                            <select
                              aria-label="Stream Deck channel target"
                              value={streamDeckSelectedButton.action.roomId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: streamDeckSelectedButton.action?.type || "ptt_room",
                                    roomId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {appData.rooms.map((room) => (
                                <option key={`streamdeck-room-${room.id}`} value={room.id}>
                                  {room.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "direct_user" ? (
                          <label className="streamdeck-control">
                            <span>User</span>
                            <select
                              aria-label="Stream Deck direct user target"
                              value={streamDeckSelectedButton.action.userId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "direct_user",
                                    userId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {sortDirectUsersByRoleAndUsername(appData.users, roleNameById).map((user) => (
                                <option key={`streamdeck-user-${user.id}`} value={user.id}>
                                  {user.username} ({roleNameById.get(user.roleId) ?? user.roleId})
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "direct_role" ? (
                          <label className="streamdeck-control">
                            <span>Direct role</span>
                            <select
                              aria-label="Stream Deck direct role target"
                              value={streamDeckSelectedButton.action.roleId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "direct_role",
                                    roleId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {appData.roles.map((role) => {
                                const onlineRoleUsers = allDirectOnlineTargets
                                  .filter((entry) => entry.roleId === role.id)
                                  .map((entry) => entry.username);
                                const onlineHint =
                                  onlineRoleUsers.length > 0
                                    ? ` (${onlineRoleUsers.join(", ")})`
                                    : "";
                                return (
                                  <option key={`streamdeck-role-${role.id}`} value={role.id}>
                                    {role.name}{onlineHint}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "broadcast_ptt" ? (
                          <label className="streamdeck-control">
                            <span>Broadcast group</span>
                            <select
                              aria-label="Stream Deck broadcast target"
                              value={streamDeckSelectedButton.action.broadcastGroupId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "broadcast_ptt",
                                    broadcastGroupId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {broadcastGroups.map((group) => (
                                <option key={`streamdeck-group-${group.id}`} value={group.id}>
                                  {group.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "volume_delta" ? (
                          <label className="streamdeck-control">
                            <span>Volume step</span>
                            <select
                              aria-label="Stream Deck volume delta"
                              value={String(
                                streamDeckSelectedButton.action.volumeDelta || 1,
                              )}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "volume_delta",
                                    volumeDelta: Number(event.target.value),
                                  },
                                }))
                              }
                            >
                              <option value="-2">-2</option>
                              <option value="-1">-1</option>
                              <option value="1">+1</option>
                              <option value="2">+2</option>
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "page_jump" ? (
                          <label className="streamdeck-control">
                            <span>Target page</span>
                            <select
                              aria-label="Stream Deck jump target page"
                              value={String(
                                streamDeckSelectedButton.action.targetPage ?? 0,
                              )}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "page_jump",
                                    targetPage: Number(event.target.value),
                                  },
                                }))
                              }
                            >
                              {(streamDeckSettings?.pages ?? [])
                                .map((p) => p.page)
                                .sort((a, b) => a - b)
                                .map((pageNo, idx) => (
                                  <option key={`sd-jump-page-${pageNo}`} value={String(pageNo)}>
                                    {(streamDeckSettings?.pages ?? []).find((page) => page.page === pageNo)?.title?.trim() || `Page ${idx + 1}`}
                                  </option>
                                ))}
                            </select>
                          </label>
                        ) : null}
                          </div>
                        </div>
                        </fieldset>
                      </div>
                    )}
                    </div>
                  ) : null}
                </div>
              </section>

              <div className="audio-section">
                <div className={`audio-box ${isAudioOpen ? "" : "collapsed"}`}>
                  <div className="audio-box-header">
                    <button
                      type="button"
                      className="audio-box-toggle"
                      onClick={() => setIsAudioOpen((v) => !v)}
                      aria-expanded={isAudioOpen}
                    >
                      Sound settings
                      <span className={`chev ${isAudioOpen ? "open" : ""}`}>▾</span>
                    </button>
                  </div>
                  {isAudioOpen ? (
                    <div className="audio-box-body">
                      <div className="audio-left">
                        <h4>Microphone</h4>
                        <div className="audio-row audio-row-mic">
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
                              <span>v</span>
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
                                    title={
                                      d.label || `Mic ${d.deviceId.slice(0, 6)}`
                                    }
                                  >
                                    {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="input-level-row" aria-live="polite">
                          <div className="input-level-head">
                            <small>Input level</small>
                            <strong>{formatDbFs(inputLevelDbFs)}</strong>
                          </div>
                          <div className="meter">
                            <div
                              className="meter-bar"
                              style={{
                                width: `${meterDbFsToPercent(inputLevelDbFs)}%`,
                              }}
                            />
                          </div>
                          <small
                            className={`input-level-status ${inputClipping ? "is-clipping" : "is-ok"}`}
                          >
                            {inputClipping
                              ? "audio clipping"
                              : "audio level ok"}
                          </small>
                        </div>
                        <div className="local-monitor-control">
                          <small className="local-monitor-hint">
                            Use headphones before starting the test.
                          </small>
                          <button
                            type="button"
                            className={`local-monitor-btn${isLocalMonitorActive ? " active" : ""}`}
                            onClick={onToggleLocalMonitor}
                          >
                            {isLocalMonitorActive
                              ? "Stop audio test"
                              : "Test microphone"}
                          </button>
                          {isLocalMonitorActive ? (
                            <small className="local-monitor-status">
                              You are hearing yourself — adjust headset and
                              check gain.
                            </small>
                          ) : null}
                        </div>
                        <div className="station-gain-control input-gain-control">
                          <label htmlFor="input-gain">
                            {gainToDbLabel(inputGain, INPUT_DB_MAX)}
                          </label>
                          <input
                            id="input-gain"
                            type="range"
                            min={MUTE_POS}
                            max={INPUT_DB_MAX}
                            step={1}
                            value={gainToSlider(inputGain, INPUT_DB_MAX)}
                            style={
                              {
                                "--fill": `${sliderFillPercent(inputGain, INPUT_DB_MAX)}%`,
                              } as React.CSSProperties
                            }
                            onChange={(event) =>
                              onInputGainChange(
                                selectedInputDeviceId,
                                sliderToGain(
                                  Number(event.currentTarget.value),
                                  INPUT_DB_MAX,
                                ),
                              )
                            }
                            aria-label="Input gain"
                          />
                        </div>
                        <div className="local-monitor-control">
                          <label>
                            <input
                              type="checkbox"
                              checked={audioGateEnabled}
                              onChange={(event) =>
                                onAudioGateEnabledChange(
                                  event.currentTarget.checked,
                                )
                              }
                            />{" "}
                            Noise gate
                          </label>
                          <small className="local-monitor-hint">
                            Cuts low-level background noise before mic gain.
                          </small>
                        </div>
                        <div className="station-gain-control input-gain-control">
                          <label htmlFor="input-gate-threshold">
                            Gate threshold {formatGateThresholdDb(audioGateThresholdDb)}
                          </label>
                          <input
                            id="input-gate-threshold"
                            type="range"
                            min={-72}
                            max={-12}
                            step={1}
                            value={audioGateThresholdDb}
                            disabled={!audioGateEnabled}
                            onChange={(event) =>
                              onAudioGateThresholdDbChange(
                                Number(event.currentTarget.value),
                              )
                            }
                            aria-label="Microphone gate threshold"
                          />
                        </div>
                      </div>
                      <div className="audio-right">
                        <h4>Speaker output</h4>
                        <div className="mic-dropdown" ref={outputMenuRef}>
                          <button
                            type="button"
                            className="mic-dropdown-trigger"
                            onClick={() => setIsOutputMenuOpen((v) => !v)}
                            disabled={outputDevices.length === 0}
                            aria-haspopup="listbox"
                            aria-expanded={isOutputMenuOpen}
                          >
                            <span>{selectedOutputLabel}</span>
                            <span>v</span>
                          </button>
                          {isOutputMenuOpen ? (
                            <div className="mic-dropdown-menu" role="listbox">
                              <button
                                type="button"
                                className={`mic-dropdown-item ${selectedOutputDeviceId === "" ? "active" : ""}`}
                                onClick={() => {
                                  setSelectedOutputDeviceId("");
                                  setIsOutputMenuOpen(false);
                                }}
                                title="System default"
                              >
                                System default
                              </button>
                              {outputDevices.map((d) => (
                                <button
                                  type="button"
                                  key={d.deviceId}
                                  className={`mic-dropdown-item ${d.deviceId === selectedOutputDeviceId ? "active" : ""}`}
                                  onClick={() => {
                                    setSelectedOutputDeviceId(d.deviceId);
                                    setIsOutputMenuOpen(false);
                                  }}
                                  title={
                                    d.label ||
                                    `Output ${d.deviceId.slice(0, 6)}`
                                  }
                                >
                                  {d.label ||
                                    `Output ${d.deviceId.slice(0, 6)}`}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {!outputSelectionSupported ? (
                          <small
                            style={{ display: "block", marginTop: "0.5rem" }}
                          >
                            Explicit speaker selection is not supported by this
                            browser; using system default output.
                          </small>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <section className="station-settings-section station-settings-version">
                <h4 className="station-settings-section-title">App Version</h4>
                <small>{appData.appVersion.version}</small>
                <small className="station-settings-build">
                  Built: {appData.appVersion.buildTimestamp}
                </small>
              </section>

              <p className="station-modal-hint">
                Preferences apply only to you on this device.
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

