import { describe, expect, it } from "vitest";
import {
  splitStreamDeckLabelParts,
  withResolvedStreamDeckButtonLabel,
} from "./streamDeckLabels";

const lookup = {
  rooms: [{ id: "room-1", name: "Party Line 1" }],
  roles: [{ id: "camera", name: "Camera" }],
  users: [{ id: "u-tim", username: "Tim", roleId: "camera" }],
  broadcastGroups: [],
};

describe("stream deck labels", () => {
  it("splits a label into name and second line", () => {
    expect(splitStreamDeckLabelParts(" Party \n FOH ")).toEqual({
      name: "Party",
      subtitle: "FOH",
    });
    expect(splitStreamDeckLabelParts("\nFOH")).toEqual({
      name: "",
      subtitle: "FOH",
    });
    expect(splitStreamDeckLabelParts(undefined)).toEqual({
      name: "",
      subtitle: "",
    });
  });

  it("keeps an own name as it is", () => {
    const button = {
      index: 0,
      label: "Cue\nStage",
      action: { type: "ptt_room" as const, roomId: "room-1" },
    };
    expect(withResolvedStreamDeckButtonLabel(button, lookup).label).toBe(
      "Cue\nStage",
    );
  });

  it("fills the automatic name and keeps an own second line", () => {
    const button = {
      index: 0,
      label: "\nStage left",
      action: { type: "ptt_room" as const, roomId: "room-1" },
    };
    expect(withResolvedStreamDeckButtonLabel(button, lookup).label).toBe(
      "Party Line 1\nStage left",
    );
  });

  it("replaces the automatic second line with an own one", () => {
    const auto = withResolvedStreamDeckButtonLabel(
      { index: 0, action: { type: "direct_user" as const, userId: "u-tim" } },
      lookup,
    );
    expect(auto.label).toBe("Tim\nCamera");
    const own = withResolvedStreamDeckButtonLabel(
      {
        index: 0,
        label: "\nOn stage",
        action: { type: "direct_user" as const, userId: "u-tim" },
      },
      lookup,
    );
    expect(own.label).toBe("Tim\nOn stage");
  });
});
