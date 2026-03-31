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

export function useApiBaseUrl(): ApiBaseUrlContextType {
  const ctx = useContext(ApiBaseUrlContext);
  if (!ctx) {
    throw new Error("useApiBaseUrl must be used within ApiBaseUrlProvider");
  }
  return ctx;
}

export function ApiBaseUrlProvider({ children }: { children: React.ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>(() => {
    // Check if running in Tauri desktop environment
    return typeof window !== "undefined" && "__TAURI__" in window ? "" : "";
  });
  const [isDesktop] = useState(() => typeof window !== "undefined" && "__TAURI__" in window);
  const [isReady, setIsReady] = useState(() => !isDesktop);

  // On desktop, load the server URL from Tauri command on mount
  useEffect(() => {
    if (!isDesktop) {
      setIsReady(true);
      return;
    }

    const loadServerUrl = async () => {
      try {
        // @ts-expect-error Tauri window object is injected at runtime
        const { invoke } = window.__TAURI__.core;
        const url = await invoke<string>("get_server_url");
        if (url) {
          const normalized = normalizeServerAddressInput(url);
          setBaseUrlState(normalized);
          setGlobalApiBaseUrl(normalized);
        } else {
          setBaseUrlState("");
          setGlobalApiBaseUrl("");
        }
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
        // @ts-expect-error Tauri window object is injected at runtime
        const { invoke } = window.__TAURI__.core;
        invoke("set_server_url", { serverUrl: normalized }).catch((error: unknown) => {
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
