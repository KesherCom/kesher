import { describe, expect, it, vi } from "vitest";
import {
  buildLowLatencyMicConstraintCandidates,
  requestLowLatencyMicStream,
} from "./useLocalMic";

describe("useLocalMic helpers", () => {
  it("builds low-latency microphone candidates with strict DSP disable first", () => {
    const candidates = buildLowLatencyMicConstraintCandidates("mic-1");

    expect(candidates[0]).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(candidates[1]).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        latency: 0,
        deviceId: "mic-1",
      },
      video: false,
    });
    expect(candidates[candidates.length - 1]).toEqual({
      audio: true,
      video: false,
    });
  });

  it("falls back through less strict constraint candidates until capture succeeds", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi
      .fn<
        (constraints: MediaStreamConstraints) => Promise<MediaStream>
      >()
      .mockRejectedValueOnce(new Error("exact device unsupported"))
      .mockRejectedValueOnce(new Error("deviceId ideal unsupported"))
      .mockResolvedValue(stream);

    const result = await requestLowLatencyMicStream("mic-1", getUserMedia);

    expect(result).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        latency: 0,
        deviceId: { exact: "mic-1" },
      },
      video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        latency: 0,
      },
      video: false,
    });
  });

  it("rethrows the last capture error if all candidates fail", async () => {
    const finalError = new Error("permission denied");
    const getUserMedia = vi
      .fn<
        (constraints: MediaStreamConstraints) => Promise<MediaStream>
      >()
      .mockRejectedValue(finalError);

    await expect(requestLowLatencyMicStream("", getUserMedia)).rejects.toBe(
      finalError,
    );
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: true,
      video: false,
    });
  });
});