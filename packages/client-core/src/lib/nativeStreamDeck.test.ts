import { describe, expect, it } from "vitest";
import {
  DeckFrame,
  parseDeckImageMessage,
  parseDeckPage,
  pressButtonMessage,
} from "./nativeStreamDeck";

describe("DeckFrame", () => {
  it("shows the page the server names and keeps other pages for later", () => {
    const frame = new DeckFrame(3);
    // Before any state: the first image's page is shown.
    expect(frame.receive(1, 0, "a")).toEqual([
      { index: 0, image: "a" },
      { index: 1, image: null },
      { index: 2, image: null },
    ]);
    expect(frame.receive(1, 2, "c")).toEqual([{ index: 2, image: "c" }]);
    // The server switches to page 2: every key redrawn, old keys go black.
    expect(frame.show(2)).toEqual([
      { index: 0, image: null },
      { index: 1, image: null },
      { index: 2, image: null },
    ]);
    expect(frame.receive(2, 1, "x")).toEqual([{ index: 1, image: "x" }]);
    // A late image of the old page must not switch the deck back.
    expect(frame.receive(1, 1, "b")).toEqual([]);
    // Back on page 1: its cached images come back.
    expect(frame.show(1)).toEqual([
      { index: 0, image: "a" },
      { index: 1, image: "b" },
      { index: 2, image: "c" },
    ]);
    expect(frame.show(1)).toEqual([]);
    expect(frame.receive(1, 7, "out of range")).toEqual([]);
  });

  it("reads the page from companion_state (no field means page 0)", () => {
    expect(parseDeckPage({ type: "companion_state", data: { currentPageNumber: 2 } })).toBe(2);
    expect(parseDeckPage({ type: "companion_state", data: {} })).toBe(0);
    expect(parseDeckPage({ type: "companion_command_result", data: {} })).toBeNull();
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
