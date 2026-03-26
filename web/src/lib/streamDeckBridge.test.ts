import { describe, expect, it } from "vitest";
import {
  gainWithDbDelta,
  parseStreamDeckBridgeEvent,
  resolveStreamDeckButtonAction,
} from "./streamDeckBridge";

describe("streamDeckBridge", () => {
  it("parses button events from bridge payload", () => {
    const parsed = parseStreamDeckBridgeEvent({
      source: "kesher-streamdeck",
      type: "button",
      buttonIndex: 2,
      state: "down",
      page: 0,
    });
    expect(parsed).toEqual({
      kind: "button",
      buttonIndex: 2,
      state: "down",
      page: 0,
    });
  });

  it("parses connection events", () => {
    const parsed = parseStreamDeckBridgeEvent({
      source: "kesher-streamdeck",
      type: "connection",
      status: "connected",
    });
    expect(parsed).toEqual({
      kind: "connection",
      connected: true,
      message: undefined,
    });
  });

  it("resolves reply-to-caller action from settings", () => {
    const action = resolveStreamDeckButtonAction(
      {
        version: 1,
        gridColumns: 5,
        gridRows: 3,
        selectedPage: 0,
        pages: [
          {
            page: 0,
            buttons: [
              { index: 0, action: { type: "reply_to_caller" } },
              ...Array.from({ length: 14 }, (_, idx) => ({ index: idx + 1 })),
            ],
          },
        ],
      },
      0,
      0,
    );
    expect(action?.type).toBe("reply_to_caller");
  });

  it("resolves direct-role action from settings", () => {
    const action = resolveStreamDeckButtonAction(
      {
        version: 1,
        gridColumns: 5,
        gridRows: 3,
        selectedPage: 0,
        pages: [
          {
            page: 0,
            buttons: [
              { index: 0 },
              { index: 1, action: { type: "direct_role", roleId: "audio" } },
              ...Array.from({ length: 13 }, (_, idx) => ({ index: idx + 2 })),
            ],
          },
        ],
      },
      0,
      1,
    );
    expect(action).toEqual({ type: "direct_role", roleId: "audio" });
  });

  it("resolves combined select-listen action from settings", () => {
    const action = resolveStreamDeckButtonAction(
      {
        version: 1,
        gridColumns: 5,
        gridRows: 3,
        selectedPage: 0,
        pages: [
          {
            page: 0,
            buttons: [
              { index: 0, action: { type: "select_listen_room", roomId: "r1" } },
              ...Array.from({ length: 14 }, (_, idx) => ({ index: idx + 1 })),
            ],
          },
        ],
      },
      0,
      0,
    );
    expect(action).toEqual({ type: "select_listen_room", roomId: "r1" });
  });

  it("applies db deltas with clamp", () => {
    const boosted = gainWithDbDelta(1, 6);
    expect(boosted).toBeGreaterThan(1);
    const lowered = gainWithDbDelta(0.001, -30);
    expect(lowered).toBeGreaterThanOrEqual(0);
    expect(lowered).toBeLessThanOrEqual(2);
  });

  it("resolves page-up action from settings", () => {
    const action = resolveStreamDeckButtonAction(
      {
        version: 1,
        gridColumns: 5,
        gridRows: 3,
        selectedPage: 0,
        pages: [
          {
            page: 0,
            buttons: [
              { index: 0, action: { type: "page_up" } },
              ...Array.from({ length: 14 }, (_, idx) => ({ index: idx + 1 })),
            ],
          },
        ],
      },
      0,
      0,
    );
    expect(action).toEqual({ type: "page_up" });
  });
});
