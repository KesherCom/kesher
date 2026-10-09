import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveState = "saved" | "pending" | "saving" | "error";

type Pending<T> = { value: T; save: (value: T) => Promise<T> };

/**
 * Saves a value shortly after the last change (typing a label, dragging a
 * key), so there is no Save button to forget. Each change carries the save
 * function of its moment, so a change made before logout still goes to the
 * account it was made in. A save that finishes after newer changes does not
 * overwrite them; their own save follows.
 */
export function useAutosave<T>({
  delayMs,
  onSaved,
  onError,
}: {
  delayMs: number;
  onSaved: (saved: T) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<AutosaveState>("saved");
  const pendingRef = useRef<Pending<T> | null>(null);
  const revisionRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onSaved, onError });
  callbacksRef.current = { onSaved, onError };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Save the pending change now (also the retry after an error). */
  const flush = useCallback(async () => {
    clearTimer();
    const pending = pendingRef.current;
    if (!pending) return;
    const revision = revisionRef.current;
    setState("saving");
    try {
      const saved = await pending.save(pending.value);
      if (revision !== revisionRef.current) return;
      pendingRef.current = null;
      setState("saved");
      callbacksRef.current.onSaved(saved);
    } catch (err) {
      if (revision !== revisionRef.current) return;
      setState("error");
      callbacksRef.current.onError(
        err instanceof Error ? err.message : "Saving failed.",
      );
    }
  }, []);

  const schedule = useCallback(
    (value: T, save: (value: T) => Promise<T>) => {
      pendingRef.current = { value, save };
      revisionRef.current += 1;
      setState("pending");
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, delayMs);
    },
    [delayMs, flush],
  );

  /** Drop the pending change (the value was replaced from elsewhere). */
  const discard = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
    revisionRef.current += 1;
    setState("saved");
  }, []);

  // Leaving the page or logging out: save what is still waiting.
  useEffect(() => {
    const onPageHide = () => {
      if (pendingRef.current) void flush();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (timerRef.current !== null) void flush();
    };
  }, [flush]);

  return { state, schedule, flush, discard };
}
