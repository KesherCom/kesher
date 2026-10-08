import { useState } from "react";
import { completeSetup } from "../api";
import type { PublicBootstrap } from "../types";

type SetupViewProps = {
  publicData: PublicBootstrap;
  /** Called with the new admin PIN once the server is set up. */
  onDone: (pin: string) => void;
};

/**
 * First-run setup of a fresh server (backend setup.go): choose the admin PIN
 * and whether to keep the example roles and party lines. Shown instead of the
 * login until it is done.
 */
export function SetupView({ publicData, onDone }: SetupViewProps) {
  const [pin, setPin] = useState("");
  const [repeat, setRepeat] = useState("");
  const [start, setStart] = useState<"example" | "empty">("example");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pinProblem =
    pin.length > 0 && (pin.length < 4 || /\s/.test(pin))
      ? "At least 4 characters, no spaces."
      : repeat.length > 0 && repeat !== pin
        ? "The two PINs differ."
        : "";
  const canSubmit = pin.length >= 4 && !/\s/.test(pin) && pin === repeat && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      await completeSetup(pin, start);
      onDone(pin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
      setBusy(false);
    }
  }

  const exampleRoles = publicData.roles.map((r) => r.name).join(", ");
  const exampleRooms = publicData.rooms.map((r) => r.name).join(", ");

  return (
    <div className="root login">
      <div className="login-card panel">
        <div className="login-card-head">
          <h1>Welcome to kesher</h1>
          <p className="variant-subtitle">Set up this server (takes a minute, only once)</p>
        </div>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            <span className="login-label-text">Admin PIN</span>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Choose a PIN for the admin area"
              autoComplete="new-password"
              autoFocus
            />
          </label>
          <label>
            <span className="login-label-text">Repeat the PIN</span>
            <input
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {pinProblem ? <p className="login-error">{pinProblem}</p> : null}

          <fieldset className="setup-start">
            <legend className="login-label-text">Start with</legend>
            <label className="setup-option">
              <input type="radio" name="start" checked={start === "example"} onChange={() => setStart("example")} />
              <span>
                <strong>Example setup</strong> (recommended)
                <small>
                  Roles: {exampleRoles || "–"}. Party lines: {exampleRooms || "–"}. Rename or delete them later in the
                  admin area.
                </small>
              </span>
            </label>
            <label className="setup-option">
              <input type="radio" name="start" checked={start === "empty"} onChange={() => setStart("empty")} />
              <span>
                <strong>Empty</strong>
                <small>No roles or party lines; create your own in the admin area before anyone can join.</small>
              </span>
            </label>
          </fieldset>

          <button className="primary" type="submit" disabled={!canSubmit}>
            {busy ? "Setting up…" : "Finish setup"}
          </button>
          {error ? <p className="login-error">{error}</p> : null}
          <p className="login-admin-note">
            Afterwards the admin area opens. Desktop apps and Raspberry Pi stations in this network find the server
            by themselves; new stations appear under Stations for approval.
          </p>
        </form>
      </div>
    </div>
  );
}
