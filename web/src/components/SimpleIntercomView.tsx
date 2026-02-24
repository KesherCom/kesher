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
}: SimpleIntercomViewProps) {
  return (
    <div className="root app simple-shell">
      <section className="simple-controls">
        <button
          className={`simple-ppt ${pttPressed ? "active" : ""}`}
          onPointerDown={onStartPpt}
          onPointerUp={onStopPpt}
          onPointerLeave={onStopPpt}
          onPointerCancel={onStopPpt}
        >
          Hold to talk
          <small>{simplePptTargetLabel}</small>
        </button>
        <button
          className={`simple-reply ${replyTarget ? "" : "disabled"}`}
          disabled={!replyTarget}
          onPointerDown={() => (replyTarget ? onStartPpt() : undefined)}
          onPointerUp={() => (replyTarget ? onStopPpt() : undefined)}
          onPointerLeave={() => (replyTarget ? onStopPpt() : undefined)}
          onPointerCancel={() => (replyTarget ? onStopPpt() : undefined)}
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
