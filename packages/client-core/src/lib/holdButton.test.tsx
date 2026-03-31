import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createHoldButtonProps } from "./holdButton";

function renderHoldButton(onStart = vi.fn(), onStop = vi.fn()) {
  function TestButton() {
    return (
      <button type="button" {...createHoldButtonProps({ onStart, onStop })}>
        Hold
      </button>
    );
  }

  render(<TestButton />);
  const button = screen.getByRole("button", { name: "Hold" });

  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  let capturedPointerId: number | null = null;

  Object.defineProperties(button, {
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        capturedPointerId = pointerId;
        setPointerCapture(pointerId);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => capturedPointerId === pointerId,
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        if (capturedPointerId === pointerId) {
          capturedPointerId = null;
        }
        releasePointerCapture(pointerId);
      },
    },
  });

  return { button, onStart, onStop, releasePointerCapture, setPointerCapture };
}

describe("createHoldButtonProps", () => {
  it("keeps the hold active when the pointer leaves the button", () => {
    const { button, onStart, onStop, releasePointerCapture, setPointerCapture } =
      renderHoldButton();

    fireEvent.pointerDown(button, { button: 0, pointerId: 7, pointerType: "touch" });
    fireEvent.pointerLeave(button, { pointerId: 7, pointerType: "touch" });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerUp(button, { pointerId: 7, pointerType: "touch" });

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("stops exactly once when pointer capture is lost unexpectedly", () => {
    const { button, onStop } = renderHoldButton();

    fireEvent.pointerDown(button, { button: 0, pointerId: 9, pointerType: "touch" });
    fireEvent(button, new Event("lostpointercapture", { bubbles: true }));
    fireEvent.pointerCancel(button, { pointerId: 9, pointerType: "touch" });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("uses the stop handler from pointer down even after rerender", () => {
    const initialStop = vi.fn();
    const nextStop = vi.fn();

    function TestButton({ onStop }: { onStop: () => void }) {
      return (
        <button
          type="button"
          {...createHoldButtonProps({ onStart: vi.fn(), onStop })}
        >
          Hold
        </button>
      );
    }

    const { rerender } = render(<TestButton onStop={initialStop} />);
    const button = screen.getByRole("button", { name: "Hold" });

    let capturedPointerId: number | null = null;
    Object.defineProperties(button, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          capturedPointerId = pointerId;
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointerId === pointerId,
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          if (capturedPointerId === pointerId) {
            capturedPointerId = null;
          }
        },
      },
    });

    fireEvent.pointerDown(button, { button: 0, pointerId: 11, pointerType: "touch" });

    rerender(<TestButton onStop={nextStop} />);
    fireEvent.pointerUp(button, { pointerId: 11, pointerType: "touch" });

    expect(initialStop).toHaveBeenCalledTimes(1);
    expect(nextStop).not.toHaveBeenCalled();
  });
});