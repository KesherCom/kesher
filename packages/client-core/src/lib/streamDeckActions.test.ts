import { describe, expect, it } from "vitest";
import {
  actionCategories,
  actionCategory,
  actionChoiceOf,
  buildAction,
} from "./streamDeckActions";

const defaults = {
  roomId: "foh",
  userId: "u1",
  roleId: "audio",
  broadcastGroupId: "all",
  firstPage: 0,
};
const choice = (categoryId: Parameters<typeof actionCategory>[0], id: string) => {
  const category = actionCategory(categoryId);
  const found = category.choices.find((c) => c.id === id);
  if (!found) throw new Error(`no choice ${id}`);
  return { category, choice: found };
};

describe("Stream Deck functions", () => {
  it("offers every action type exactly once (mic gain as two directions)", () => {
    const types = actionCategories.flatMap((c) => c.choices.map((x) => x.type));
    for (const type of [
      "none", "ptt_room", "listen_room", "call_room", "select_talk_room",
      "select_listen_room", "ptt_selected", "direct_user", "direct_role",
      "broadcast_ptt", "reply_to_caller", "incoming_call_indicator",
      "mute_toggle", "volume_delta", "page_up", "page_down", "page_home",
      "page_jump",
    ]) {
      expect(types).toContain(type);
    }
    expect(types.filter((t) => t === "volume_delta")).toHaveLength(2);
  });

  it("finds the choice of a stored action", () => {
    expect(actionChoiceOf(undefined).category.id).toBe("none");
    expect(actionChoiceOf({ type: "listen_room", roomId: "foh" }).choice.id).toBe("listen_room");
    expect(actionChoiceOf({ type: "volume_delta", volumeDelta: -2 }).choice.id).toBe("volume_down");
    expect(actionChoiceOf({ type: "volume_delta", volumeDelta: 1 }).choice.id).toBe("volume_up");
    expect(actionChoiceOf({ type: "broadcast_ptt" }).category.id).toBe("group");
  });

  it("keeps the party line when switching what the key does", () => {
    const { category, choice: listen } = choice("line", "listen_room");
    expect(buildAction(category, listen, { type: "ptt_room", roomId: "stage" }, defaults))
      .toEqual({ type: "listen_room", roomId: "stage" });
    expect(buildAction(category, listen, undefined, defaults))
      .toEqual({ type: "listen_room", roomId: "foh" });
    const { choice: chosen } = choice("line", "ptt_selected");
    expect(buildAction(category, chosen, { type: "ptt_room", roomId: "stage" }, defaults))
      .toEqual({ type: "ptt_selected" });
  });

  it("keeps the gain step and flips its direction", () => {
    const { category, choice: down } = choice("mic", "volume_down");
    expect(buildAction(category, down, { type: "volume_delta", volumeDelta: 2 }, defaults))
      .toEqual({ type: "volume_delta", volumeDelta: -2 });
    expect(buildAction(category, down, undefined, defaults))
      .toEqual({ type: "volume_delta", volumeDelta: -1 });
  });

  it("fills targets and pages", () => {
    const person = choice("person", "direct_user");
    expect(buildAction(person.category, person.choice, undefined, defaults))
      .toEqual({ type: "direct_user", userId: "u1" });
    const jump = choice("pages", "page_jump");
    expect(buildAction(jump.category, jump.choice, { type: "page_jump", targetPage: 3 }, defaults))
      .toEqual({ type: "page_jump", targetPage: 3 });
    const none = choice("none", "none");
    expect(buildAction(none.category, none.choice, { type: "ptt_room" }, defaults)).toBeUndefined();
  });
});
