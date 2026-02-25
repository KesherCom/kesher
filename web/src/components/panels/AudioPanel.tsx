import type { RefObject } from "react";

type AudioPanelProps = {
  inputDevices: MediaDeviceInfo[];
  selectedInputDeviceId: string;
  selectedMicLabel: string;
  isMicMenuOpen: boolean;
  setIsMicMenuOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setSelectedInputDeviceId: (value: string) => void;
  inputLevel: number;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  selectedOutputLabel: string;
  outputSelectionSupported: boolean;
  isOutputMenuOpen: boolean;
  setIsOutputMenuOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setSelectedOutputDeviceId: (value: string) => void;
  micMenuRef: RefObject<HTMLDivElement>;
  outputMenuRef: RefObject<HTMLDivElement>;
};

export function AudioPanel({
  inputDevices,
  selectedInputDeviceId,
  selectedMicLabel,
  isMicMenuOpen,
  setIsMicMenuOpen,
  setSelectedInputDeviceId,
  inputLevel,
  outputDevices,
  selectedOutputDeviceId,
  selectedOutputLabel,
  outputSelectionSupported,
  isOutputMenuOpen,
  setIsOutputMenuOpen,
  setSelectedOutputDeviceId,
  micMenuRef,
  outputMenuRef,
}: AudioPanelProps) {
  return (
    <>
      <h3>Microphone</h3>
      <div className="mic-dropdown" ref={micMenuRef}>
        <button
          type="button"
          className="mic-dropdown-trigger"
          onClick={() => setIsMicMenuOpen((v) => !v)}
          disabled={inputDevices.length === 0}
          aria-haspopup="listbox"
          aria-expanded={isMicMenuOpen}
        >
          <span>{selectedMicLabel}</span>
          <span>▾</span>
        </button>
        {isMicMenuOpen ? (
          <div className="mic-dropdown-menu" role="listbox">
            {inputDevices.map((d) => (
              <button
                type="button"
                key={d.deviceId}
                className={`mic-dropdown-item ${d.deviceId === selectedInputDeviceId ? "active" : ""}`}
                onClick={() => {
                  setSelectedInputDeviceId(d.deviceId);
                  setIsMicMenuOpen(false);
                }}
                title={d.label || `Mic ${d.deviceId.slice(0, 6)}`}
              >
                {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="meter">
        <div className="meter-bar" style={{ width: `${inputLevel}%` }} />
      </div>
      <small>Input level</small>
      <h3 style={{ marginTop: "1rem" }}>Speaker output</h3>
      <div className="mic-dropdown" ref={outputMenuRef}>
        <button
          type="button"
          className="mic-dropdown-trigger"
          onClick={() => setIsOutputMenuOpen((v) => !v)}
          disabled={outputDevices.length === 0}
          aria-haspopup="listbox"
          aria-expanded={isOutputMenuOpen}
        >
          <span>{selectedOutputLabel}</span>
          <span>▾</span>
        </button>
        {isOutputMenuOpen ? (
          <div className="mic-dropdown-menu" role="listbox">
            <button
              type="button"
              className={`mic-dropdown-item ${selectedOutputDeviceId === "" ? "active" : ""}`}
              onClick={() => {
                setSelectedOutputDeviceId("");
                setIsOutputMenuOpen(false);
              }}
              title="System default"
            >
              System default
            </button>
            {outputDevices.map((d) => (
              <button
                type="button"
                key={d.deviceId}
                className={`mic-dropdown-item ${d.deviceId === selectedOutputDeviceId ? "active" : ""}`}
                onClick={() => {
                  setSelectedOutputDeviceId(d.deviceId);
                  setIsOutputMenuOpen(false);
                }}
                title={d.label || `Output ${d.deviceId.slice(0, 6)}`}
              >
                {d.label || `Output ${d.deviceId.slice(0, 6)}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {!outputSelectionSupported ? (
        <small>
          Explicit speaker selection is not supported by this browser; using
          system default output.
        </small>
      ) : null}
    </>
  );
}
