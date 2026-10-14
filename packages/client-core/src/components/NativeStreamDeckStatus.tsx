import type { NativeStreamDeckState } from "../hooks/useNativeStreamDeck";
import { SettingsGroup } from "./settings/SettingsParts";

/**
 * Desktop app only: the Stream Deck plugged into this PC, driven directly
 * without Companion (decision 0008).
 */
export function NativeStreamDeckStatus({ deck }: { deck: NativeStreamDeckState }) {
  const { status, linked, error } = deck;
  if (!status) return null;

  let line: string;
  let hint: string;
  if (status.connected) {
    line = `${status.model} (${status.serial})`;
    hint = linked
      ? "Connected to this PC. Its keys use the layout below."
      : "Connected to this PC, connecting to the server…";
  } else if (status.unsupportedModel) {
    line = `${status.unsupportedModel} plugged in`;
    hint =
      "This app drives the Stream Deck MK.2 (15 keys) so far. Use Companion for other models.";
  } else {
    line = "No Stream Deck plugged in";
    hint =
      "Plug a Stream Deck MK.2 into this PC: it works right away, without Companion. Close the Elgato Stream Deck software first, only one program can use the deck.";
  }

  return (
    <SettingsGroup title="Stream Deck on this PC">
      <div className="streamdeck-place-deck">
        <span>
          <strong>{line}</strong>
          <small className="k-setting-hint">{hint}</small>
        </span>
      </div>
      {error ? <small className="streamdeck-error">{error}</small> : null}
    </SettingsGroup>
  );
}
