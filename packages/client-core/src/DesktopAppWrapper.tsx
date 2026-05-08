import { useState } from "react";
import { useApiBaseUrl } from "./hooks/useApiBaseUrl";
import { App as CoreApp } from "./App";
import { DesktopConnectionSetup } from "./components/DesktopConnectionSetup";
import "./DesktopAppWrapper.css";

/**
 * Desktop-only wrapper around the core App that includes server URL settings.
 * On web, this just renders the core App.
 */
export function DesktopAppWrapper() {
  const { isDesktop, baseUrl } = useApiBaseUrl();
  const [entryState, setEntryState] = useState<"setup" | "app">("setup");
  const [isNetworkSettingsOpen, setIsNetworkSettingsOpen] = useState(false);

  // DEBUG: Log desktop detection
  if (typeof window !== "undefined" && true) {
    console.debug(
      "[DesktopAppWrapper] isDesktop:",
      isDesktop,
      "entryState:",
      entryState,
      "baseUrl:",
      baseUrl,
    );
  }

  if (!isDesktop) {
    return <CoreApp />;
  }

  if (entryState === "setup") {
    return <DesktopConnectionSetup onContinue={() => setEntryState("app")} />;
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
        <CoreApp onRequestNetworkSettings={() => setIsNetworkSettingsOpen(true)} />
      </main>

      {isNetworkSettingsOpen ? (
        <div
          className="desktop-network-modal-backdrop"
          onClick={() => setIsNetworkSettingsOpen(false)}
        >
          <div
            className="desktop-network-modal"
            onClick={(event) => event.stopPropagation()}
          >
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
