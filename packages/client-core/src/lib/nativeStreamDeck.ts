/**
 * Stream Deck plugged into the desktop app's PC (decision 0008).
 *
 * The Rust side (crates/kesher-deck, desktop/src-tauri/src/stream_deck.rs)
 * reports the deck and its keys; this side talks to the server exactly like
 * Companion does with `?deck=<serial>` (press_button on /api/companion/ws,
 * key images from /api/image-stream) and hands the images back to Rust.
 */

/** `stream_deck_status` from the Rust side. */
export type NativeDeckStatus = {
  connected: boolean;
  serial: string;
  model: string;
  keys: number;
  columns: number;
  imageSize: number;
  imageRotated: boolean;
  unsupportedModel: string | null;
  error: string | null;
};

/** `update_button_image` from /api/image-stream. */
export type DeckImageMessage = {
  type: string;
  bank?: number;
  buttonIndex?: number;
  imageBuffer?: string;
};

/** One key to draw: a base64 PNG, or null for an empty (black) key. */
export type DeckKeyImage = { index: number; image: string | null };

/**
 * Keeps the images per page and decides what to draw. Which page the deck
 * shows comes from the server (`currentPageNumber` in companion_state, see
 * show()); images of other pages are only kept for later. Until the first
 * state arrives, the first image's page is shown.
 */
export class DeckFrame {
  private readonly pages = new Map<number, Map<number, string>>();
  private shown: number | null = null;

  constructor(private keys: number) {}

  setKeys(keys: number): void {
    this.keys = keys;
  }

  receive(page: number, index: number, image: string): DeckKeyImage[] {
    let images = this.pages.get(page);
    if (!images) {
      images = new Map();
      this.pages.set(page, images);
    }
    images.set(index, image);
    if (this.shown === null) {
      this.shown = page;
      return this.all();
    }
    if (page !== this.shown) return [];
    return index < this.keys ? [{ index, image }] : [];
  }

  /** The server says which page the deck shows now. */
  show(page: number): DeckKeyImage[] {
    if (this.shown === page) return [];
    this.shown = page;
    return this.all();
  }

  /** Every key of the shown page (after the deck was plugged in again). */
  all(): DeckKeyImage[] {
    const images = this.shown === null ? undefined : this.pages.get(this.shown);
    return Array.from({ length: this.keys }, (_, index) => ({
      index,
      image: images?.get(index) ?? null,
    }));
  }

  clear(): void {
    this.pages.clear();
    this.shown = null;
  }
}

/** The deck's current page from a companion_state message, else null. */
export function parseDeckPage(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as { type?: string; data?: { currentPageNumber?: number } };
  if (msg.type !== "companion_state") return null;
  // omitempty on the server: no field means page 0.
  const page = Number(msg.data?.currentPageNumber ?? 0);
  return Number.isInteger(page) ? page : null;
}

export function parseDeckImageMessage(
  raw: unknown,
): { page: number; index: number; image: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as DeckImageMessage;
  if (msg.type !== "update_button_image") return null;
  const index = Number(msg.buttonIndex);
  const page = Number(msg.bank ?? 0);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(page)) {
    return null;
  }
  if (typeof msg.imageBuffer !== "string" || !msg.imageBuffer) return null;
  return { page, index, image: msg.imageBuffer };
}

/** The press_button command Companion sends, for this deck. */
export function pressButtonMessage(
  serial: string,
  index: number,
  pressed: boolean,
  commandId: string,
): string {
  return JSON.stringify({
    type: "command",
    data: {
      command: "press_button",
      buttonIndex: index,
      state: pressed ? "down" : "up",
      surfaceId: serial,
      commandId,
    },
  });
}

/**
 * A key image as the deck wants it: JPEG at the model's size, rotated by
 * 180 degrees where the model needs that. `pngBase64` null gives black.
 */
export async function deckJpeg(
  pngBase64: string | null,
  size: number,
  rotated: boolean,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  if (pngBase64) {
    const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    if (rotated) {
      ctx.translate(size, size);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}
