export type StreamDeckWebHidButtonState = "down" | "up";

export type HidDeviceLike = EventTarget & {
  vendorId?: number;
  productId?: number;
  productName?: string;
  opened?: boolean;
  open: () => Promise<void>;
  close: () => Promise<void>;
};

export type HidInputReportEventLike = Event & {
  reportId: number;
  data: DataView;
};

export type HidConnectionEventLike = Event & {
  device: HidDeviceLike;
};

export type HidLike = EventTarget & {
  getDevices: () => Promise<HidDeviceLike[]>;
  requestDevice: (options: {
    filters: Array<{
      vendorId?: number;
      productId?: number;
      usagePage?: number;
      usage?: number;
    }>;
  }) => Promise<HidDeviceLike[]>;
};

// Some Stream Deck generations enumerate under Elgato VID (0x0fd9),
// newer firmware/hardware can expose Corsair VID (0x1b1c).
export const streamDeckVendorFilters = [
  { vendorId: 0x0fd9 },
  { vendorId: 0x1b1c },
];

export function isStreamDeckDevice(device: HidDeviceLike): boolean {
  if (device.vendorId === 0x0fd9 || device.vendorId === 0x1b1c) {
    return true;
  }
  const productName = device.productName?.toLowerCase() ?? "";
  return productName.includes("stream deck");
}

/**
 * Returns the byte offset within a Web HID `inputreport` event's `data` DataView
 * at which button states begin. The offset varies by Stream Deck model because
 * different generations use different amounts of header/padding bytes.
 *
 * Web HID already strips the report-ID byte, so these offsets are already
 * adjusted (node-hid values are 1 higher since they include the report ID).
 */
export function getStreamDeckByteOffset(productName: string): number {
  const n = productName.toLowerCase();
  // Mini (6-button) uses report ID 0x01, 1 padding byte → offset 0 in event.data
  if (n.includes("mini")) return 0;
  // MK2, XL, +, Neo: report ID 0x00, 4 padding bytes → offset 4 in event.data
  return 4;
}

export function isWebHidSupported(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

export function getNavigatorHid(): HidLike | null {
  if (!isWebHidSupported()) return null;
  const maybeNavigator = navigator as Navigator & { hid?: HidLike };
  return maybeNavigator.hid ?? null;
}

// Stream Deck models use vendor-specific HID reports. The byte offset varies by
// model and must be supplied via getStreamDeckByteOffset() rather than guessed,
// because header padding bytes are all-zero and therefore indistinguishable from
// inactive button bytes by a scoring heuristic.
export function decodeStreamDeckButtonStates(
  data: DataView,
  buttonCount: number,
  byteOffset: number,
): boolean[] {
  if (buttonCount <= 0 || data.byteLength <= 0) {
    return [];
  }

  return Array.from({ length: buttonCount }, (_, index) => {
    const raw = data.byteLength > byteOffset + index ? data.getUint8(byteOffset + index) : 0;
    return raw !== 0;
  });
}

export function diffStreamDeckButtonStates(
  previous: boolean[],
  next: boolean[],
): Array<{ buttonIndex: number; state: StreamDeckWebHidButtonState }> {
  const max = Math.max(previous.length, next.length);
  const events: Array<{ buttonIndex: number; state: StreamDeckWebHidButtonState }> = [];
  for (let buttonIndex = 0; buttonIndex < max; buttonIndex += 1) {
    const before = previous[buttonIndex] ?? false;
    const after = next[buttonIndex] ?? false;
    if (before === after) continue;
    events.push({ buttonIndex, state: after ? "down" : "up" });
  }
  return events;
}
