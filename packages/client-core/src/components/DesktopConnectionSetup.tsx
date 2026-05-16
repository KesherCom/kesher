import { useEffect, useMemo, useState } from "react";
import { normalizeServerAddressInput } from "../api";
import { useApiBaseUrl } from "../hooks/useApiBaseUrl";
import "./DesktopConnectionSetup.css";

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
  const { baseUrl, setBaseUrl, isReady } = useApiBaseUrl();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    setInput(baseUrl);
  }, [baseUrl]);

  const normalizedPreview = useMemo(() => {
    try {
      return input.trim() ? normalizeServerAddressInput(input) : "";
    } catch {
      return "";
    }
  }, [input]);

  const persistAddress = (): string | null => {
    try {
      const normalized = normalizeServerAddressInput(input);
      setBaseUrl(normalized);
      setError("");
      setSuccess("Server-Adresse lokal gespeichert.");
      return normalized;
    } catch {
      setSuccess("");
      setError("Bitte eine gueltige Server-Adresse eingeben (IP, DNS oder URL).");
      return null;
    }
  };

  const runConnectionCheck = async (base: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), connectionCheckTimeoutMs);

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

  const handleConnectWithCheck = async () => {
    const normalized = persistAddress();
    if (!normalized) return;

    setIsChecking(true);
    setSuccess("");

    const ok = await runConnectionCheck(normalized);
    setIsChecking(false);

    if (!ok) {
      setError("Verbindungstest fehlgeschlagen. Adresse pruefen oder trotzdem starten.");
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
      <section className="desktop-connection-card" aria-label="Desktop connection setup">
        <h1 className="desktop-connection-title">Server-Verbindung einrichten</h1>
        <p className="desktop-connection-subtitle">
          Die Adresse wird lokal gespeichert. Erlaubt sind IP, DNS oder volle URL inklusive frei waehlbarem Port.
        </p>

        <label className="desktop-connection-label" htmlFor="desktop-server-address">
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
          <button type="button" onClick={handleSave}>Speichern</button>
          <button type="button" className="primary" onClick={() => void handleConnectWithCheck()} disabled={isChecking}>
            {isChecking ? "Teste Verbindung ..." : "Speichern und verbinden"}
          </button>
          <button type="button" onClick={handleContinueWithoutCheck}>Ohne Test starten</button>
          <button type="button" onClick={() => setInput(baseUrl)}>Letzte Adresse laden</button>
          {onCancel ? <button type="button" onClick={onCancel}>Schliessen</button> : null}
        </div>

        {error ? <p className="desktop-connection-status error">{error}</p> : null}
        {success ? <p className="desktop-connection-status success">{success}</p> : null}
      </section>
    </div>
  );
}
