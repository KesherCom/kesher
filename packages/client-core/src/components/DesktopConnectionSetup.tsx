import { useCallback, useEffect, useMemo, useState } from "react";
import logoUrl from "../assets/logo.svg";
import { normalizeServerAddressInput } from "../api";
import { invokeTauri, useApiBaseUrl } from "../hooks/useApiBaseUrl";
import "./DesktopConnectionSetup.css";

/** A server announced on the LAN (Tauri command discover_servers). */
type FoundServer = {
  name: string;
  url: string;
  /** Plain-HTTP address; the app's WebView cannot use a self-signed HTTPS certificate. */
  http_url: string | null;
  version: string;
};

type DesktopConnectionSetupProps = {
  onContinue: () => void;
  onCancel?: () => void;
  compact?: boolean;
};

const connectionCheckTimeoutMs = 6000;

export function DesktopConnectionSetup({
  onContinue,
  onCancel,
  compact = false,
}: DesktopConnectionSetupProps) {
  const { baseUrl, setBaseUrl } = useApiBaseUrl();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [found, setFound] = useState<FoundServer[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    setInput(baseUrl);
  }, [baseUrl]);

  const searchServers = useCallback(async () => {
    setIsSearching(true);
    try {
      setFound(await invokeTauri<FoundServer[]>("discover_servers"));
    } catch {
      setFound([]);
    } finally {
      setIsSearching(false);
      setSearched(true);
    }
  }, []);

  useEffect(() => {
    void searchServers();
  }, [searchServers]);

  const normalizedPreview = useMemo(() => {
    try {
      return input.trim() ? normalizeServerAddressInput(input) : "";
    } catch {
      return "";
    }
  }, [input]);

  const persistAddress = (address: string = input): string | null => {
    try {
      const normalized = normalizeServerAddressInput(address);
      setBaseUrl(normalized);
      setError("");
      setSuccess("Server-Adresse lokal gespeichert.");
      return normalized;
    } catch {
      setSuccess("");
      setError(
        "Bitte eine gueltige Server-Adresse eingeben (IP, DNS oder URL).",
      );
      return null;
    }
  };

  const runConnectionCheck = async (base: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => controller.abort(),
      connectionCheckTimeoutMs,
    );

    try {
      const response = await fetch(`${base}/api/public-bootstrap`, {
        method: "GET",
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  };

  const handleSave = () => {
    void persistAddress();
  };

  const handleConnectWithCheck = async (address?: string) => {
    const normalized = persistAddress(address);
    if (!normalized) return;

    setIsChecking(true);
    setSuccess("");

    const ok = await runConnectionCheck(normalized);
    setIsChecking(false);

    if (!ok) {
      setError(
        "Verbindungstest fehlgeschlagen. Adresse pruefen oder trotzdem starten.",
      );
      return;
    }

    setError("");
    setSuccess("Verbindung erfolgreich. App wird gestartet.");
    onContinue();
  };

  const handleContinueWithoutCheck = () => {
    const normalized = persistAddress();
    if (!normalized) return;
    onContinue();
  };

  return (
    <div className={`desktop-connection-root${compact ? " compact" : ""}`}>
      <section
        className="desktop-connection-card"
        aria-label="Desktop connection setup"
      >
        <img
          className="brand-logo"
          src={logoUrl}
          alt=""
          width={56}
          height={56}
        />
        <h1 className="desktop-connection-title">
          Server-Verbindung einrichten
        </h1>
        <p className="desktop-connection-subtitle">
          Die Adresse wird lokal gespeichert. Erlaubt sind IP, DNS oder volle
          URL inklusive frei waehlbarem Port.
        </p>

        <div className="desktop-connection-found" aria-label="Gefundene Server">
          <div className="desktop-connection-found-head">
            <span className="desktop-connection-label">
              Im Netzwerk gefunden
            </span>
            <button
              type="button"
              onClick={() => void searchServers()}
              disabled={isSearching}
            >
              {isSearching ? "Suche ..." : "Erneut suchen"}
            </button>
          </div>
          {found.length > 0 ? (
            <ul className="desktop-connection-found-list">
              {found.map((server) => {
                const address = server.http_url ?? server.url;
                return (
                  <li key={server.name}>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setInput(address);
                        void handleConnectWithCheck(address);
                      }}
                      disabled={isChecking}
                    >
                      Verbinden
                    </button>
                    <span>
                      <strong>{server.name}</strong> <small>{address}</small>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="desktop-connection-hint">
              {isSearching || !searched
                ? "Suche nach Kesher-Servern ..."
                : "Kein Server gefunden. Adresse unten eingeben (z. B. wenn der Server in einem anderen Netz steht)."}
            </p>
          )}
        </div>

        <label
          className="desktop-connection-label"
          htmlFor="desktop-server-address"
        >
          Server-Adresse
        </label>
        <input
          id="desktop-server-address"
          className="desktop-connection-input"
          type="text"
          placeholder="z.B. 192.168.1.50:8090  |  server.local:3000  |  https://intercom.example.org:8443"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleConnectWithCheck();
            }
          }}
        />

        <p className="desktop-connection-hint">
          Normalisiert: {normalizedPreview || "-"}
        </p>

        <div className="desktop-connection-actions">
          <button type="button" onClick={handleSave}>
            Speichern
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleConnectWithCheck()}
            disabled={isChecking}
          >
            {isChecking ? "Teste Verbindung ..." : "Speichern und verbinden"}
          </button>
          <button type="button" onClick={handleContinueWithoutCheck}>
            Ohne Test starten
          </button>
          <button type="button" onClick={() => setInput(baseUrl)}>
            Letzte Adresse laden
          </button>
          {onCancel ? (
            <button type="button" onClick={onCancel}>
              Schliessen
            </button>
          ) : null}
        </div>

        {error ? (
          <p className="desktop-connection-status error">{error}</p>
        ) : null}
        {success ? (
          <p className="desktop-connection-status success">{success}</p>
        ) : null}
      </section>
    </div>
  );
}
