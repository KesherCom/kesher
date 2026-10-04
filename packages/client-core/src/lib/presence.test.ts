import { describe, expect, it } from "vitest";
import { normalizePresenceList, samePresenceList } from "./presence";

const base = {
  userId: "u1",
  username: "foh",
  roleId: "audio",
  listenRooms: ["foh"],
  talkRooms: ["foh"],
  voiceMode: "ptt",
  micEnabled: false,
  broadcastActive: false,
};

describe("presence audio source ids", () => {
  it("keeps numeric audioSourceId and drops invalid values", () => {
    const [withId, withoutId] = normalizePresenceList([
      { ...base, audioSourceId: 123456 },
      { ...base, audioSourceId: "123" },
    ]);
    expect(withId.audioSourceId).toBe(123456);
    expect(withoutId.audioSourceId).toBeUndefined();
  });

  it("treats a changed audioSourceId (reconnect) as a presence change", () => {
    const a = normalizePresenceList([{ ...base, audioSourceId: 1 }]);
    const b = normalizePresenceList([{ ...base, audioSourceId: 2 }]);
    expect(samePresenceList(a, b)).toBe(false);
    expect(samePresenceList(a, normalizePresenceList([{ ...base, audioSourceId: 1 }]))).toBe(true);
  });
});
