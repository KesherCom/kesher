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
  splitStreamDeckLabel,
  withResolvedStreamDeckButtonLabel,
} from "../../lib/streamDeckLabels";
import { sortDirectUsersByRoleAndUsername } from "../../lib/users";
import { StreamDeckPlaceBar } from "../StreamDeckPlaceBar";
import { SettingsGroup } from "./SettingsParts";
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
  onSaveStreamDeckSettings: () => void;
  onResetStreamDeckSettings: () => void;
  /** A Companion Stream Deck was paired with or released from this place. */
  onStreamDeckPlaceChanged?: () => void;
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
  onSaveStreamDeckSettings,
  onResetStreamDeckSettings,
  onStreamDeckPlaceChanged,
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
          button.action?.type === "page_jump" &&
          button.action.targetPage !== undefined
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
    if (
      nextPage === undefined ||
      nextPage === streamDeckSettings.selectedPage
    ) {
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

  return (
    <>
      <StreamDeckPlaceBar
        token={token}
        onChanged={() => onStreamDeckPlaceChanged?.()}
      />
      <SettingsGroup title="Layout">
        <div className="k-setting-actions">
          <button
            type="button"
            className="primary"
            onClick={onSaveStreamDeckSettings}
            disabled={streamDeckBusy || !streamDeckSettings}
          >
            Save
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

        {streamDeckError ? (
          <small className="streamdeck-error">{streamDeckError}</small>
        ) : null}
        {streamDeckTransferError ? (
          <small className="streamdeck-error">{streamDeckTransferError}</small>
        ) : null}
        {streamDeckTransferMessage ? (
          <small className="k-setting-hint">{streamDeckTransferMessage}</small>
        ) : null}
        {showDebug ? (
          <div className="k-setting-diagnostics">
            <small>
              USB (WebHID):{" "}
              {streamDeckWebHidSupported
                ? streamDeckWebHidActive
                  ? "connected"
                  : "ready"
                : "not supported"}
              {" · "}Input:{" "}
              {streamDeckBridgeConnected ? "connected" : "waiting"}
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
        {!streamDeckSettings ? (
          <small className="k-setting-hint">Loading Stream Deck layout…</small>
        ) : (
          <div className="streamdeck-editor-shell">
            <fieldset>
              <div className="streamdeck-toolbar">
                <div className="streamdeck-page-nav" aria-label="Page selector">
                  <button
                    type="button"
                    className="secondary"
                    aria-label="Previous page"
                    onClick={() => goToStreamDeckPage(-1)}
                    disabled={
                      streamDeckBusy ||
                      streamDeckPageOrder[0] === streamDeckSettings.selectedPage
                    }
                  >
                    {"<"}
                  </button>
                  <span>Page {streamDeckSettings.selectedPage + 1}</span>
                  <button
                    type="button"
                    className="secondary"
                    aria-label="Next page"
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
                  className="secondary"
                  onClick={addStreamDeckPage}
                  disabled={streamDeckBusy}
                >
                  Add page
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={removeCurrentStreamDeckPage}
                  disabled={
                    streamDeckBusy || streamDeckSettings.pages.length <= 1
                  }
                >
                  Remove page
                </button>
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
              <small className="k-setting-hint">
                {streamDeckTestMode
                  ? "Press and hold a key below: it acts like the real Stream Deck."
                  : "Click a key to edit it. Drag one key onto another to swap them."}
              </small>
              {streamDeckCurrentPage ? (
                <div className="streamdeck-toolbar">
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
                      <option value="all_party_lines">
                        Auto folder: all party-lines
                      </option>
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
                        .filter(
                          (page) => page.page !== streamDeckCurrentPage.page,
                        )
                        .sort((a, b) => a.page - b.page)
                        .map((page, index) => (
                          <option
                            key={`sd-parent-page-${page.page}`}
                            value={String(page.page)}
                          >
                            {page.title?.trim() || `Page ${index + 1}`}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              ) : null}

              <div className="streamdeck-layout">
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
                        draggable={!streamDeckTestMode}
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
                  <h5>Button {(streamDeckSelectedButton?.index || 0) + 1}</h5>
                  <div className="streamdeck-editor-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={undoLastStreamDeckChange}
                      disabled={streamDeckUndoStack.length === 0}
                    >
                      Undo
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={copySelectedStreamDeckButton}
                      disabled={!streamDeckSelectedButton}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={pasteIntoSelectedStreamDeckButton}
                      disabled={
                        !streamDeckSelectedButton || !streamDeckClipboardButton
                      }
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      className="secondary"
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
                        <option value="select_talk_room">
                          Select talk channel
                        </option>
                        <option value="select_listen_room">
                          Select + listen channel (hold)
                        </option>
                        <option value="ptt_selected">
                          PTT selected channels
                        </option>
                        <option value="ptt_room">PTT fixed channel</option>
                        <option value="listen_room">Listen channel</option>
                        <option value="call_room">Call channel</option>
                      </optgroup>
                      <optgroup label="Direct communication">
                        <option value="direct_user">Direct user</option>
                        <option value="direct_role">Direct role</option>
                        <option value="reply_to_caller">Reply to caller</option>
                        <option value="incoming_call_indicator">
                          Incoming calls indicator
                        </option>
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
                  streamDeckSelectedButton?.action?.type ===
                    "select_talk_room" ||
                  streamDeckSelectedButton?.action?.type ===
                    "select_listen_room" ||
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
                              type:
                                streamDeckSelectedButton.action?.type ||
                                "ptt_room",
                              roomId: event.target.value,
                            },
                          }))
                        }
                      >
                        {appData.rooms.map((room) => (
                          <option
                            key={`streamdeck-room-${room.id}`}
                            value={room.id}
                          >
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
                        {sortDirectUsersByRoleAndUsername(
                          appData.users,
                          roleNameById,
                        ).map((user) => (
                          <option
                            key={`streamdeck-user-${user.id}`}
                            value={user.id}
                          >
                            {user.username} (
                            {roleNameById.get(user.roleId) ?? user.roleId})
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
                          const onlineRoleUsers = onlineUsers
                            .filter((entry) => entry.roleId === role.id)
                            .map((entry) => entry.username);
                          const onlineHint =
                            onlineRoleUsers.length > 0
                              ? ` (${onlineRoleUsers.join(", ")})`
                              : "";
                          return (
                            <option
                              key={`streamdeck-role-${role.id}`}
                              value={role.id}
                            >
                              {role.name}
                              {onlineHint}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  ) : null}

                  {streamDeckSelectedButton?.action?.type ===
                  "broadcast_ptt" ? (
                    <label className="streamdeck-control">
                      <span>Broadcast group</span>
                      <select
                        aria-label="Stream Deck broadcast target"
                        value={
                          streamDeckSelectedButton.action.broadcastGroupId || ""
                        }
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
                          <option
                            key={`streamdeck-group-${group.id}`}
                            value={group.id}
                          >
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
                            <option
                              key={`sd-jump-page-${pageNo}`}
                              value={String(pageNo)}
                            >
                              {(streamDeckSettings?.pages ?? [])
                                .find((page) => page.page === pageNo)
                                ?.title?.trim() || `Page ${idx + 1}`}
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
      </SettingsGroup>
    </>
  );
}
