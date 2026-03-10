import { describe, expect, it } from "vitest";
import {
  matrixAnchorRoomId,
  resolveChatTargetRoomId,
  roleAllowed,
  toggleRoomSelectionState,
} from "./intercom";

describe("intercom utility helpers", () => {
  it("prefers first talk room for matrix anchor", () => {
    expect(matrixAnchorRoomId(["listen-1"], ["talk-1", "talk-2"])).toBe(
      "talk-1",
    );
  });

  it("falls back to first listen room for matrix anchor", () => {
    expect(matrixAnchorRoomId(["listen-1", "listen-2"], [])).toBe("listen-1");
  });

  it("falls back to the role default room for chat when no anchor room is selected", () => {
    expect(
      resolveChatTargetRoomId(
        [],
        [],
        [
          {
            id: "foh",
            name: "FOH",
            senderRoleIds: ["audio"],
            receiverRoleIds: ["audio"],
            forcedListenRoleIds: [],
          },
        ],
        { id: "audio", name: "Audio", defaultRoomId: "foh" },
        "audio",
      ),
    ).toBe("foh");
  });

  it("falls back to the first allowed room for chat when no anchor or usable default exists", () => {
    expect(
      resolveChatTargetRoomId(
        [],
        [],
        [
          {
            id: "stage",
            name: "Stage",
            senderRoleIds: [],
            receiverRoleIds: ["audio"],
            forcedListenRoleIds: [],
          },
          {
            id: "foh",
            name: "FOH",
            senderRoleIds: ["audio"],
            receiverRoleIds: ["audio"],
            forcedListenRoleIds: [],
          },
        ],
        { id: "audio", name: "Audio", defaultRoomId: "missing" },
        "audio",
      ),
    ).toBe("foh");
  });

  it("denies access when no role restriction exists", () => {
    expect(roleAllowed(undefined, "op")).toBe(false);
    expect(roleAllowed([], "op")).toBe(false);
  });

  it("enforces role restriction when role IDs are provided", () => {
    expect(roleAllowed(["admin", "operator"], "operator")).toBe(true);
    expect(roleAllowed(["admin", "operator"], "guest")).toBe(false);
  });

  it("removes selected room even when it is the last one", () => {
    expect(toggleRoomSelectionState(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleRoomSelectionState(["only"], "only")).toEqual([]);
  });

  it("adds unselected room to existing selection", () => {
    expect(toggleRoomSelectionState(["a"], "b")).toEqual(["a", "b"]);
  });
});
