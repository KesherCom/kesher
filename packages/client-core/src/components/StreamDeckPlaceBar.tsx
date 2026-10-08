import { useCallback, useEffect, useState } from "react";
import { getPlaceStreamDecks, pairStreamDeck, releaseStreamDeck } from "../api";
import type { StreamDeckDevice } from "../types";

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
export function StreamDeckPlaceBar({ token, onChanged }: StreamDeckPlaceBarProps) {
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
    if (!window.confirm(`Release "${deck.name}" from this place? It then shows a new code.`)) return;
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
    <div className="streamdeck-place-bar">
      {decks.length > 0 ? (
        <small className="station-settings-meta">
          Companion Stream Deck at this place:{" "}
          {decks.map((deck, i) => (
            <span key={deck.id}>
              {i > 0 ? ", " : ""}
              <strong>{deck.name}</strong> ({deck.hasLayout ? "own layout" : "role layout until you save"}){" "}
              <button
                type="button"
                className="shortcut-btn shortcut-btn-clear"
                onClick={() => void release(deck)}
                disabled={busy}
              >
                Release
              </button>
            </span>
          ))}
          . The layout below is this deck&apos;s, whoever logs in here.
        </small>
      ) : null}
      <form
        className="streamdeck-settings-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void pair();
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          placeholder="Code"
          aria-label="Stream Deck code"
          style={{ width: "6em" }}
          disabled={busy}
        />
        <button type="submit" className="shortcut-btn" disabled={busy || code.length !== 4}>
          Pair deck
        </button>
        <small className="station-settings-meta">Enter the code a new Companion Stream Deck shows.</small>
      </form>
      {error ? <small className="streamdeck-error">{error}</small> : null}
    </div>
  );
}
