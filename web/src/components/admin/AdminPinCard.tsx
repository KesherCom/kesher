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
  const [pinMessageType, setPinMessageType] = React.useState<"success" | "error" | "">("");

  const handleUpdatePin = () => {
    setPinMessage("");
    setPinMessageType("");
    if (pinCurrentInput.trim() !== adminPin) {
      setPinMessage("Current PIN is incorrect.");
      setPinMessageType("error");
      return;
    }
    if (!pinNewInput.trim()) {
      setPinMessage("New PIN cannot be empty.");
      setPinMessageType("error");
      return;
    }
    if (pinNewInput !== pinConfirmInput) {
      setPinMessage("New PIN and confirmation do not match.");
      setPinMessageType("error");
      return;
    }
    try {
      onUpdateAdminPin(pinNewInput.trim());
      setPinMessage("✓ Admin PIN updated successfully.");
      setPinMessageType("success");
      setPinCurrentInput("");
      setPinNewInput("");
      setPinConfirmInput("");
    } catch (err) {
      setPinMessage("✗ Failed to update PIN.");
      setPinMessageType("error");
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
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-pin-form">
            <div className="admin-pin-field">
              <label htmlFor="pin-current">Current PIN</label>
              <input
                id="pin-current"
                type="password"
                value={pinCurrentInput}
                onChange={(e) => setPinCurrentInput(e.target.value)}
                placeholder="Enter current PIN"
              />
            </div>
            <div className="admin-pin-field">
              <label htmlFor="pin-new">New PIN</label>
              <input
                id="pin-new"
                type="password"
                value={pinNewInput}
                onChange={(e) => setPinNewInput(e.target.value)}
                placeholder="Enter new PIN"
              />
            </div>
            <div className="admin-pin-field">
              <label htmlFor="pin-confirm">Confirm PIN</label>
              <input
                id="pin-confirm"
                type="password"
                value={pinConfirmInput}
                onChange={(e) => setPinConfirmInput(e.target.value)}
                placeholder="Confirm new PIN"
              />
            </div>
          </div>
          <div className="admin-pin-actions">
            <button
              onClick={handleUpdatePin}
              className="primary"
            >
              Update PIN
            </button>
            {pinMessage ? (
              <div className={`admin-pin-message admin-pin-message-${pinMessageType}`}>
                {pinMessage}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
