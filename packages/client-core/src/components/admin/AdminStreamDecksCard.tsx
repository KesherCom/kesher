import { useCallback, useEffect, useState } from "react";
import {
  deleteAdminStreamDeck,
  getAdminStreamDecks,
  resetAdminStreamDeckLayout,
  updateAdminStreamDeck,
} from "../../api";
import type { Bootstrap, ClientPlace, StreamDeckDevice } from "../../types";

type AdminStreamDecksCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

type DeckDraft = { name: string; placeId: string };

const POLL_MS = 5000;

/**
 * Stream Decks reached through Companion (one Companion connection per deck,
 * named after the deck). Each deck belongs to a place and controls whoever
 * is logged in there. See docs/COMPANION-SETUP.md.
 */
export function AdminStreamDecksCard({ token, adminPin, appData }: AdminStreamDecksCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [decks, setDecks] = useState<StreamDeckDevice[]>([]);
  const [places, setPlaces] = useState<ClientPlace[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DeckDraft>({ name: "", placeId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await getAdminStreamDecks(token, adminPin);
      setDecks(result.decks ?? []);
      setPlaces(result.places ?? []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load stream decks");
    }
  }, [token, adminPin]);

  useEffect(() => {
    if (!isOpen) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [isOpen, load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  const roleName = (id?: string) => appData.roles.find((r) => r.id === id)?.name ?? id ?? "";

  function startEdit(deck: StreamDeckDevice) {
    setEditing(deck.id);
    setDraft({ name: deck.name, placeId: deck.placeId });
  }

  function save(deck: StreamDeckDevice) {
    const place = places.find((p) => p.placeId === draft.placeId);
    // Keep the old label when the place is offline right now.
    const placeLabel = draft.placeId === deck.placeId ? deck.placeLabel : place?.username ?? "";
    void run(async () => {
      await updateAdminStreamDeck(token, adminPin, deck.id, {
        name: draft.name,
        placeId: draft.placeId,
        placeLabel: draft.placeId ? placeLabel || draft.placeId : "",
      });
      setEditing(null);
    });
  }

  function remove(deck: StreamDeckDevice) {
    if (!window.confirm(`Remove Stream Deck "${deck.name}"? It shows up again when Companion reconnects.`)) return;
    void run(() => deleteAdminStreamDeck(token, adminPin, deck.id));
  }

  function resetLayout(deck: StreamDeckDevice) {
    if (!window.confirm(`Drop the own layout of "${deck.name}"? It then shows the layout of the role logged in there.`)) {
      return;
    }
    void run(() => resetAdminStreamDeckLayout(token, adminPin, deck.id));
  }

  const unpaired = decks.filter((d) => !d.placeId).length;

  function editForm(deck: StreamDeckDevice) {
    const placeIsOnline = places.some((p) => p.placeId === deck.placeId);
    return (
      <div className="admin-edit-panel">
        <div className="admin-grid">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={busy} />
          </label>
          <label>
            <span>Place</span>
            <select
              value={draft.placeId}
              onChange={(e) => setDraft({ ...draft, placeId: e.target.value })}
              disabled={busy}
              aria-label="Place"
            >
              <option value="">Not paired (deck shows its code)</option>
              {deck.placeId && !placeIsOnline ? (
                <option value={deck.placeId}>{deck.placeLabel || deck.placeId} (offline)</option>
              ) : null}
              {places.map((place) => (
                <option key={place.placeId} value={place.placeId}>
                  {place.username} · {roleName(place.roleId)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="admin-form-actions">
          <button onClick={() => save(deck)} disabled={busy || !draft.name.trim()}>
            Save
          </button>
          <button className="secondary" onClick={() => setEditing(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">
          Stream Decks
          {unpaired > 0 ? <span className="admin-device-badge">{unpaired} not paired</span> : null}
        </div>
        <div className="admin-card-actions">
          <button className="admin-toggle-button" onClick={() => setIsOpen((v) => !v)} aria-expanded={isOpen}>
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <p>
            Each Stream Deck has its own Kesher connection in Companion, named after the deck (serial number or a name
            like &quot;Camera 1&quot;). It appears here by itself and belongs to a place: it controls whoever is logged
            in there. Pair it here, or type the code it shows in the Stream Deck section of the app at that place.
          </p>
          {error ? <p className="admin-error">{error}</p> : null}
          <ul className="admin-list">
            {decks.length === 0 ? (
              <li>
                <span className="admin-empty">No Stream Decks yet.</span>
              </li>
            ) : (
              decks.map((deck) => (
                <li key={deck.id} className="admin-device-row">
                  {editing === deck.id ? (
                    <div className="admin-device">{editForm(deck)}</div>
                  ) : (
                    <>
                      <span>
                        <span
                          className={`admin-device-dot ${deck.connected ? "online" : ""}`}
                          title={deck.connected ? "Companion connected" : "Companion not connected"}
                        />
                        <strong>{deck.name}</strong>{" "}
                        {deck.placeId ? (
                          <>
                            · {deck.placeLabel || "place"}
                            {deck.username ? (
                              <>
                                {" "}
                                (now: {deck.username} · {roleName(deck.roleId)})
                              </>
                            ) : (
                              <> (nobody logged in)</>
                            )}
                          </>
                        ) : (
                          <>
                            · not paired · code <strong>{deck.pairingCode}</strong>
                          </>
                        )}{" "}
                        <small>
                          {deck.hasLayout ? "own layout" : "role layout"}
                          {deck.surface ? ` · ${deck.surface}` : ""}
                          {deck.lastIp ? ` · ${deck.lastIp}` : ""}
                        </small>
                      </span>
                      <span className="admin-device-actions">
                        <button className="secondary" onClick={() => startEdit(deck)} disabled={busy}>
                          {deck.placeId ? "Edit" : "Pair…"}
                        </button>
                        {deck.hasLayout ? (
                          <button className="secondary" onClick={() => resetLayout(deck)} disabled={busy}>
                            Use role layout
                          </button>
                        ) : null}
                        <button className="secondary" onClick={() => remove(deck)} disabled={busy}>
                          Remove
                        </button>
                      </span>
                    </>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
