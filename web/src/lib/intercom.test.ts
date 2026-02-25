import { describe, expect, it } from "vitest";
import {
  matrixAnchorRoomId,
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

  it("allows everyone when no role restriction exists", () => {
    expect(roleAllowed(undefined, "op")).toBe(true);
    expect(roleAllowed([], "op")).toBe(true);
  });

  it("enforces role restriction when role IDs are provided", () => {
    expect(roleAllowed(["admin", "operator"], "operator")).toBe(true);
    expect(roleAllowed(["admin", "operator"], "guest")).toBe(false);
  });

  it("removes selected room only when more than one room exists", () => {
    expect(toggleRoomSelectionState(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleRoomSelectionState(["only"], "only")).toEqual(["only"]);
  });

  it("adds unselected room to existing selection", () => {
    expect(toggleRoomSelectionState(["a"], "b")).toEqual(["a", "b"]);
  });
});
