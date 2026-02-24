import React from "react";

type AdminPinCardProps = {
  adminPin: string;
  onUpdateAdminPin: (next: string) => void;
};

export function AdminPinCard({
  adminPin,
  onUpdateAdminPin
}: AdminPinCardProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [pinCurrentInput, setPinCurrentInput] = React.useState("");
  const [pinNewInput, setPinNewInput] = React.useState("");
  const [pinConfirmInput, setPinConfirmInput] = React.useState("");
  const [pinMessage, setPinMessage] = React.useState("");

  const handleUpdatePin = () => {
    setPinMessage("");
    if (pinCurrentInput.trim() !== adminPin) {
      setPinMessage("Current PIN is incorrect.");
      return;
    }
    if (!pinNewInput.trim()) {
      setPinMessage("New PIN cannot be empty.");
      return;
    }
    if (pinNewInput !== pinConfirmInput) {
      setPinMessage("New PIN and confirmation do not match.");
      return;
    }
    try {
      onUpdateAdminPin(pinNewInput.trim());
      setPinMessage("Admin PIN updated successfully.");
      setPinCurrentInput("");
      setPinNewInput("");
      setPinConfirmInput("");
    } catch (err) {
      setPinMessage("Failed to update PIN.");
    }
  };

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Security · Admin PIN</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Verbergen" : "Anzeigen"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-grid">
            <input
              type="password"
              value={pinCurrentInput}
              onChange={(e) => setPinCurrentInput(e.target.value)}
              placeholder="Current PIN"
            />
            <input
              type="password"
              value={pinNewInput}
              onChange={(e) => setPinNewInput(e.target.value)}
              placeholder="New PIN"
            />
            <input
              type="password"
              value={pinConfirmInput}
              onChange={(e) => setPinConfirmInput(e.target.value)}
              placeholder="Confirm new PIN"
            />
          </div>
          <div className="admin-form-actions">
            <button
              onClick={handleUpdatePin}
              className="secondary"
            >
              Update PIN
            </button>
            {pinMessage ? <div className="admin-pin-note">{pinMessage}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
