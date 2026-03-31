import { streamDeckButtonEventName } from "./streamDeckBridge";

export type StreamDeckDevToolsApi = {
  buttonDown: (page: number, buttonIndex: number) => void;
  buttonUp: (page: number, buttonIndex: number) => void;
  buttonTap: (page: number, buttonIndex: number) => void;
  setConnection: (connected: boolean, message?: string) => void;
  sendRaw: (payload: unknown) => void;
  listHidDevices: () => Promise<Array<Record<string, unknown>>>;
  requestAndListHidDevices: () => Promise<Array<Record<string, unknown>>>;
  requestBroadAndListHidDevices: () => Promise<Array<Record<string, unknown>>>;
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

  const listDevices = async (requestAccess: boolean) => {
    const nav = navigator as Navigator & {
      hid?: {
        getDevices: () => Promise<Array<Record<string, unknown>>>;
        requestDevice: (options: {
          filters: Array<{
            vendorId?: number;
            productId?: number;
            usagePage?: number;
            usage?: number;
          }>;
        }) => Promise<Array<Record<string, unknown>>>;
      };
    };

    if (!nav.hid) {
      console.warn("[kesher] WebHID is not available in this browser.");
      return [];
    }

    if (requestAccess) {
      await nav.hid.requestDevice({
        filters: [{ vendorId: 0x0fd9 }, { vendorId: 0x1b1c }],
      });
    }

    const devices = await nav.hid.getDevices();
    const rows = devices.map((device, index) => {
      const vendorId = Number(device.vendorId ?? 0);
      const productName = String(device.productName ?? "");
      const row = {
        index,
        productName,
        vendorId,
        vendorHex: `0x${vendorId.toString(16).padStart(4, "0")}`,
        productId: Number(device.productId ?? 0),
        opened: Boolean(device.opened),
        streamDeckLike:
          vendorId === 0x0fd9 ||
          vendorId === 0x1b1c ||
          productName.toLowerCase().includes("stream deck"),
      };
      return row;
    });

    if (rows.length === 0) {
      console.warn("[kesher] No HID devices currently granted for this origin.");
    } else {
      console.table(rows);
      const streamDeckRows = rows.filter((row) => row.streamDeckLike);
      if (streamDeckRows.length === 0) {
        console.warn("[kesher] HID devices found, but none look like a Stream Deck.");
      } else {
        console.info(`[kesher] Stream Deck-like devices found: ${streamDeckRows.length}`);
      }
    }

    return rows;
  };

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
    listHidDevices: () => listDevices(false),
    requestAndListHidDevices: () => listDevices(true),
    requestBroadAndListHidDevices: async () => {
      const nav = navigator as Navigator & {
        hid?: {
          requestDevice: (options: {
            filters: Array<{
              vendorId?: number;
              productId?: number;
              usagePage?: number;
              usage?: number;
            }>;
          }) => Promise<Array<Record<string, unknown>>>;
        };
      };

      if (!nav.hid) {
        console.warn("[kesher] WebHID is not available in this browser.");
        return [];
      }

      await nav.hid.requestDevice({
        filters: [
          { vendorId: 0x0fd9 },
          { vendorId: 0x1b1c },
          { usagePage: 0xff00 },
        ],
      });
      return listDevices(false);
    },
  };
}

declare global {
  interface Window {
    __kesherStreamDeckDev?: StreamDeckDevToolsApi;
  }
}
