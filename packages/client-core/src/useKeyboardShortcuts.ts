import { useEffect, useRef } from "react";
import type {
  KeyboardShortcutSettings,
  ShortcutAction,
  ShortcutBinding,
} from "./settings";
import { allShortcutActions, shortcutActionMeta } from "./settings";

/**
 * Callbacks for each shortcut action.
 * - hold-type actions use onStart / onStop (keydown / keyup).
 * - toggle-type actions use onToggle (single keydown, no repeat).
 */
export type ShortcutCallbacks = {
  ptt?: { onStart: () => void; onStop: () => void };
  toggleAlwaysOn?: { onToggle: () => void };
};

/** Check whether a KeyboardEvent matches a binding. */
function eventMatchesBinding(
  event: KeyboardEvent,
  binding: ShortcutBinding,
): boolean {
  if (event.code !== binding.code) return false;
  if (Boolean(binding.ctrl) !== (event.ctrlKey || event.metaKey)) return false;
  if (Boolean(binding.shift) !== event.shiftKey) return false;
  if (Boolean(binding.alt) !== event.altKey) return false;
  return true;
}

/** Find which action (if any) matches a keyboard event. */
function matchAction(
  event: KeyboardEvent,
  shortcuts: KeyboardShortcutSettings,
): ShortcutAction | null {
  for (const action of allShortcutActions) {
    const binding = shortcuts[action];
    if (binding && eventMatchesBinding(event, binding)) return action;
  }
  return null;
}

/** Returns true when focus is inside a text-editable element. */
function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * React hook – registers global keydown / keyup listeners and dispatches
 * shortcut actions. Automatically handles hold vs toggle semantics and
 * prevents key-repeat from firing multiple starts.
 *
 * @param shortcuts Current shortcut bindings (from settings).
 * @param callbacks Action handlers.
 * @param enabled  Pass false to temporarily suspend shortcuts (e.g. when
 *                 recording a new binding).
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcutSettings,
  callbacks: ShortcutCallbacks,
  enabled = true,
): void {
  // Refs keep the latest values without re-registering listeners.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Track which hold-type actions are currently active so we release correctly.
  const activeHoldActions = useRef(new Set<ShortcutAction>());

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!enabledRef.current) return;
      if (isEditableTarget(event)) return;

      const action = matchAction(event, shortcutsRef.current);
      if (!action) return;

      const meta = shortcutActionMeta[action];
      const cbs = callbacksRef.current;

      if (meta.type === "hold") {
        // Prevent repeat-fire while held
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        if (activeHoldActions.current.has(action)) return;
        activeHoldActions.current.add(action);
        event.preventDefault();
        if (action === "ptt" && cbs.ptt) cbs.ptt.onStart();
      } else if (meta.type === "toggle") {
        if (event.repeat) return;
        event.preventDefault();
        if (action === "toggleAlwaysOn" && cbs.toggleAlwaysOn) {
          cbs.toggleAlwaysOn.onToggle();
        }
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (!enabledRef.current) return;

      // For key-up we need to release any matching hold-type action,
      // even if focus is now in an editable (user pressed inside, then
      // tabbed out while holding).
      const action = matchAction(event, shortcutsRef.current);
      if (!action) return;

      const meta = shortcutActionMeta[action];
      if (meta.type !== "hold") return;
      if (!activeHoldActions.current.has(action)) return;

      activeHoldActions.current.delete(action);
      event.preventDefault();
      const cbs = callbacksRef.current;
      if (action === "ptt" && cbs.ptt) cbs.ptt.onStop();
    }

    // Release all hold-type shortcuts when the window loses focus to
    // ensure we don't get stuck in a "pressed" state.
    function handleBlur() {
      const cbs = callbacksRef.current;
      for (const action of activeHoldActions.current) {
        if (action === "ptt" && cbs.ptt) cbs.ptt.onStop();
      }
      activeHoldActions.current.clear();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      // Clean up any dangling holds
      handleBlur();
    };
  }, []);
}
