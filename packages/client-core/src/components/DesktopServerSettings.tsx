import { useState } from "react";
import { useApiBaseUrl } from "../hooks/useApiBaseUrl";
import "./DesktopServerSettings.css";

export function DesktopServerSettings() {
  const { baseUrl, setBaseUrl, isDesktop } = useApiBaseUrl();
  const [input, setInput] = useState(baseUrl);
  const [saved, setSaved] = useState(false);

  if (!isDesktop) {
    return null; // Don't show this panel on web
  }

  const handleSave = () => {
    if (input.trim()) {
      setBaseUrl(input.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="desktop-server-settings">
      <fieldset>
        <legend>Server URL (Desktop Only)</legend>
        <div className="field-group">
          <label htmlFor="server-url">Server Address:</label>
          <input
            id="server-url"
            type="text"
            placeholder="http://127.0.0.1:8080"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
        </div>
        <div className="button-group">
          <button onClick={handleSave}>Save</button>
          <button onClick={() => setInput(baseUrl)}>Reset</button>
        </div>
        {saved && <p className="success-message">Settings saved.</p>}
      </fieldset>
    </div>
  );
}
