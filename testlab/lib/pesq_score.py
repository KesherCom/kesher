"""Speech-quality score for the desktop audio benchmark.

    python pesq_score.py <reference.wav> <degraded.wav>

Both files are 48 kHz mono recordings over the same wall-clock window
(written by kesher_audio_bench in speech mode); the degraded one lags by the
end-to-end latency. The script finds that delay by cross-correlation,
resamples to 16 kHz and scores 8 s segments with wideband PESQ (ITU-T P.862.2,
MOS-LQO 1.0 .. 4.64). Segments are scored separately because PESQ is meant
for short utterances and because a latency trim shifts the alignment a little
from then on. Prints one JSON object.

Needs: numpy, scipy, pesq (pip install pesq).
"""

import json
import sys
import wave

import numpy as np
from scipy.signal import resample_poly
from pesq import pesq

RATE = 16000
SEGMENT_SECONDS = 8
MAX_DELAY_SECONDS = 1.0
# Segments quieter than this (mostly pauses) are not scored.
MIN_SEGMENT_RMS = 0.01


def read_wav(path):
    with wave.open(path) as w:
        if w.getsampwidth() != 2 or w.getframerate() != 48000:
            raise SystemExit(f"{path}: need 48 kHz 16-bit")
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        x = x.reshape(-1, w.getnchannels())[:, 0]
    return x.astype(np.float64) / 32768.0


def estimate_delay(ref, deg, max_lag):
    """Lag (samples) by which deg trails ref, via FFT cross-correlation."""
    n = len(ref) + len(deg)
    nfft = 1 << (n - 1).bit_length()
    xc = np.fft.irfft(np.fft.rfft(deg, nfft) * np.conj(np.fft.rfft(ref, nfft)), nfft)
    return int(np.argmax(xc[: max_lag + 1]))


def main():
    ref = resample_poly(read_wav(sys.argv[1]), 1, 3)
    deg = resample_poly(read_wav(sys.argv[2]), 1, 3)
    if len(ref) < RATE or len(deg) < RATE:
        print(json.dumps({"error": "recordings too short"}))
        return
    lag = estimate_delay(ref, deg, int(MAX_DELAY_SECONDS * RATE))
    deg = deg[lag:]
    n = min(len(ref), len(deg))
    ref, deg = ref[:n], deg[:n]

    seg = SEGMENT_SECONDS * RATE
    scores = []
    for start in range(0, n - seg + 1, seg):
        r, d = ref[start : start + seg], deg[start : start + seg]
        if np.sqrt(np.mean(r * r)) < MIN_SEGMENT_RMS:
            continue
        try:
            scores.append(round(float(pesq(RATE, r, d, "wb")), 3))
        except Exception as exc:  # silent/garbled segment: no utterance found
            scores.append(None)
            print(f"pesq_score: segment at {start / RATE:.0f}s: {exc}", file=sys.stderr)
    valid = [s for s in scores if s is not None]
    print(
        json.dumps(
            {
                "mos": round(float(np.mean(valid)), 2) if valid else None,
                "mosMin": round(float(np.min(valid)), 2) if valid else None,
                "segments": len(scores),
                "failedSegments": len(scores) - len(valid),
                "delayMs": round(lag / RATE * 1000, 1),
                "scores": scores,
            }
        )
    )


if __name__ == "__main__":
    main()
