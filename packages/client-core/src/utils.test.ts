import { describe, expect, it } from "vitest";
import {
  sameStringArray,
  sameStringSet,
  sourceUserIDFromRemoteSDPMid,
  sourceUserIDFromTrackID,
} from "./utils";

describe("app utils", () => {
  it("extracts source user ID from track IDs", () => {
    expect(sourceUserIDFromTrackID("audio-user-user-123")).toBe("user-123");
    expect(sourceUserIDFromTrackID("video-user-user-123")).toBe("");
  });

  it("extracts source user ID from remote SDP mid", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=msid:stream audio-user-u1",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:1",
      "a=msid:stream audio-user-u2",
    ].join("\r\n");
    const pc = { remoteDescription: { sdp } } as RTCPeerConnection;
    expect(sourceUserIDFromRemoteSDPMid(pc, "1")).toBe("u2");
    expect(sourceUserIDFromRemoteSDPMid(pc, "does-not-exist")).toBe("");
  });

  it("returns empty source user ID for missing peer connection context", () => {
    expect(sourceUserIDFromRemoteSDPMid(null, "1")).toBe("");
    expect(sourceUserIDFromRemoteSDPMid({} as RTCPeerConnection, "1")).toBe("");
    expect(
      sourceUserIDFromRemoteSDPMid(
        { remoteDescription: { sdp: "m=audio" } } as RTCPeerConnection,
        null,
      ),
    ).toBe("");
  });

  it("compares string arrays by sequence", () => {
    expect(sameStringArray(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStringArray(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("compares string sets independent of ordering", () => {
    expect(sameStringSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameStringSet(["a"], ["a", "b"])).toBe(false);
  });
});
