import { useCallback, useEffect, useState } from "react";
import { getPlaceStreamDecks, pairStreamDeck, releaseStreamDeck } from "../api";
import type { StreamDeckDevice } from "../types";
import { SettingsGroup } from "./settings/SettingsParts";

type StreamDeckPlaceBarProps = {
  token: string;
  /** The editor's layout belongs to another target now: reload it. */
  onChanged: () => void;
};

/**
 * Which Companion Stream Decks belong to this place, and pairing a new one
 * with the code it shows. With a deck here, the editor below edits that
 * deck's layout instead of the role's.
 */
export function StreamDeckPlaceBar({
  token,
  onChanged,
}: StreamDeckPlaceBarProps) {
  const [decks, setDecks] = useState<StreamDeckDevice[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setDecks(await getPlaceStreamDecks(token));
    } catch {
      setDecks([]);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pair() {
    setBusy(true);
    setError("");
    try {
      await pairStreamDeck(token, code.trim());
      setCode("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "pairing failed");
    } finally {
      setBusy(false);
    }
  }

  async function release(deck: StreamDeckDevice) {
    if (
      !window.confirm(
        `Release "${deck.name}" from this place? It then shows a new code.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await releaseStreamDeck(token, deck.id);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "release failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title="Companion deck">
      {decks.length > 0 ? (
        decks.map((deck) => (
          <div key={deck.id} className="streamdeck-place-deck">
            <span>
              <strong>{deck.name}</strong>
              <small className="k-setting-hint">
                {deck.hasLayout
                  ? "Uses the layout below."
                  : "Uses the role's layout until you save one here."}
              </small>
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => void release(deck)}
              disabled={busy}
            >
              Release
            </button>
          </div>
        ))
      ) : (
        <small className="k-setting-hint">
          No Companion Stream Deck is paired with this place yet.
        </small>
      )}
      <form
        className="k-setting-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void pair();
        }}
      >
        <input
          value={code}
          onChange={(e) =>
            setCode(e.target.value.replace(/\D/g, "").slice(0, 4))
          }
          inputMode="numeric"
          placeholder="Code"
          aria-label="Stream Deck code"
          className="streamdeck-code-input"
          disabled={busy}
        />
        <button
          type="submit"
          className="secondary"
          disabled={busy || code.length !== 4}
        >
          Pair deck
        </button>
        <small className="k-setting-hint">
          Enter the code a new Companion Stream Deck shows.
        </small>
      </form>
      {error ? <small className="streamdeck-error">{error}</small> : null}
    </SettingsGroup>
  );
}
