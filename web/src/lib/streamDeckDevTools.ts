import { streamDeckButtonEventName } from "./streamDeckBridge";

export type StreamDeckDevToolsApi = {
  buttonDown: (page: number, buttonIndex: number) => void;
  buttonUp: (page: number, buttonIndex: number) => void;
  buttonTap: (page: number, buttonIndex: number) => void;
  setConnection: (connected: boolean, message?: string) => void;
  sendRaw: (payload: unknown) => void;
};

type MessageTarget = {
  dispatchEvent: (event: Event) => boolean;
  postMessage: (message: unknown, targetOrigin: string) => void;
};

function emitToBridge(target: MessageTarget, payload: unknown) {
  target.dispatchEvent(
    new CustomEvent(streamDeckButtonEventName, { detail: payload }),
  );
  target.postMessage(payload, "*");
}

export function createStreamDeckDevTools(target: MessageTarget): StreamDeckDevToolsApi {
  const withSource = (payload: Record<string, unknown>) => ({
    source: "kesher-streamdeck",
    ...payload,
  });

  return {
    buttonDown: (page: number, buttonIndex: number) => {
      emitToBridge(
        target,
        withSource({
          type: "button",
          page,
          buttonIndex,
          state: "down",
        }),
      );
    },
    buttonUp: (page: number, buttonIndex: number) => {
      emitToBridge(
        target,
        withSource({
          type: "button",
          page,
          buttonIndex,
          state: "up",
        }),
      );
    },
    buttonTap: (page: number, buttonIndex: number) => {
      emitToBridge(
        target,
        withSource({
          type: "button",
          page,
          buttonIndex,
          state: "down",
        }),
      );
      emitToBridge(
        target,
        withSource({
          type: "button",
          page,
          buttonIndex,
          state: "up",
        }),
      );
    },
    setConnection: (connected: boolean, message?: string) => {
      emitToBridge(
        target,
        withSource({
          type: "connection",
          status: connected ? "connected" : "disconnected",
          message,
        }),
      );
    },
    sendRaw: (payload: unknown) => {
      emitToBridge(target, payload);
    },
  };
}

declare global {
  interface Window {
    __kesherStreamDeckDev?: StreamDeckDevToolsApi;
  }
}
