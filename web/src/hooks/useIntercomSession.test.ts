import { describe, expect, it } from "vitest";
import {
  trySetReceiverPlayoutDelayHint,
  tuneOpusSdpForSpeech,
  upsertFmtpParams,
} from "./useIntercomSession";

describe("useIntercomSession low-latency helpers", () => {
  it("upserts opus fmtp params for low-latency speech", () => {
    expect(
      upsertFmtpParams(
        "useinbandfec=1;usedtx=0;maxaveragebitrate=64000;stereo=1",
      ),
    ).toBe(
      [
        "useinbandfec=0",
        "usedtx=1",
        "maxaveragebitrate=24000",
        "stereo=0",
        "sprop-stereo=0",
        "ptime=5",
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
      "a=fmtp:111 stereo=0;sprop-stereo=0;useinbandfec=0;usedtx=1;ptime=5;minptime=2.5;maxaveragebitrate=24000",
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
});