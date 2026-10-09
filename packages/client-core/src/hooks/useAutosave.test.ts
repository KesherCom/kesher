import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosave } from "./useAutosave";

describe("useAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const onSaved = vi.fn();
    const onError = vi.fn();
    const hook = renderHook(() =>
      useAutosave<number>({ delayMs: 800, onSaved, onError }),
    );
    return { hook, onSaved, onError };
  }

  it("saves once, shortly after the last change", async () => {
    const { hook, onSaved } = setup();
    const save = vi.fn(async (value: number) => value);

    act(() => hook.result.current.schedule(1, save));
    act(() => hook.result.current.schedule(2, save));
    expect(hook.result.current.state).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(2);
    expect(onSaved).toHaveBeenCalledWith(2);
    expect(hook.result.current.state).toBe("saved");
  });

  it("keeps a newer change when an older save finishes late", async () => {
    const { hook, onSaved } = setup();
    let finishFirst: (value: number) => void = () => {};
    const slowSave = vi.fn(
      () => new Promise<number>((resolve) => (finishFirst = resolve)),
    );
    const fastSave = vi.fn(async (value: number) => value);

    act(() => hook.result.current.schedule(1, slowSave));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    act(() => hook.result.current.schedule(2, fastSave));
    await act(async () => {
      finishFirst(1);
    });

    // The late answer for 1 must not replace the newer value 2.
    expect(onSaved).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(onSaved).toHaveBeenCalledWith(2);
  });

  it("reports an error and saves again on flush", async () => {
    const { hook, onError, onSaved } = setup();
    const save = vi
      .fn<(value: number) => Promise<number>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(3);

    act(() => hook.result.current.schedule(3, save));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(hook.result.current.state).toBe("error");
    expect(onError).toHaveBeenCalledWith("offline");

    await act(async () => {
      await hook.result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledWith(3);
    expect(hook.result.current.state).toBe("saved");
  });

  it("drops a waiting change on discard", async () => {
    const { hook } = setup();
    const save = vi.fn(async (value: number) => value);

    act(() => hook.result.current.schedule(1, save));
    act(() => hook.result.current.discard());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(save).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe("saved");
  });
});
