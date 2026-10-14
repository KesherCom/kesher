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
} from "../../types";
import { renderStreamDeckPreviewImages } from "../../api";
import {
  resolveActionLabel,
  splitStreamDeckLabel,
  withResolvedStreamDeckButtonLabel,
} from "../../lib/streamDeckLabels";
import { sortDirectUsersByRoleAndUsername } from "../../lib/users";
import type { AutosaveState } from "../../hooks/useAutosave";
import { StreamDeckPlaceBar } from "../StreamDeckPlaceBar";
import { StreamDeckActionPicker } from "./StreamDeckActionPicker";
import { addFolder, isFixedBackKey, pageTree } from "../../lib/streamDeckPages";
import { Icon } from "../Icon";
import { NativeStreamDeckStatus } from "../NativeStreamDeckStatus";
import type { NativeStreamDeckState } from "../../hooks/useNativeStreamDeck";
import {
  STREAM_DECK_IMPORT_FORMAT,
  STREAM_DECK_IMPORT_SCHEMA_VERSION,
  cloneStreamDeckButtonConfig,
  cloneStreamDeckSettings,
  createEmptyStreamDeckButtons,
  parseStreamDeckImportDocument,
  streamDeckPreviewSignature,
} from "./streamDeckDocument";

export type StreamDeckSettingsProps = {
  token: string;
  appData: Bootstrap;
  presence: Presence[];
  /** People online except yourself, for the hints next to roles. */
  onlineUsers: Presence[];
  roleNameById: Map<string, string>;
  broadcastGroups: BroadcastGroup[];
  listenRoomIds: string[];
  talkRoomIds: string[];
  showDebug: boolean;
  streamDeckSettings: StreamDeckSettings | null;
  streamDeckBusy: boolean;
  streamDeckError: string;
  onStreamDeckSettingsChange: (next: StreamDeckSettings) => void;
  /** Edits save themselves; see streamDeckSaveState. */
  streamDeckSaveState: AutosaveState;
  /** Save now: the retry after a failed save. */
  onSaveStreamDeckSettings: () => void;
  onResetStreamDeckSettings: () => void;
  /** A Companion Stream Deck was paired with or released from this place. */
  onStreamDeckPlaceChanged?: () => void;
  /** Desktop app: the deck plugged into this PC (decision 0008). */
  nativeDeck?: NativeStreamDeckState;
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

/**
 * Frame colors a key can get. They only tell keys apart; red, green and
 * yellow are left out because on a key they mean talking, hearing and a
 * call (docs/design, section 6).
 */
const keyFrameColors: Array<{ name: string; value: string }> = [
  { name: "Automatic", value: "" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Slate", value: "#94a3b8" },
  { name: "White", value: "#e6eaf0" },
];

/**
 * Changes one line of a stored key label ("name\nsecond line") while the
 * user types; trimming happens when the layout is saved.
 */
function editLabel(
  label: string | undefined,
  change: { name?: string; subtitle?: string },
): string {
  const [name = "", subtitle = ""] = (label ?? "").split(/\r?\n/);
  const nextName = change.name ?? name;
  const nextSubtitle = change.subtitle ?? subtitle;
  return nextSubtitle ? `${nextName}\n${nextSubtitle}` : nextName;
}

const saveStateLabels: Record<AutosaveState, string> = {
  saved: "All changes saved",
  pending: "Unsaved changes…",
  saving: "Saving…",
  error: "Not saved",
};

/**
 * The Stream Deck of this place: pairing, the layout editor and a browser
 * test mode. The layout belongs to the place, not to the person
 * (docs/decisions/0006-shared-roles-and-stream-decks-per-place.md).
 */
export function StreamDeckSettingsSection({
  token,
  appData,
  presence,
  onlineUsers,
  roleNameById,
  broadcastGroups,
  listenRoomIds,
  talkRoomIds,
  showDebug,
  streamDeckSettings,
  streamDeckBusy,
  streamDeckError,
  onStreamDeckSettingsChange,
  streamDeckSaveState,
  onSaveStreamDeckSettings,
  onResetStreamDeckSettings,
  onStreamDeckPlaceChanged,
  nativeDeck,
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
}: StreamDeckSettingsProps) {
  const [streamDeckTestMode, setStreamDeckTestMode] = useState(false);
  const streamDeckImportInputRef = useRef<HTMLInputElement>(null);
  const [streamDeckTransferMessage, setStreamDeckTransferMessage] =
    useState("");
  const [streamDeckTransferError, setStreamDeckTransferError] = useState("");
  const [companionPublishBusy, setCompanionPublishBusy] = useState(false);
  const [streamDeckPreviewPressedIndexes, setStreamDeckPreviewPressedIndexes] =
    useState<number[]>([]);
  const [streamDeckSelectedButtonIndex, setStreamDeckSelectedButtonIndex] =
    useState(0);
  const [streamDeckClipboardButton, setStreamDeckClipboardButton] =
    useState<StreamDeckButtonConfig | null>(null);
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
      ) ||
      streamDeckCurrentButtons[0] ||
      null,
    [streamDeckCurrentButtons, streamDeckSelectedButtonIndex],
  );

  // Untrimmed, so a space typed at the end of the name stays.
  const [selectedName = "", selectedSubtitle = ""] = (
    streamDeckSelectedButton?.label ?? ""
  ).split(/\r?\n/);
  const selectedLabelParts = { name: selectedName, subtitle: selectedSubtitle };
  const selectedAutomaticName = streamDeckSelectedButton
    ? (
        resolveActionLabel(streamDeckSelectedButton.action, {
          rooms: appData.rooms,
          roles: appData.roles,
          users: appData.users,
          activeUsers: [],
          broadcastGroups,
        }) ?? ""
      )
        .split("\n")[0]
        .trim()
    : "";

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
          volumeDelta: rawButton.action?.volumeDelta,
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
      volumeDelta?: number;
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
    const previousSettings =
      streamDeckUndoStack[streamDeckUndoStack.length - 1];
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
    if (
      !streamDeckSettings ||
      !streamDeckCurrentPage ||
      !streamDeckSelectedButton
    ) {
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
    setStreamDeckClipboardButton(
      cloneStreamDeckButtonConfig(streamDeckSelectedButton),
    );
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

  const selectStreamDeckPage = (pageNo: number) => {
    if (!streamDeckSettings || pageNo === streamDeckSettings.selectedPage) {
      return;
    }
    applyStreamDeckSettings(
      { ...streamDeckSettings, selectedPage: pageNo },
      { recordUndo: false },
    );
  };

  const addStreamDeckPage = () => {
    if (!streamDeckSettings) return;
    const existing = new Set(streamDeckSettings.pages.map((page) => page.page));
    let nextPageNumber = 0;
    while (existing.has(nextPageNumber)) {
      nextPageNumber += 1;
    }
    const buttonCount =
      streamDeckSettings.gridColumns * streamDeckSettings.gridRows;
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
        message: `${file.name} loaded.`,
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

  const streamDeckPageTree = streamDeckSettings
    ? pageTree(streamDeckSettings)
    : [];
  const currentPageEntry = streamDeckPageTree.find(
    (entry) => entry.page === streamDeckCurrentPage?.page,
  );
  const currentIsAutoPage =
    !!streamDeckCurrentPage?.pageType &&
    streamDeckCurrentPage.pageType !== "manual";
  // Key 1 of a page that fills itself (the server's companionAutoPageExit).
  const mainPages = streamDeckPageTree.filter((entry) => !entry.isFolder);
  const autoPageExit: "back" | "next" | null = currentPageEntry?.isFolder
    ? "back"
    : mainPages.length < 2
      ? null
      : [...mainPages].sort((a, b) => a.page - b.page)[0]?.page ===
          streamDeckCurrentPage?.page
        ? "next"
        : "back";
  const currentParentEntry = streamDeckPageTree.find(
    (entry) => entry.page === streamDeckCurrentPage?.parentPage,
  );
  const keyIsFixedBack = (index: number) =>
    !!streamDeckSettings &&
    !!streamDeckCurrentPage &&
    isFixedBackKey(streamDeckSettings, streamDeckCurrentPage.page, index);

  // Key 1 of a folder is Back and cannot be set up: select key 2 instead.
  const selectedIsFixedBack = keyIsFixedBack(streamDeckSelectedButtonIndex);
  useEffect(() => {
    if (selectedIsFixedBack) setStreamDeckSelectedButtonIndex(1);
  }, [selectedIsFixedBack]);

  /** New folder below the current page, opened by the selected key. */
  const createFolderForSelectedKey = () => {
    if (!streamDeckSettings || !streamDeckCurrentPage || !streamDeckSelectedButton) {
      return;
    }
    const { settings } = addFolder(
      streamDeckSettings,
      streamDeckCurrentPage.page,
      streamDeckSelectedButton.index,
    );
    applyStreamDeckSettings(settings);
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      "Folder created. Open its tab to put keys in it.",
    );
  };

  return (
    <>
      {/* 1. Where the layout stands, and the rarely used actions. */}
      <div className="sd-header">
        <span
          className={`streamdeck-save-state ${streamDeckSaveState}`}
          role="status"
        >
          {saveStateLabels[streamDeckSaveState]}
        </span>
        {streamDeckSaveState === "error" ? (
          <button
            type="button"
            className="secondary"
            onClick={onSaveStreamDeckSettings}
          >
            Try again
          </button>
        ) : null}
        <div className="sd-header-actions">
          <button
            type="button"
            className="secondary"
            onClick={undoLastStreamDeckChange}
            disabled={streamDeckUndoStack.length === 0}
          >
            Undo
          </button>
          <details className="k-more">
            <summary className="secondary">More</summary>
            <div className="k-more-menu">
              <button
                type="button"
                className="secondary"
                onClick={exportStreamDeckSettings}
                disabled={streamDeckBusy || !streamDeckSettings}
              >
                Export
              </button>
              <button
                type="button"
                className="secondary"
                onClick={openStreamDeckImportPicker}
                disabled={streamDeckBusy || !streamDeckSettings}
              >
                Import
              </button>
              {streamDeckWebHidSupported ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={
                    streamDeckWebHidActive
                      ? onDisconnectStreamDeckWebHid
                      : onConnectStreamDeckWebHid
                  }
                  disabled={streamDeckWebHidBusy}
                >
                  {streamDeckWebHidBusy
                    ? "Working…"
                    : streamDeckWebHidActive
                      ? "Disconnect USB deck"
                      : "Connect USB deck"}
                </button>
              ) : null}
              <button
                type="button"
                className="danger"
                onClick={removeCurrentStreamDeckPage}
                disabled={
                  streamDeckBusy ||
                  !streamDeckSettings ||
                  streamDeckSettings.pages.length <= 1
                }
              >
                {currentPageEntry?.isFolder
                  ? "Remove this folder"
                  : "Remove this page"}
              </button>
              <button
                type="button"
                className="danger"
                onClick={onResetStreamDeckSettings}
                disabled={streamDeckBusy || !streamDeckSettings}
              >
                Reset layout
              </button>
            </div>
          </details>
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
        </div>
      </div>
      {streamDeckError ? (
        <small className="streamdeck-error">{streamDeckError}</small>
      ) : null}
      {streamDeckTransferError ? (
        <small className="streamdeck-error">{streamDeckTransferError}</small>
      ) : null}
      {streamDeckTransferMessage ? (
        <small className="k-setting-hint">{streamDeckTransferMessage}</small>
      ) : null}

      {!streamDeckSettings ? (
        <small className="k-setting-hint">Loading Stream Deck layout…</small>
      ) : (
        <div className="streamdeck-editor-shell">
          {/* 2. Pages as tabs; their details fold away. */}
          <div className="sd-pages" role="tablist" aria-label="Pages">
            {streamDeckPageTree.map((entry) => (
              <button
                key={`sd-page-tab-${entry.page}`}
                type="button"
                role="tab"
                aria-selected={entry.page === streamDeckCurrentPage?.page}
                className={`sd-page-tab ${entry.page === streamDeckCurrentPage?.page ? "active" : ""} ${entry.isFolder ? "folder" : ""}`}
                onClick={() => selectStreamDeckPage(entry.page)}
                disabled={streamDeckBusy}
              >
                {entry.isFolder ? <Icon name="folder" /> : null}
                {entry.label}
              </button>
            ))}
            <button
              type="button"
              className="sd-page-tab sd-page-add"
              aria-label="Add page"
              title="Add page"
              onClick={addStreamDeckPage}
              disabled={streamDeckBusy}
            >
              +
            </button>
          </div>
          {streamDeckCurrentPage ? (
            <div className="sd-page-bar">
              <label className="streamdeck-control sd-page-title">
                <span>{currentPageEntry?.isFolder ? "Folder name" : "Page name"}</span>
                <input
                  type="text"
                  aria-label="Page name"
                  value={streamDeckCurrentPage.title || ""}
                  onChange={(event) =>
                    updateStreamDeckCurrentPageMeta((page) => ({
                      ...page,
                      title: event.target.value,
                    }))
                  }
                  placeholder={currentPageEntry?.label ?? "Name"}
                />
              </label>
              <div className="streamdeck-control">
                <span>Keys</span>
                <div className="sd-segmented" role="group" aria-label="Page content">
                  {(
                    [
                      ["manual", "Set up here"],
                      ["all_party_lines", "All party lines"],
                      ["all_roles", "All roles"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className="secondary"
                      aria-pressed={(streamDeckCurrentPage.pageType || "manual") === value}
                      onClick={() =>
                        updateStreamDeckCurrentPageMeta((page) => ({
                          ...page,
                          pageType: value as StreamDeckPageType,
                        }))
                      }
                      disabled={streamDeckBusy}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {currentPageEntry?.isFolder ? (
                <small className="k-setting-hint sd-page-note">
                  Folder of “{currentParentEntry?.label ?? "a page"}”. A key
                  there opens it; key 1 here is always Back. Next/previous
                  page does not walk into folders.
                </small>
              ) : null}
            </div>
          ) : null}

          {/* 3. The keys, and the selected key's settings beside them. */}
          {currentIsAutoPage ? (
            <p className="sd-auto-page">
              {streamDeckCurrentPage?.pageType === "all_roles"
                ? "This page fills itself with a key for every role you may call (hold to talk to it)."
                : "This page fills itself with a key for every party line you may talk on (hold to talk)."}{" "}
              Key 1 is{" "}
              {autoPageExit === "back"
                ? "Back"
                : autoPageExit === "next"
                  ? "Next page (this is the first page)"
                  : "free (this is the only page)"}
              ; when the keys do not fit, the last two turn into previous / next.
            </p>
          ) : (
          <fieldset className="streamdeck-layout">
            <div className="sd-grid-column">
              <div
                className="streamdeck-grid"
                role="grid"
                aria-label="Stream Deck 5x3 grid"
              >
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
                      draggable={!streamDeckTestMode && !keyIsFixedBack(button.index)}
                      disabled={keyIsFixedBack(button.index)}
                      title={
                        keyIsFixedBack(button.index)
                          ? "Key 1 of a folder is always Back"
                          : undefined
                      }
                      onClick={() =>
                        setStreamDeckSelectedButtonIndex(button.index)
                      }
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
                      {keyIsFixedBack(button.index) ? (
                        <span className="sd-back-key">Back</span>
                      ) : previewImage ? (
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
              <div className="sd-grid-foot">
                <small className="k-setting-hint">
                  {streamDeckTestMode
                    ? "Hold a key: it acts like the real deck."
                    : "Click a key to set it up. Drag a key onto another to swap them."}
                </small>
                <button
                  type="button"
                  className={`secondary ${streamDeckTestMode ? "active" : ""}`}
                  onClick={() => setStreamDeckTestMode((value) => !value)}
                  disabled={streamDeckBusy}
                  aria-pressed={streamDeckTestMode}
                >
                  Try keys here
                </button>
              </div>
            </div>

            <div className="streamdeck-editor panel">
              <div className="sd-key-head">
                {streamDeckSelectedButton &&
                streamDeckPreviewImageByIndex.get(
                  streamDeckSelectedButton.index,
                ) ? (
                  <img
                    src={streamDeckPreviewImageByIndex.get(
                      streamDeckSelectedButton.index,
                    )}
                    alt={`Key ${streamDeckSelectedButton.index + 1} at about its real size`}
                    title="About the real size on the deck"
                    width={72}
                    height={72}
                  />
                ) : (
                  <span className="streamdeck-actual-size-empty" />
                )}
                <div className="sd-key-title">
                  <h5>Key {(streamDeckSelectedButton?.index || 0) + 1}</h5>
                  <div className="streamdeck-editor-actions">
                    <button
                      type="button"
                      className="sd-text-button"
                      onClick={copySelectedStreamDeckButton}
                      disabled={!streamDeckSelectedButton}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      className="sd-text-button"
                      onClick={pasteIntoSelectedStreamDeckButton}
                      disabled={
                        !streamDeckSelectedButton || !streamDeckClipboardButton
                      }
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      className="sd-text-button"
                      onClick={clearSelectedStreamDeckButton}
                      disabled={!streamDeckSelectedButton}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              <section className="sd-key-section">
                <h6>What it does</h6>
                <StreamDeckActionPicker
                  action={streamDeckSelectedButton?.action}
                  disabled={!streamDeckSelectedButton}
                  rooms={appData.rooms.map((room) => ({
                    value: room.id,
                    label: room.name,
                  }))}
                  users={sortDirectUsersByRoleAndUsername(
                    appData.users,
                    roleNameById,
                  ).map((user) => ({
                    value: user.id,
                    label: `${user.username} (${roleNameById.get(user.roleId) ?? user.roleId})`,
                  }))}
                  roles={appData.roles.map((role) => {
                    const online = onlineUsers
                      .filter((entry) => entry.roleId === role.id)
                      .map((entry) => entry.username);
                    return {
                      value: role.id,
                      label:
                        online.length > 0
                          ? `${role.name} (${online.join(", ")})`
                          : role.name,
                    };
                  })}
                  groups={broadcastGroups.map((group) => ({
                    value: group.id,
                    label: group.name,
                  }))}
                  pages={streamDeckPageTree.map((entry) => ({
                    value: String(entry.page),
                    label: `${"\u2003".repeat(entry.depth)}${entry.isFolder ? "Folder: " : ""}${entry.label}`,
                  }))}
                  onNewFolder={createFolderForSelectedKey}
                  onChange={(action) =>
                    updateStreamDeckSelectedButton((button) => ({
                      ...button,
                      action,
                    }))
                  }
                />
              </section>

              <section className="sd-key-section">
                <h6>How it looks</h6>
                <label className="streamdeck-control">
                  <span>Name</span>
                  <input
                    type="text"
                    aria-label="Key name"
                    value={selectedLabelParts.name}
                    onChange={(event) =>
                      updateStreamDeckSelectedButton((button) => ({
                        ...button,
                        label: editLabel(button.label, {
                          name: event.target.value,
                        }),
                      }))
                    }
                    placeholder={
                      selectedAutomaticName
                        ? `Automatic: ${selectedAutomaticName}`
                        : "Name on the key"
                    }
                  />
                </label>
                <label className="streamdeck-control">
                  <span>Second line</span>
                  <input
                    type="text"
                    aria-label="Key second line"
                    value={selectedLabelParts.subtitle}
                    onChange={(event) =>
                      updateStreamDeckSelectedButton((button) => ({
                        ...button,
                        label: editLabel(button.label, {
                          subtitle: event.target.value,
                        }),
                      }))
                    }
                    placeholder="Optional, smaller below the name"
                  />
                </label>
                <div className="streamdeck-control">
                  <span id="streamdeck-color-label">Frame color</span>
                  <div
                    className="streamdeck-colors"
                    role="radiogroup"
                    aria-labelledby="streamdeck-color-label"
                  >
                    {keyFrameColors.map((option) => {
                      const current = (
                        streamDeckSelectedButton?.color || ""
                      ).toLowerCase();
                      const checked = current === option.value;
                      return (
                        <button
                          key={option.value || "auto"}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          aria-label={option.name}
                          title={option.name}
                          className={`streamdeck-color ${checked ? "checked" : ""} ${option.value ? "" : "auto"}`}
                          style={
                            option.value
                              ? ({
                                  "--swatch": option.value,
                                } as React.CSSProperties)
                              : undefined
                          }
                          onClick={() =>
                            updateStreamDeckSelectedButton((button) => ({
                              ...button,
                              color: option.value,
                            }))
                          }
                        >
                          {option.value ? null : "Auto"}
                        </button>
                      );
                    })}
                    {(() => {
                      // A color set before (or imported) that is not in
                      // the list stays visible and selected.
                      const own = (
                        streamDeckSelectedButton?.color || ""
                      ).toLowerCase();
                      if (
                        !own ||
                        keyFrameColors.some((option) => option.value === own)
                      ) {
                        return null;
                      }
                      return (
                        <button
                          type="button"
                          role="radio"
                          aria-checked
                          aria-label={`Own color ${own}`}
                          title={`Own color ${own}`}
                          className="streamdeck-color checked"
                          style={{ "--swatch": own } as React.CSSProperties}
                        />
                      );
                    })()}
                  </div>
                  <small className="k-setting-hint">
                    Only to tell keys apart. Red, green and yellow are kept for
                    talking, hearing and calls.
                  </small>
                </div>
              </section>
            </div>
          </fieldset>
          )}
        </div>
      )}

      {/* 4. The deck on this PC (desktop app), then Companion decks. */}
      {nativeDeck ? <NativeStreamDeckStatus deck={nativeDeck} /> : null}
      <StreamDeckPlaceBar
        token={token}
        onChanged={() => onStreamDeckPlaceChanged?.()}
      />

      {showDebug ? (
        <div className="k-setting-diagnostics">
          <small>
            USB (WebHID):{" "}
            {streamDeckWebHidSupported
              ? streamDeckWebHidActive
                ? "connected"
                : "ready"
              : "not supported"}
            {" · "}Input: {streamDeckBridgeConnected ? "connected" : "waiting"}
            {streamDeckBridgeLastEvent
              ? ` · Last event: ${streamDeckBridgeLastEvent}`
              : ""}
          </small>
          {lastCompanionCommand ? (
            <small>
              Companion: {lastCompanionCommand.command || "unknown"}
              {` · ${lastCompanionCommand.status}`}
              {lastCompanionCommand.error
                ? ` · ${lastCompanionCommand.error}`
                : ""}
              {` · ${new Date(lastCompanionCommand.at).toLocaleTimeString()}`}
            </small>
          ) : null}
          <small>
            Console: window.__kesherStreamDeckDev.buttonTap(0, 0),
            buttonDown/buttonUp, listHidDevices(), requestAndListHidDevices().
          </small>
          <button
            type="button"
            className="secondary"
            onClick={() => void publishCompanionProfile()}
            disabled={
              streamDeckBusy || companionPublishBusy || !streamDeckSettings
            }
          >
            {companionPublishBusy
              ? "Publishing…"
              : "Publish to Companion again"}
          </button>
        </div>
      ) : null}
    </>
  );
}
