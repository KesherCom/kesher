import { useCallback, useEffect, useState } from "react";
import type {
  KeyboardShortcutSettings,
  ShortcutAction,
  ShortcutBinding,
} from "../app/settings";
import {
  allShortcutActions,
  formatBinding,
  shortcutActionMeta,
} from "../app/settings";

type KeyboardShortcutsSettingsProps = {
  shortcuts: KeyboardShortcutSettings;
  onShortcutsChange: (next: KeyboardShortcutSettings) => void;
  onRecordingChange?: (isRecording: boolean) => void;
};

export function KeyboardShortcutsSettings({
  shortcuts,
  onShortcutsChange,
  onRecordingChange,
}: KeyboardShortcutsSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Which action is currently being recorded (null = none).
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  const startRecording = useCallback(
    (action: ShortcutAction) => {
      setRecording(action);
      onRecordingChange?.(true);
    },
    [onRecordingChange],
  );

  const clearBinding = useCallback(
    (action: ShortcutAction) => {
      onShortcutsChange({ ...shortcuts, [action]: null });
    },
    [shortcuts, onShortcutsChange],
  );

  // Listen for key presses while recording.
  useEffect(() => {
    if (!recording) return;

    function handleKeyDown(event: KeyboardEvent) {
      // Ignore modifier-only presses – user hasn't finished the combo yet.
      if (
        event.code === "ShiftLeft" ||
        event.code === "ShiftRight" ||
        event.code === "ControlLeft" ||
        event.code === "ControlRight" ||
        event.code === "AltLeft" ||
        event.code === "AltRight" ||
        event.code === "MetaLeft" ||
        event.code === "MetaRight"
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Escape cancels recording without changing the binding.
      if (event.code === "Escape") {
        setRecording(null);
        onRecordingChange?.(false);
        return;
      }

      const binding: ShortcutBinding = {
        code: event.code,
        ...(event.ctrlKey || event.metaKey ? { ctrl: true } : {}),
        ...(event.shiftKey ? { shift: true } : {}),
        ...(event.altKey ? { alt: true } : {}),
      };

      onShortcutsChange({ ...shortcuts, [recording!]: binding });
      setRecording(null);
      onRecordingChange?.(false);
    }

    // Also cancel on blur so the user doesn't get stuck.
    function handleBlur() {
      setRecording(null);
      onRecordingChange?.(false);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [recording, shortcuts, onShortcutsChange]);

  return (
    <div className="keyboard-shortcuts-settings">
      <div className={`audio-box ${isOpen ? "" : "collapsed"}`}>
        <div className="audio-box-header">
          <button
            type="button"
            className="audio-box-toggle"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            Keyboard shortcuts
            <span className={`chev ${isOpen ? "open" : ""}`}>▾</span>
          </button>
        </div>
        {isOpen ? (
          <div className="audio-box-body">
            <table className="shortcuts-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Key</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {allShortcutActions.map((action) => {
                  const meta = shortcutActionMeta[action];
                  const binding = shortcuts[action];
                  const isRecording = recording === action;

                  return (
                    <tr key={action}>
                      <td>
                        {meta.label}
                        <small className="shortcut-type-hint">
                          {meta.type === "hold" ? "(hold)" : "(toggle)"}
                        </small>
                      </td>
                      <td>
                        {isRecording ? (
                          <span className="shortcut-recording">
                            Press a key… (Esc to cancel)
                          </span>
                        ) : (
                          <kbd className="shortcut-key">
                            {formatBinding(binding)}
                          </kbd>
                        )}
                      </td>
                      <td className="shortcut-actions">
                        {isRecording ? null : (
                          <>
                            <button
                              type="button"
                              className="shortcut-btn"
                              onClick={() => startRecording(action)}
                            >
                              Set
                            </button>
                            {binding ? (
                              <button
                                type="button"
                                className="shortcut-btn shortcut-btn-clear"
                                onClick={() => clearBinding(action)}
                              >
                                Clear
                              </button>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <small className="shortcuts-hint">
              Shortcuts are disabled while typing in text fields.
            </small>
          </div>
        ) : null}
      </div>
    </div>
  );
}
