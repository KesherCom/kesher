import { describe, expect, it, vi } from "vitest";
import { createStreamDeckHoldTracker } from "./streamDeckHolds";

describe("streamDeckHolds", () => {
  it("releases what the press started, on the press's page", () => {
    const holds = createStreamDeckHoldTracker();
    const stopFirstCaller = vi.fn();
    holds.press(3, 0);
    holds.setRelease(3, stopFirstCaller);
    // The page changes (or a new caller arrives) while the key is held.
    expect(holds.release(3)).toEqual({ released: true, page: 0 });
    expect(stopFirstCaller).toHaveBeenCalledTimes(1);
    // A second release does nothing.
    expect(holds.release(3)).toEqual({ released: false });
    expect(stopFirstCaller).toHaveBeenCalledTimes(1);
  });

  it("keeps the page for keys without a hold action", () => {
    const holds = createStreamDeckHoldTracker();
    holds.press(1, 2);
    expect(holds.release(1)).toEqual({ released: false, page: 2 });
  });

  it("ends everything still held on disconnect", () => {
    const holds = createStreamDeckHoldTracker();
    const stopTalk = vi.fn();
    const stopBroadcast = vi.fn(() => {
      throw new Error("socket closed");
    });
    const stopDirect = vi.fn();
    holds.press(0, 0);
    holds.setRelease(0, stopTalk);
    holds.press(1, 0);
    holds.setRelease(1, stopBroadcast);
    holds.press(2, 1);
    holds.setRelease(2, stopDirect);
    holds.releaseAll();
    expect(stopTalk).toHaveBeenCalledTimes(1);
    expect(stopBroadcast).toHaveBeenCalledTimes(1);
    expect(stopDirect).toHaveBeenCalledTimes(1);
    expect(holds.release(0)).toEqual({ released: false });
  });
});
