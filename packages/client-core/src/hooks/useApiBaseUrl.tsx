import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { normalizeServerAddressInput, setGlobalApiBaseUrl } from "../api";

/**
 * On desktop (Tauri), this provides runtime-configurable server URL.
 * On web, this defaults to relative paths (proxied during dev, same-origin in prod).
 */

type ApiBaseUrlContextType = {
  baseUrl: string;
  setBaseUrl: (url: string) => void;
  isDesktop: boolean;
  isReady: boolean;
};

const ApiBaseUrlContext = createContext<ApiBaseUrlContextType | null>(null);

type TauriWindow = Window & {
  __TAURI__?: {
    core?: {
      invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  };
  __TAURI_INTERNALS__?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
};

function detectDesktopEnvironment(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const tauriWindow = window as TauriWindow;
  const hasTauri = "__TAURI__" in tauriWindow || "__TAURI_INTERNALS__" in tauriWindow;
  const tauri55Style = typeof (tauriWindow as any).__TAURI_PLUGIN__ !== "undefined";
  const userAgentCheck = /\bTauri\b/i.test(navigator.userAgent || "");
  
  const detected = hasTauri || tauri55Style || userAgentCheck;
  if (detected) {
    console.debug("[detectDesktopEnvironment] Desktop detected:", {
      __TAURI__: "__TAURI__" in tauriWindow,
      __TAURI_INTERNALS__: "__TAURI_INTERNALS__" in tauriWindow,
      __TAURI_PLUGIN__: typeof (tauriWindow as any).__TAURI_PLUGIN__,
      userAgent: navigator.userAgent,
    });
  }
  return detected;
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauriWindow = window as TauriWindow;
  const globalInvoke = tauriWindow.__TAURI__?.core?.invoke;
  if (typeof globalInvoke === "function") {
    return globalInvoke<T>(cmd, args);
  }
  const internalsInvoke = tauriWindow.__TAURI_INTERNALS__?.invoke;
  if (typeof internalsInvoke === "function") {
    return internalsInvoke<T>(cmd, args);
  }
  throw new Error("Tauri invoke API is not available");
}

export function useApiBaseUrl(): ApiBaseUrlContextType {
  const ctx = useContext(ApiBaseUrlContext);
  if (!ctx) {
    throw new Error("useApiBaseUrl must be used within ApiBaseUrlProvider");
  }
  return ctx;
}

export function ApiBaseUrlProvider({ children }: { children: React.ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>("");
  const [isDesktop] = useState(detectDesktopEnvironment);
  const [isReady, setIsReady] = useState(() => !isDesktop);

  // On desktop, load the server URL from Tauri command on mount
  useEffect(() => {
    if (!isDesktop) {
      setIsReady(true);
      return;
    }

    const loadServerUrl = async () => {
      try {
        const url = await invokeTauri<string>("get_server_url");
        const normalized = normalizeServerAddressInput(url);
        setBaseUrlState(normalized);
        setGlobalApiBaseUrl(normalized);
      } catch (error) {
        console.error("Failed to load server URL from Tauri:", error);
        setBaseUrlState("");
        setGlobalApiBaseUrl("");
      } finally {
        setIsReady(true);
      }
    };

    loadServerUrl();
  }, [isDesktop]);

  const handleSetBaseUrl = useCallback((url: string) => {
    let normalized: string;
    try {
      normalized = normalizeServerAddressInput(url);
    } catch {
      return;
    }

    setBaseUrlState(normalized);
    setGlobalApiBaseUrl(normalized);

    // Persist to Tauri if on desktop
    if (isDesktop) {
      try {
        invokeTauri("set_server_url", { server_url: normalized }).catch((error: unknown) => {
          console.error("Failed to persist server URL to Tauri:", error);
        });
      } catch (error) {
        console.error("Failed to invoke Tauri set_server_url:", error);
      }
    }
  }, [isDesktop]);

  return (
    <ApiBaseUrlContext.Provider value={{ baseUrl, setBaseUrl: handleSetBaseUrl, isDesktop, isReady }}>
      {children}
    </ApiBaseUrlContext.Provider>
  );
}
