import { useState } from "react";
import { createHoldButtonProps } from "../lib/holdButton";

type DirectReplyTarget = {
  userId: string;
  username: string;
};

type SimpleIntercomViewProps = {
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  pttPressed: boolean;
  onStartPpt: () => void;
  onStopPpt: () => void;
  replyTarget: DirectReplyTarget | null;
  selectedInputDeviceId: string;
  onSelectedInputDeviceIdChange: (deviceId: string) => void;
  inputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  onSelectedOutputDeviceIdChange: (deviceId: string) => void;
  outputDevices: MediaDeviceInfo[];
  outputSelectionSupported: boolean;
  enableBackgroundAudioRecovery: boolean;
  onEnableBackgroundAudioRecoveryChange: (enabled: boolean) => void;
  keepScreenAwake: boolean;
  onKeepScreenAwakeChange: (enabled: boolean) => void;
  mediaSessionSupported: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  isStandaloneDisplayMode: boolean;
  simplePptTargetLabel: string;
  doLogout: () => void;
};

export function SimpleIntercomView({
  connectionState,
  pttPressed,
  onStartPpt,
  onStopPpt,
  replyTarget,
  selectedInputDeviceId,
  onSelectedInputDeviceIdChange,
  inputDevices,
  selectedOutputDeviceId,
  onSelectedOutputDeviceIdChange,
  outputDevices,
  outputSelectionSupported,
  enableBackgroundAudioRecovery,
  onEnableBackgroundAudioRecoveryChange,
  keepScreenAwake,
  onKeepScreenAwakeChange,
  mediaSessionSupported,
  wakeLockSupported,
  wakeLockActive,
  isStandaloneDisplayMode,
  simplePptTargetLabel,
  doLogout,
}: SimpleIntercomViewProps) {
  const [pressedButton, setPressedButton] = useState<"main" | "reply" | null>(
    null,
  );

  const mainActive =
    pressedButton === "main" || (pttPressed && pressedButton == null);
  const replyActive = pressedButton === "reply";
  const mainPttButtonProps = createHoldButtonProps<HTMLButtonElement>({
    onStart: () => {
      setPressedButton("main");
      onStartPpt();
    },
    onStop: () => {
      setPressedButton(null);
      onStopPpt();
    },
  });
  const replyButtonProps = createHoldButtonProps<HTMLButtonElement>({
    disabled: !replyTarget,
    onStart: () => {
      if (!replyTarget) return;
      setPressedButton("reply");
      onStartPpt();
    },
    onStop: () => {
      if (!replyTarget) return;
      setPressedButton(null);
      onStopPpt();
    },
  });

  return (
    <div className="root app simple-shell">
      {connectionState !== "connected" && (
        <div className="connection-offline-banner">
          <span className="connection-offline-icon" />
          {connectionState === "reconnecting"
            ? "Reconnecting\u2026"
            : connectionState === "connecting"
              ? "Connecting\u2026"
              : "Offline"}
        </div>
      )}
      <section className="simple-controls">
        <div className="simple-top-actions">
          <button className="simple-logout" onClick={doLogout}>
            Logout
          </button>
        </div>
        <button
          className={`simple-ptt hold-button ${mainActive ? "active" : ""}`}
          {...mainPttButtonProps}
        >
          Hold to talk
          <small>{simplePptTargetLabel}</small>
        </button>
        <button
          className={`simple-reply hold-button ${replyTarget ? "" : "disabled"} ${replyActive ? "active" : ""}`}
          disabled={!replyTarget}
          {...replyButtonProps}
        >
          Reply to caller
          <small>
            {replyTarget ? replyTarget.username : "No active caller"}
          </small>
        </button>

        <label className="simple-mic">
          <span>Microphone</span>
          <select
            value={selectedInputDeviceId}
            onChange={(e) => onSelectedInputDeviceIdChange(e.target.value)}
            disabled={inputDevices.length === 0}
          >
            {inputDevices.length === 0 ? (
              <option value="">No input devices</option>
            ) : null}
            {inputDevices.map((d) => (
              <option key={`simple-mic-${d.deviceId}`} value={d.deviceId}>
                {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
        <label className="simple-mic">
          <span>Speaker output</span>
          <select
            value={selectedOutputDeviceId}
            onChange={(e) => onSelectedOutputDeviceIdChange(e.target.value)}
            disabled={outputDevices.length === 0}
          >
            <option value="">System default</option>
            {outputDevices.length === 0 ? (
              <option value="" disabled>
                No output devices
              </option>
            ) : null}
            {outputDevices.map((d) => (
              <option key={`simple-out-${d.deviceId}`} value={d.deviceId}>
                {d.label || `Output ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          {!outputSelectionSupported ? (
            <small>
              Explicit speaker selection is not supported; using system default
              output.
            </small>
          ) : null}
        </label>
        <label className="simple-mic">
          <span>
            <input
              type="checkbox"
              checked={enableBackgroundAudioRecovery}
              onChange={(event) =>
                onEnableBackgroundAudioRecoveryChange(event.target.checked)
              }
            />{" "}
            Background audio assist
          </span>
        </label>
        <label className="simple-mic">
          <span>
            <input
              type="checkbox"
              checked={keepScreenAwake}
              disabled={!wakeLockSupported}
              onChange={(event) =>
                onKeepScreenAwakeChange(event.target.checked)
              }
            />{" "}
            Keep device awake while connected
          </span>
          <small>
            Media controls:{" "}
            {mediaSessionSupported ? "supported" : "not supported"} · Wake lock:{" "}
            {wakeLockSupported
              ? wakeLockActive
                ? "active"
                : "available"
              : "not supported"}{" "}
            · Install mode:{" "}
            {isStandaloneDisplayMode ? "installed app" : "browser tab"}
          </small>
        </label>
      </section>
    </div>
  );
}
