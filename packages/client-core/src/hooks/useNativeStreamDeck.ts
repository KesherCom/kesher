/**
 * useNativeStreamDeck — the desktop app drives the Stream Deck plugged into
 * its PC (decision 0008), without Companion. See lib/nativeStreamDeck.ts.
 *
 * While logged in and a deck is connected: attach it to this place, open the
 * Companion endpoints for it with the login token, send key presses and draw
 * the server's key images. Outside the desktop app this does nothing.
 */
import { useEffect, useRef, useState } from "react";
import { attachStreamDeck, buildWebSocketUrl } from "../api";
import { isTauri, tauriInvoke, tauriListen } from "../lib/tauri";
import {
  DeckFrame,
  deckJpeg,
  parseDeckImageMessage,
  parseDeckPage,
  pressButtonMessage,
  type DeckKeyImage,
  type NativeDeckStatus,
} from "../lib/nativeStreamDeck";

export type NativeStreamDeckState = {
  /** null outside the desktop app. */
  status: NativeDeckStatus | null;
  /** The deck is bound to this place and talks to the server. */
  linked: boolean;
  error: string;
};

const reconnectDelayMs = 2000;

export function useNativeStreamDeck(token: string): NativeStreamDeckState {
  const desktop = isTauri();
  const [status, setStatus] = useState<NativeDeckStatus | null>(null);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState("");
  const frameRef = useRef(new DeckFrame(15));

  // Deck status from Rust.
  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void tauriInvoke<NativeDeckStatus>("stream_deck_status")
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    void tauriListen<NativeDeckStatus>("stream_deck_status", setStatus)
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((err: unknown) => setError(`Deck events unavailable: ${String(err)}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [desktop]);

  const serial = status?.connected ? status.serial : "";
  const imageSize = status?.imageSize ?? 72;
  const imageRotated = status?.imageRotated ?? true;
  const keys = status?.keys ?? 15;

  // Connected deck + login: attach, then talk to the server for it.
  useEffect(() => {
    if (!desktop || !serial || !token) {
      setLinked(false);
      return;
    }
    const frame = frameRef.current;
    frame.setKeys(keys);
    frame.clear();
    let closed = false;
    let commandWs: WebSocket | null = null;
    let imageWs: WebSocket | null = null;
    let retryTimer: number | null = null;
    let unlistenKeys: (() => void) | null = null;
    // Images go out one after another, newest per key wins.
    const pending = new Map<number, string | null>();
    let drawing = false;

    const draw = async (images: DeckKeyImage[]) => {
      for (const { index, image } of images) pending.set(index, image);
      if (drawing) return;
      drawing = true;
      try {
        while (pending.size > 0 && !closed) {
          const [index, image] = pending.entries().next().value as [number, string | null];
          pending.delete(index);
          const jpeg = await deckJpeg(image, imageSize, imageRotated);
          await tauriInvoke("stream_deck_set_image", {
            index,
            jpeg: Array.from(jpeg),
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        drawing = false;
      }
    };

    const connect = async () => {
      if (closed) return;
      try {
        await attachStreamDeck(token, serial);
      } catch (err) {
        setError(err instanceof Error ? err.message : "attach failed");
        retryTimer = window.setTimeout(connect, reconnectDelayMs);
        return;
      }
      if (closed) return;
      setError("");
      const query = { deck: serial, token };
      commandWs = new WebSocket(buildWebSocketUrl("/api/companion/ws", query));
      imageWs = new WebSocket(buildWebSocketUrl("/api/image-stream", query));
      commandWs.onopen = () => setLinked(true);
      commandWs.onmessage = (ev) => {
        let data: unknown;
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const page = parseDeckPage(data);
        if (page !== null) void draw(frame.show(page));
      };
      imageWs.onmessage = (ev) => {
        let data: unknown;
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const msg = parseDeckImageMessage(data);
        if (msg) void draw(frame.receive(msg.page, msg.index, msg.image));
      };
      const lost = () => {
        if (closed) return;
        setLinked(false);
        commandWs?.close();
        imageWs?.close();
        commandWs = null;
        imageWs = null;
        if (retryTimer === null) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void connect();
          }, reconnectDelayMs);
        }
      };
      commandWs.onclose = lost;
      imageWs.onclose = lost;
    };

    void tauriListen<{ index: number; pressed: boolean }>("stream_deck_key", (key) => {
      if (commandWs?.readyState !== WebSocket.OPEN) return;
      commandWs.send(
        pressButtonMessage(serial, key.index, key.pressed, crypto.randomUUID()),
      );
    })
      .then((u) => {
        if (closed) u();
        else unlistenKeys = u;
      })
      .catch((err: unknown) => setError(`Deck keys unavailable: ${String(err)}`));
    void connect();

    return () => {
      closed = true;
      setLinked(false);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unlistenKeys?.();
      commandWs?.close();
      imageWs?.close();
      // Logged out: the keys go dark instead of showing a stale layout.
      void Promise.all(
        Array.from({ length: keys }, async (_, index) =>
          tauriInvoke("stream_deck_set_image", {
            index,
            jpeg: Array.from(await deckJpeg(null, imageSize, imageRotated)),
          }),
        ),
      ).catch(() => undefined);
    };
  }, [desktop, serial, token, keys, imageSize, imageRotated]);

  return { status: desktop ? status : null, linked, error };
}
