/**
 * Stream Deck keys that are down: the page each was pressed on and what ends
 * its hold action. A release always uses these, so it stops what its press
 * started even after a page change or a new incoming call (#77, #51), and a
 * disconnect can end everything still held.
 */
export type StreamDeckHoldTracker = {
  /** Records a press; returns the page it belongs to. */
  press: (buttonIndex: number, page: number) => number;
  /** What the release of a pressed key has to stop. */
  setRelease: (buttonIndex: number, release: () => void) => void;
  /**
   * Handles a key release. released: a hold action was stopped. page: the
   * page of the press, when known.
   */
  release: (buttonIndex: number) => { released: boolean; page?: number };
  /** Ends every hold action still running (disconnect, logout). */
  releaseAll: () => void;
};

export function createStreamDeckHoldTracker(): StreamDeckHoldTracker {
  const held = new Map<number, { page: number; release?: () => void }>();
  return {
    press(buttonIndex, page) {
      held.set(buttonIndex, { page });
      return page;
    },
    setRelease(buttonIndex, release) {
      const entry = held.get(buttonIndex);
      if (entry) entry.release = release;
    },
    release(buttonIndex) {
      const entry = held.get(buttonIndex);
      held.delete(buttonIndex);
      if (!entry) return { released: false };
      entry.release?.();
      return { released: !!entry.release, page: entry.page };
    },
    releaseAll() {
      const entries = [...held.values()];
      held.clear();
      for (const entry of entries) {
        try {
          entry.release?.();
        } catch {
          // Keep releasing the others.
        }
      }
    },
  };
}
