import { describe, expect, it } from "vitest";
import {
  DeckFrame,
  parseDeckImageMessage,
  pressButtonMessage,
} from "./nativeStreamDeck";

describe("DeckFrame", () => {
  it("draws single keys on the shown page and the whole deck on a page change", () => {
    const frame = new DeckFrame(3);
    expect(frame.receive(1, 0, "a")).toEqual([
      { index: 0, image: "a" },
      { index: 1, image: null },
      { index: 2, image: null },
    ]);
    expect(frame.receive(1, 2, "c")).toEqual([{ index: 2, image: "c" }]);
    // Page 2 arrives: every key redrawn, the old page's keys go black.
    expect(frame.receive(2, 1, "x")).toEqual([
      { index: 0, image: null },
      { index: 1, image: "x" },
      { index: 2, image: null },
    ]);
    // Back on page 1: its cached images come back.
    expect(frame.receive(1, 1, "b")).toEqual([
      { index: 0, image: "a" },
      { index: 1, image: "b" },
      { index: 2, image: "c" },
    ]);
    expect(frame.receive(1, 7, "out of range")).toEqual([]);
  });

  it("repaints everything after the deck comes back", () => {
    const frame = new DeckFrame(2);
    frame.receive(1, 1, "b");
    expect(frame.all()).toEqual([
      { index: 0, image: null },
      { index: 1, image: "b" },
    ]);
    frame.clear();
    expect(frame.all()).toEqual([
      { index: 0, image: null },
      { index: 1, image: null },
    ]);
  });
});

describe("messages", () => {
  it("reads image updates and ignores the rest", () => {
    expect(
      parseDeckImageMessage({
        type: "update_button_image",
        bank: 2,
        buttonIndex: 4,
        imageBuffer: "iVBOR",
      }),
    ).toEqual({ page: 2, index: 4, image: "iVBOR" });
    expect(parseDeckImageMessage({ type: "pong" })).toBeNull();
    expect(
      parseDeckImageMessage({ type: "update_button_image", buttonIndex: 1 }),
    ).toBeNull();
  });

  it("sends presses like Companion", () => {
    expect(JSON.parse(pressButtonMessage("CL1", 3, true, "id-1"))).toEqual({
      type: "command",
      data: {
        command: "press_button",
        buttonIndex: 3,
        state: "down",
        surfaceId: "CL1",
        commandId: "id-1",
      },
    });
  });
});
