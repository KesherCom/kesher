import type { PerformanceAudioControls } from "../../hooks/useIntercomSession";
import {
  INPUT_DB_MAX,
  MUTE_POS,
  formatDbFs,
  meterDbFsToPercent,
  gainToDbLabel,
  gainToSlider,
  sliderFillPercent,
  sliderToGain,
} from "../../lib/gain";
import { PerformanceAudioSettings } from "./PerformanceAudioSettings";
import { SettingSwitch, SettingsGroup } from "./SettingsParts";

function deviceLabel(device: MediaDeviceInfo, fallback: string): string {
  return device.label || `${fallback} ${device.deviceId.slice(0, 6)}`;
}

export type SoundSettingsProps = {
  inputDevices: MediaDeviceInfo[];
  selectedInputDeviceId: string;
  setSelectedInputDeviceId: (value: string) => void;
  inputLevelDbFs: number;
  inputGain: number;
  inputClipping: boolean;
  isLocalMonitorActive: boolean;
  onToggleLocalMonitor: () => void;
  onInputGainChange: (deviceId: string, gain: number) => void;
  audioGateEnabled: boolean;
  onAudioGateEnabledChange: (enabled: boolean) => void;
  audioGateThresholdDb: number;
  onAudioGateThresholdDbChange: (db: number) => void;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  outputSelectionSupported: boolean;
  setSelectedOutputDeviceId: (value: string) => void;
  /** Desktop performance engine controls; null in the browser. */
  performanceAudio?: PerformanceAudioControls | null;
};

/** Microphone (device, level, test, gain, noise gate) and speaker. */
export function SoundSettings({
  inputDevices,
  selectedInputDeviceId,
  setSelectedInputDeviceId,
  inputLevelDbFs,
  inputGain,
  inputClipping,
  isLocalMonitorActive,
  onToggleLocalMonitor,
  onInputGainChange,
  audioGateEnabled,
  onAudioGateEnabledChange,
  audioGateThresholdDb,
  onAudioGateThresholdDbChange,
  outputDevices,
  selectedOutputDeviceId,
  outputSelectionSupported,
  setSelectedOutputDeviceId,
  performanceAudio,
}: SoundSettingsProps) {
  return (
    <>
      <SettingsGroup title="Microphone">
        <label className="k-field">
          <span>Device</span>
          <select
            value={selectedInputDeviceId}
            onChange={(event) => setSelectedInputDeviceId(event.target.value)}
            disabled={inputDevices.length === 0}
          >
            {inputDevices.length === 0 ? (
              <option value="">No microphone found</option>
            ) : null}
            {inputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceLabel(d, "Microphone")}
              </option>
            ))}
          </select>
        </label>

        <div className="input-level-row" aria-live="polite">
          <div className="input-level-head">
            <span>Level</span>
            <strong>{formatDbFs(inputLevelDbFs)}</strong>
          </div>
          <div className="meter">
            <div
              className="meter-bar"
              style={{ width: `${meterDbFsToPercent(inputLevelDbFs)}%` }}
            />
          </div>
          <small
            className={`input-level-status ${inputClipping ? "is-clipping" : "is-ok"}`}
          >
            {inputClipping ? "Too loud: lower the gain" : "Level OK"}
          </small>
        </div>

        <label className="k-field" htmlFor="input-gain">
          <span>Gain {gainToDbLabel(inputGain, INPUT_DB_MAX)}</span>
          <input
            id="input-gain"
            // Double-click resets to 0 dB, like a mixer fader (#11).
            onDoubleClick={() => onInputGainChange(selectedInputDeviceId, 1)}
            title="Double-click: 0 dB"
            type="range"
            min={MUTE_POS}
            max={INPUT_DB_MAX}
            step={1}
            value={gainToSlider(inputGain, INPUT_DB_MAX)}
            style={
              {
                "--fill": `${sliderFillPercent(inputGain, INPUT_DB_MAX)}%`,
              } as React.CSSProperties
            }
            onChange={(event) =>
              onInputGainChange(
                selectedInputDeviceId,
                sliderToGain(Number(event.currentTarget.value), INPUT_DB_MAX),
              )
            }
            aria-label="Input gain"
          />
        </label>

        <div className="k-setting-actions">
          <button
            type="button"
            className={`secondary ${isLocalMonitorActive ? "active" : ""}`}
            aria-pressed={isLocalMonitorActive}
            onClick={onToggleLocalMonitor}
          >
            {isLocalMonitorActive ? "Stop test" : "Hear yourself"}
          </button>
          <small className="k-setting-hint">
            {isLocalMonitorActive
              ? "You hear your own microphone. Adjust the headset and gain."
              : "Put on headphones first."}
          </small>
        </div>

        <SettingSwitch
          label="Noise gate"
          hint="Mutes quiet background noise between words."
          checked={audioGateEnabled}
          onChange={onAudioGateEnabledChange}
        />
        {audioGateEnabled ? (
          <label className="k-field" htmlFor="input-gate-threshold">
            <span>Opens above {Math.round(audioGateThresholdDb)} dBFS</span>
            <input
              id="input-gate-threshold"
              type="range"
              min={-72}
              max={-12}
              step={1}
              value={audioGateThresholdDb}
              onChange={(event) =>
                onAudioGateThresholdDbChange(Number(event.currentTarget.value))
              }
              aria-label="Microphone gate threshold"
            />
          </label>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Speaker">
        <label className="k-field">
          <span>Device</span>
          <select
            value={selectedOutputDeviceId}
            onChange={(event) => setSelectedOutputDeviceId(event.target.value)}
            disabled={!outputSelectionSupported}
          >
            <option value="">System default</option>
            {outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceLabel(d, "Speaker")}
              </option>
            ))}
          </select>
        </label>
        {!outputSelectionSupported ? (
          <small className="k-setting-hint">
            This browser always plays through the system default speaker.
          </small>
        ) : null}
      </SettingsGroup>

      {performanceAudio ? (
        <SettingsGroup title="Performance audio">
          <PerformanceAudioSettings
            performanceAudio={performanceAudio}
            showBackendChoice={
              typeof navigator !== "undefined" &&
              /Windows/i.test(navigator.userAgent)
            }
          />
        </SettingsGroup>
      ) : null}
    </>
  );
}
