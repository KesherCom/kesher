import { useCallback, useState } from "react";

type UseAdminActionOptions = {
  onSuccess?: () => Promise<void> | void;
  defaultErrorMessage?: string;
};

export function useAdminAction(options: UseAdminActionOptions = {}) {
  const { onSuccess, defaultErrorMessage = "admin operation failed" } = options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await action();
        await onSuccess?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : defaultErrorMessage);
      } finally {
        setBusy(false);
      }
    },
    [defaultErrorMessage, onSuccess],
  );

  return { busy, error, setError, run };
}
