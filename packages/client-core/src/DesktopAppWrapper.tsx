import { useEffect, useState } from "react";
import { useApiBaseUrl } from "./hooks/useApiBaseUrl";
import { App as CoreApp } from "./App";
import { DesktopConnectionSetup } from "./components/DesktopConnectionSetup";
import "./DesktopAppWrapper.css";

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
  const [isNetworkSettingsOpen, setIsNetworkSettingsOpen] = useState(false);

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
    <div className="desktop-shell">
      <header className="desktop-shell-menu">
        <div className="desktop-shell-menu-left">Kesher Desktop</div>
        <div className="desktop-shell-menu-right">
          <span className="desktop-shell-current-server">{baseUrl}</span>
          <button
            type="button"
            className="desktop-shell-network-button"
            onClick={() => setIsNetworkSettingsOpen(true)}
          >
            Netzwerk
          </button>
        </div>
      </header>

      <main className="desktop-shell-content">
        <CoreApp />
      </main>

      {isNetworkSettingsOpen ? (
        <div className="desktop-network-modal-backdrop" onClick={() => setIsNetworkSettingsOpen(false)}>
          <div className="desktop-network-modal" onClick={(event) => event.stopPropagation()}>
            <DesktopConnectionSetup
              compact
              onContinue={() => {
                setEntryState("app");
                setIsNetworkSettingsOpen(false);
              }}
              onCancel={() => setIsNetworkSettingsOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
