import { useApiBaseUrl } from "./hooks/useApiBaseUrl";
import { App as CoreApp } from "./App";
import { DesktopServerSettings } from "./components/DesktopServerSettings";

/**
 * Desktop-only wrapper around the core App that includes server URL settings.
 * On web, this just renders the core App.
 */
export function DesktopAppWrapper() {
  const { isDesktop } = useApiBaseUrl();

  if (!isDesktop) {
    return <CoreApp />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <DesktopServerSettings />
      <div style={{ flex: 1, overflow: "auto" }}>
        <CoreApp />
      </div>
    </div>
  );
}
