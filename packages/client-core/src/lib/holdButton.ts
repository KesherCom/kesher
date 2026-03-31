import type { DOMAttributes, PointerEvent as ReactPointerEvent } from "react";

type HoldButtonOptions = {
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
};

type HoldButtonProps<T extends HTMLElement> = Pick<
  DOMAttributes<T>,
  | "onLostPointerCapture"
  | "onPointerCancel"
  | "onPointerDown"
  | "onPointerUp"
>;

const ACTIVE_POINTER_DATASET_KEY = "holdPointerId";
const activePointerStops = new WeakMap<HTMLElement, () => void>();

function getActivePointerId(target: HTMLElement): number | null {
  const rawValue = target.dataset[ACTIVE_POINTER_DATASET_KEY];
  if (rawValue == null) {
    return null;
  }

  const pointerId = Number(rawValue);
  return Number.isInteger(pointerId) ? pointerId : null;
}

function clearActivePointer(target: HTMLElement) {
  delete target.dataset[ACTIVE_POINTER_DATASET_KEY];
  activePointerStops.delete(target);
}

function releasePointerCaptureSafely(target: HTMLElement, pointerId: number) {
  if (
    typeof target.hasPointerCapture === "function" &&
    typeof target.releasePointerCapture === "function" &&
    target.hasPointerCapture(pointerId)
  ) {
    target.releasePointerCapture(pointerId);
  }
}

function finishHold(
  target: HTMLElement,
  pointerId: number,
) {
  if (getActivePointerId(target) !== pointerId) {
    return;
  }

  const stop = activePointerStops.get(target);
  clearActivePointer(target);
  releasePointerCaptureSafely(target, pointerId);
  stop?.();
}

export function createHoldButtonProps<T extends HTMLElement>(
  options: HoldButtonOptions,
): HoldButtonProps<T> {
  const { disabled = false, onStart, onStop } = options;

  return {
    onPointerDown: (event: ReactPointerEvent<T>) => {
      if (disabled) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      const target = event.currentTarget;
      if (getActivePointerId(target) !== null) {
        return;
      }

      target.dataset[ACTIVE_POINTER_DATASET_KEY] = String(event.pointerId);
      activePointerStops.set(target, onStop);
      if (typeof target.setPointerCapture === "function") {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // Ignore browsers/environments that do not support pointer capture.
        }
      }

      onStart();
    },
    onPointerUp: (event: ReactPointerEvent<T>) => {
      finishHold(event.currentTarget, event.pointerId);
    },
    onPointerCancel: (event: ReactPointerEvent<T>) => {
      finishHold(event.currentTarget, event.pointerId);
    },
    onLostPointerCapture: (event: ReactPointerEvent<T>) => {
      const target = event.currentTarget;
      if (getActivePointerId(target) === null) {
        return;
      }

      const stop = activePointerStops.get(target);
      clearActivePointer(target);
      stop?.();
    },
  };
}