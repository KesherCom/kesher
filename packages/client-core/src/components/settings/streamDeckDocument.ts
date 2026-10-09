import type {
  StreamDeckActionType,
  StreamDeckButtonConfig,
  StreamDeckPageType,
  StreamDeckSettings,
} from "../../types";

export const STREAM_DECK_IMPORT_FORMAT = "kesher-user-streamdeck";
export const STREAM_DECK_IMPORT_SCHEMA_VERSION = 1;

export type StreamDeckImportDocument = {
  meta?: {
    format?: string;
    schemaVersion?: number;
    exportedAt?: string;
    username?: string;
  };
  settings?: unknown;
};

export function normalizeImportedStreamDeckSettings(
  input: unknown,
): StreamDeckSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : null;
  if (!pagesRaw || pagesRaw.length === 0) {
    throw new Error("Import failed: settings.pages must be a non-empty array.");
  }
  const gridColumns = Number(raw.gridColumns);
  const gridRows = Number(raw.gridRows);
  if (gridColumns !== 5 || gridRows !== 3) {
    throw new Error(
      "Import failed: only 5x3 Stream Deck layouts are supported.",
    );
  }

  const selectedPage = Number(raw.selectedPage);
  if (!Number.isInteger(selectedPage) || selectedPage < 0) {
    throw new Error(
      "Import failed: selectedPage must be a non-negative integer.",
    );
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
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      !buttonsRaw ||
      buttonsRaw.length !== 15
    ) {
      throw new Error(
        "Import failed: each page must have a valid page id and exactly 15 buttons.",
      );
    }
    const seenIndices = new Set<number>();
    const buttons = buttonsRaw.map((buttonEntry) => {
      const buttonRaw = (buttonEntry ?? {}) as Record<string, unknown>;
      const index = Number(buttonRaw.index);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= 15 ||
        seenIndices.has(index)
      ) {
        throw new Error(
          "Import failed: button indices must be unique integers from 0 to 14.",
        );
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
      if (
        typeof type !== "string" ||
        !actionTypes.has(type as StreamDeckActionType)
      ) {
        throw new Error("Import failed: unsupported button action type.");
      }

      return {
        index,
        label: typeof buttonRaw.label === "string" ? buttonRaw.label : "",
        color: typeof buttonRaw.color === "string" ? buttonRaw.color : "",
        action: {
          type: type as StreamDeckActionType,
          roomId:
            typeof actionRaw.roomId === "string" ? actionRaw.roomId : undefined,
          userId:
            typeof actionRaw.userId === "string" ? actionRaw.userId : undefined,
          roleId:
            typeof actionRaw.roleId === "string" ? actionRaw.roleId : undefined,
          broadcastGroupId:
            typeof actionRaw.broadcastGroupId === "string"
              ? actionRaw.broadcastGroupId
              : undefined,
          volumeDelta:
            typeof actionRaw.volumeDelta === "number" &&
            Number.isFinite(actionRaw.volumeDelta)
              ? actionRaw.volumeDelta
              : undefined,
          targetPage:
            typeof actionRaw.targetPage === "number" &&
            Number.isFinite(actionRaw.targetPage)
              ? actionRaw.targetPage
              : undefined,
        },
      };
    });

    const pageTypeCandidate =
      typeof pageRaw.pageType === "string" ? pageRaw.pageType : "manual";
    const pageType =
      pageTypeCandidate === "all_roles" ||
      pageTypeCandidate === "all_party_lines"
        ? (pageTypeCandidate as StreamDeckPageType)
        : ("manual" as StreamDeckPageType);
    const parentPage = Number(pageRaw.parentPage);

    return {
      page,
      title: typeof pageRaw.title === "string" ? pageRaw.title : "",
      pageType,
      parentPage:
        Number.isInteger(parentPage) && parentPage >= 0
          ? parentPage
          : undefined,
      buttons,
    };
  });

  if (!normalizedPages.some((entry) => entry.page === selectedPage)) {
    throw new Error("Import failed: selectedPage does not exist in pages.");
  }

  return {
    version:
      typeof raw.version === "number" &&
      Number.isFinite(raw.version) &&
      raw.version > 0
        ? raw.version
        : 1,
    gridColumns,
    gridRows,
    selectedPage,
    pages: normalizedPages,
  };
}

export function parseStreamDeckImportDocument(
  text: string,
): StreamDeckSettings {
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
      throw new Error(
        `Import failed: expected format ${STREAM_DECK_IMPORT_FORMAT}.`,
      );
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

export function createEmptyStreamDeckButtons(count: number) {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

export function cloneStreamDeckButtonConfig(
  button: StreamDeckButtonConfig,
): StreamDeckButtonConfig {
  return {
    ...button,
    action: button.action ? { ...button.action } : undefined,
  };
}

export function cloneStreamDeckSettings(
  settings: StreamDeckSettings,
): StreamDeckSettings {
  return {
    ...settings,
    pages: settings.pages.map((page) => ({
      ...page,
      buttons: page.buttons.map((button) =>
        cloneStreamDeckButtonConfig(button),
      ),
    })),
  };
}

export function streamDeckPreviewSignature(
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
