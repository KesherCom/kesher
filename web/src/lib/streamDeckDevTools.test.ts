import { describe, expect, it, vi } from "vitest";
import { createStreamDeckDevTools } from "./streamDeckDevTools";

describe("streamDeckDevTools", () => {
  it("emits down/up button events", () => {
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const api = createStreamDeckDevTools({ dispatchEvent, postMessage });

    api.buttonDown(0, 2);
    api.buttonUp(0, 2);

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("emits connection events", () => {
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const api = createStreamDeckDevTools({ dispatchEvent, postMessage });

    api.setConnection(true, "ok");

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
