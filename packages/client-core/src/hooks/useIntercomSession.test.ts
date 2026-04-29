import { describe, expect, it } from "vitest";
import {
  resolveUnknownSourceGain,
  trySetReceiverPlayoutDelayHint,
  tuneOpusSdpForSpeech,
  upsertFmtpParams,
  getAdaptivePlayoutDelayHint,
} from "./useIntercomSession";

describe("useIntercomSession low-latency helpers", () => {
  it("upserts opus fmtp params for low-latency speech with FEC enabled", () => {
    expect(
      upsertFmtpParams(
        "useinbandfec=0;usedtx=0;maxaveragebitrate=64000;stereo=1",
      ),
    ).toBe(
      [
        "useinbandfec=1",
        "usedtx=0",
        "maxaveragebitrate=24000",
        "stereo=0",
        "sprop-stereo=0",
        "cbr=1",
        "ptime=2.5",
        "minptime=2.5",
      ].join(";"),
    );
  });

  it("adds or updates opus fmtp lines in SDP answers", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "",
    ].join("\r\n");

    expect(tuneOpusSdpForSpeech(sdp)).toContain(
      "a=fmtp:111 stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;cbr=1;ptime=2.5;minptime=2.5;maxaveragebitrate=24000",
    );
  });

  it("sets playoutDelayHint to zero when the receiver supports it", () => {
    const receiver = { playoutDelayHint: 0.25 };

    expect(trySetReceiverPlayoutDelayHint(receiver, 0)).toBe(true);
    expect(receiver.playoutDelayHint).toBe(0);
  });

  it("fails closed when playoutDelayHint is unsupported or throws", () => {
    expect(trySetReceiverPlayoutDelayHint({}, 0)).toBe(false);

    const receiver = {
      get playoutDelayHint() {
        return 0;
      },
      set playoutDelayHint(_value: number) {
        throw new Error("unsupported");
      },
    };

    expect(trySetReceiverPlayoutDelayHint(receiver, 0)).toBe(false);
  });

  it("returns aggressive 0ms delay for LAN with low jitter", () => {
    expect(getAdaptivePlayoutDelayHint(2, 3)).toBe(0);
  });

  it("returns 20ms delay for good network", () => {
    expect(getAdaptivePlayoutDelayHint(10, 8)).toBe(0.02);
  });

  it("returns 50ms delay for moderate RTT", () => {
    expect(getAdaptivePlayoutDelayHint(35, 12)).toBe(0.05);
  });

  it("returns 100ms delay for higher RTT", () => {
    expect(getAdaptivePlayoutDelayHint(80, 20)).toBe(0.1);
  });

  it("returns 150ms delay for poor network", () => {
    expect(getAdaptivePlayoutDelayHint(120, 30)).toBe(0.15);
  });
});

describe("resolveUnknownSourceGain", () => {
  it("applies attenuated direct gain for unknown source tracks", () => {
    const gain = resolveUnknownSourceGain({
      routes: [
        {
          senderUserID: "u1",
          scope: "direct",
          targetID: "self",
        },
      ],
      selfUserID: "self",
      listenRoomIDs: ["r1"],
      talkRoomIDs: ["r1"],
      roomGainById: {},
      directGainByUserId: { u1: 0.35 },
      presence: [],
      clampGain: (value) => Math.max(0, Math.min(2, value)),
    });

    expect(gain).toBeCloseTo(0.35, 5);
  });

  it("applies attenuated room gain for unknown source tracks", () => {
    const gain = resolveUnknownSourceGain({
      routes: [
        {
          senderUserID: "u1",
          scope: "room",
          targetID: "r1",
        },
      ],
      selfUserID: "self",
      listenRoomIDs: ["r1"],
      talkRoomIDs: ["r1"],
      roomGainById: { r1: 0.25 },
      directGainByUserId: {},
      presence: [],
      clampGain: (value) => Math.max(0, Math.min(2, value)),
    });

    expect(gain).toBeCloseTo(0.25, 5);
  });

  it("falls back to unity gain when no route context is available", () => {
    const gain = resolveUnknownSourceGain({
      routes: [],
      selfUserID: "self",
      listenRoomIDs: [],
      talkRoomIDs: [],
      roomGainById: {},
      directGainByUserId: {},
      presence: [],
      clampGain: (value) => Math.max(0, Math.min(2, value)),
    });

    expect(gain).toBe(1);
  });
});
