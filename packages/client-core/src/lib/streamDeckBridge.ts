import type { StreamDeckActionType, StreamDeckSettings } from "../types";

export const streamDeckButtonEventName = "kesher-streamdeck-button";

export type StreamDeckBridgeButtonEvent = {
  kind: "button";
  page?: number;
  buttonIndex: number;
  state: "down" | "up";
};

export type StreamDeckBridgeConnectionEvent = {
  kind: "connection";
  connected: boolean;
  message?: string;
};

export type StreamDeckBridgeEvent =
  | StreamDeckBridgeButtonEvent
  | StreamDeckBridgeConnectionEvent;

const streamDeckActionTypes: StreamDeckActionType[] = [
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
];

export function parseStreamDeckBridgeEvent(
  payload: unknown,
): StreamDeckBridgeEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;

  // Optional source gate for postMessage inputs.
  if (raw.source != null && raw.source !== "kesher-streamdeck") {
    return null;
  }

  const type = typeof raw.type === "string" ? raw.type : "";
  if (type === "connection") {
    const status = typeof raw.status === "string" ? raw.status : "";
    if (!status) return null;
    return {
      kind: "connection",
      connected: status === "connected",
      message: typeof raw.message === "string" ? raw.message : undefined,
    };
  }

  if (type === "button" || type === "key") {
    const buttonIndexRaw =
      typeof raw.buttonIndex === "number"
        ? raw.buttonIndex
        : typeof raw.key === "number"
          ? raw.key
          : -1;
    const state = typeof raw.state === "string" ? raw.state : "";
    const page = typeof raw.page === "number" ? raw.page : undefined;
    if (!Number.isInteger(buttonIndexRaw) || buttonIndexRaw < 0) {
      return null;
    }
    if (state !== "down" && state !== "up") {
      return null;
    }
    return {
      kind: "button",
      page,
      buttonIndex: buttonIndexRaw,
      state,
    };
  }

  return null;
}

export function resolveStreamDeckButtonAction(
  settings: StreamDeckSettings,
  page: number,
  buttonIndex: number,
): {
  type: StreamDeckActionType;
  roomId?: string;
  userId?: string;
  roleId?: string;
  broadcastGroupId?: string;
  volumeDelta?: number;
  targetPage?: number;
} | null {
  const selectedPage = settings.pages.find((entry) => entry.page === page);
  if (!selectedPage) return null;
  const button = selectedPage.buttons.find((entry) => entry.index === buttonIndex);
  if (!button?.action) return null;
  if (!streamDeckActionTypes.includes(button.action.type)) {
    return null;
  }
  return button.action;
}

export function gainWithDbDelta(currentGain: number, deltaDb: number): number {
  const safeCurrent = Number.isFinite(currentGain) && currentGain > 0 ? currentGain : 1;
  const currentDb = 20 * Math.log10(safeCurrent);
  const nextDb = Math.max(-60, Math.min(6, currentDb + deltaDb));
  const nextGain = Math.pow(10, nextDb / 20);
  return Math.max(0, Math.min(2, nextGain));
}
