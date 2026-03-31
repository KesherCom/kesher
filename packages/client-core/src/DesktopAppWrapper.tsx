import { useEffect, useState } from "react";
import { useApiBaseUrl } from "./hooks/useApiBaseUrl";
import { App as CoreApp } from "./App";
import { DesktopConnectionSetup } from "./components/DesktopConnectionSetup";

const startupCheckTimeoutMs = 3500;

async function checkServerReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), startupCheckTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/public/bootstrap`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Desktop-only wrapper around the core App that includes server URL settings.
 * On web, this just renders the core App.
 */
export function DesktopAppWrapper() {
  const { isDesktop, isReady, baseUrl } = useApiBaseUrl();
  const [entryState, setEntryState] = useState<"probing" | "setup" | "app">("probing");

  useEffect(() => {
    if (!isDesktop || !isReady) {
      return;
    }

    // No URL configured yet → skip probe, show setup immediately
    if (!baseUrl) {
      setEntryState("setup");
      return;
    }

    let cancelled = false;

    const runStartupCheck = async () => {
      const ok = await checkServerReachable(baseUrl);
      if (cancelled) {
        return;
      }
      setEntryState(ok ? "app" : "setup");
    };

    void runStartupCheck();

    return () => {
      cancelled = true;
    };
  }, [baseUrl, isDesktop, isReady]);

  if (!isDesktop) {
    return <CoreApp />;
  }

  if (!isReady || entryState === "probing") {
    return <div className="desktop-connection-loading">Verbinde mit Server ...</div>;
  }

  if (entryState === "setup") {
    return (
      <DesktopConnectionSetup onContinue={() => setEntryState("app")} />
    );
  }

  return (
    <CoreApp />
  );
}
