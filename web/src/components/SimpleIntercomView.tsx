type DirectReplyTarget = {
  userId: string;
  username: string;
};

type SimpleIntercomViewProps = {
  pttPressed: boolean;
  onStartPtt: () => void;
  onStopPtt: () => void;
  replyTarget: DirectReplyTarget | null;
  directPttPressedUserId: string | null;
  onStartDirectPtt: (userId: string) => void;
  onStopDirectPtt: (userId: string) => void;
  selectedInputDeviceId: string;
  onSelectedInputDeviceIdChange: (deviceId: string) => void;
  inputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  onSelectedOutputDeviceIdChange: (deviceId: string) => void;
  outputDevices: MediaDeviceInfo[];
  simplePttTargetLabel: string;
};

export function SimpleIntercomView({
  pttPressed,
  onStartPtt,
  onStopPtt,
  replyTarget,
  directPttPressedUserId,
  onStartDirectPtt,
  onStopDirectPtt,
  selectedInputDeviceId,
  onSelectedInputDeviceIdChange,
  inputDevices,
  selectedOutputDeviceId,
  onSelectedOutputDeviceIdChange,
  outputDevices,
  simplePttTargetLabel
}: SimpleIntercomViewProps) {
  return (
    <div className="root app simple-shell">
      <section className="simple-controls">
        <button
          className={`simple-ptt ${pttPressed ? "active" : ""}`}
          onPointerDown={onStartPtt}
          onPointerUp={onStopPtt}
          onPointerLeave={onStopPtt}
          onPointerCancel={onStopPtt}
        >
          Hold to talk
          <small>{simplePttTargetLabel}</small>
        </button>
        <button
          className={`simple-reply ${replyTarget ? "" : "disabled"} ${
            replyTarget && directPttPressedUserId === replyTarget.userId ? "active" : ""
          }`}
          disabled={!replyTarget}
          onPointerDown={() => (replyTarget ? onStartDirectPtt(replyTarget.userId) : undefined)}
          onPointerUp={() => (replyTarget ? onStopDirectPtt(replyTarget.userId) : undefined)}
          onPointerLeave={() => (replyTarget ? onStopDirectPtt(replyTarget.userId) : undefined)}
          onPointerCancel={() => (replyTarget ? onStopDirectPtt(replyTarget.userId) : undefined)}
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
            {outputDevices.length === 0 ? <option value="">No output devices</option> : null}
            {outputDevices.map((d) => (
              <option key={`simple-out-${d.deviceId}`} value={d.deviceId}>
                {d.label || `Output ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
      </section>
    </div>
  );
}

