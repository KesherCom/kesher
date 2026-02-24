import { useState } from "react";

type DirectReplyTarget = {
  userId: string;
  username: string;
};

type SimpleIntercomViewProps = {
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
  simplePptTargetLabel: string;
  doLogout: () => void;
};

export function SimpleIntercomView({
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
  simplePptTargetLabel
  ,
  doLogout
}: SimpleIntercomViewProps) {
  const [pressedButton, setPressedButton] = useState<"main" | "reply" | null>(null);

  const mainActive = pressedButton === "main" || (pttPressed && pressedButton == null);
  const replyActive = pressedButton === "reply";

  return (
    <div className="root app simple-shell">
      <section className="simple-controls">
        <div className="simple-top-actions">
          <button className="simple-logout" onClick={doLogout}>Logout</button>
        </div>
        <button
          className={`simple-ptt ${mainActive ? "active" : ""}`}
          onPointerDown={() => {
            setPressedButton("main");
            onStartPpt();
          }}
          onPointerUp={() => {
            setPressedButton(null);
            onStopPpt();
          }}
          onPointerLeave={() => {
            setPressedButton(null);
            onStopPpt();
          }}
          onPointerCancel={() => {
            setPressedButton(null);
            onStopPpt();
          }}
        >
          Hold to talk
          <small>{simplePptTargetLabel}</small>
        </button>
        <button
          className={`simple-reply ${replyTarget ? "" : "disabled"} ${replyActive ? "active" : ""}`}
          disabled={!replyTarget}
          onPointerDown={() => {
            if (!replyTarget) return;
            setPressedButton("reply");
            onStartPpt();
          }}
          onPointerUp={() => {
            if (!replyTarget) return;
            setPressedButton(null);
            onStopPpt();
          }}
          onPointerLeave={() => {
            if (!replyTarget) return;
            setPressedButton(null);
            onStopPpt();
          }}
          onPointerCancel={() => {
            if (!replyTarget) return;
            setPressedButton(null);
            onStopPpt();
          }}
        >
          Reply to caller
          <small>{replyTarget ? replyTarget.username : "No active caller"}</small>
        </button>

        <label className="simple-mic">
          <span>Microphone</span>
          <select
            value={selectedInputDeviceId}
            onChange={(e) => onSelectedInputDeviceIdChange(e.target.value)}
            disabled={inputDevices.length === 0}
          >
            {inputDevices.length === 0 ? <option value="">No input devices</option> : null}
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
            {outputDevices.length === 0 ? <option value="" disabled>No output devices</option> : null}
            {outputDevices.map((d) => (
              <option key={`simple-out-${d.deviceId}`} value={d.deviceId}>
                {d.label || `Output ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          {!outputSelectionSupported ? (
            <small>Explicit speaker selection is not supported; using system default output.</small>
          ) : null}
        </label>
      </section>
    </div>
  );
}
