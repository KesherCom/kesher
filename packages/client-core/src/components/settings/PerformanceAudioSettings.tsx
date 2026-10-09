import { useState } from "react";
import type { PerformanceAudioControls } from "../../hooks/useIntercomSession";
import type {
  NativeAudioBackend,
  NativeStreamReport,
} from "../../hooks/useNativeAudio";

const backendOptions: Array<{ value: NativeAudioBackend; label: string }> = [
  { value: "auto", label: "Automatic (lowest latency)" },
  { value: "exclusive", label: "Exclusive (WASAPI)" },
  { value: "shared", label: "Shared low latency (WASAPI)" },
  { value: "system", label: "System default" },
];

const backendLabels: Record<string, string> = {
  "wasapi-exclusive": "exclusive",
  "wasapi-shared-low-latency": "shared low latency",
  system: "system",
};

function describeStream(report: NativeStreamReport): string {
  const backend = backendLabels[report.backend] ?? report.backend;
  const period =
    report.periodMs === null
      ? "driver default"
      : `${report.periodMs.toFixed(1)} ms`;
  return `${backend}, ${period}`;
}

type PerformanceAudioSettingsProps = {
  performanceAudio: PerformanceAudioControls;
  /** The driver-mode choice only exists on Windows. */
  showBackendChoice: boolean;
};

/**
 * Settings for the desktop performance audio engine: which device access
 * mode is active, the driver-mode choice and a mouth-to-ear latency test.
 */
export function PerformanceAudioSettings({
  performanceAudio,
  showBackendChoice,
}: PerformanceAudioSettingsProps) {
  const { info, backend, setBackend, measureLatency } = performanceAudio;
  const [measuring, setMeasuring] = useState(false);
  const [latencyResult, setLatencyResult] = useState<string>("");

  const runLatencyTest = async () => {
    setMeasuring(true);
    setLatencyResult("");
    const ms = await measureLatency();
    setMeasuring(false);
    setLatencyResult(
      ms === null
        ? "Click not detected. Hold the headset speaker to the mic (or loop output to input) and retry."
        : `Mouth-to-ear: ${ms.toFixed(1)} ms`,
    );
  };

  return (
    <>
      <small className="k-setting-hint">
        {info
          ? `Mic: ${describeStream(info.input)} · Speaker: ${describeStream(info.output)} · Frame ${info.frameMs} ms`
          : "Starting audio engine…"}
      </small>
      {showBackendChoice ? (
        <label className="k-field">
          <span>Device access</span>
          <select
            value={backend}
            onChange={(event) =>
              setBackend(event.currentTarget.value as NativeAudioBackend)
            }
            aria-label="Device access mode"
          >
            {backendOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {showBackendChoice && backend !== "system" ? (
        <small className="k-setting-hint">
          Exclusive mode reserves the headset for Kesher; other apps cannot use
          it meanwhile. If playback stutters, choose shared low latency.
        </small>
      ) : null}
      <div className="k-setting-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => void runLatencyTest()}
          disabled={measuring || !info}
        >
          {measuring ? "Measuring…" : "Measure latency"}
        </button>
        {latencyResult ? (
          <small className="k-setting-hint">{latencyResult}</small>
        ) : null}
      </div>
    </>
  );
}
