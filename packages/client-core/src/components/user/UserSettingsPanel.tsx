import { useState } from "react";
import { UserCompanionCard } from "./UserCompanionCard";

type UserSettingsPanelProps = {
  token: string;
  username: string;
  roleId: string;
};

export function UserSettingsPanel({
  token,
  username,
  roleId,
}: UserSettingsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <div
        style={{
          position: "fixed",
          bottom: "20px",
          right: "20px",
          zIndex: 999,
        }}
      >
        <button
          onClick={() => setIsOpen(!isOpen)}
          style={{
            padding: "10px 15px",
            borderRadius: "50%",
            width: "50px",
            height: "50px",
            backgroundColor: "#4CAF50",
            color: "white",
            border: "none",
            cursor: "pointer",
            fontSize: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
          title="User Settings"
        >
          ⚙️
        </button>
      </div>

      {isOpen && (
        <div
          style={{
            position: "fixed",
            right: "80px",
            bottom: "20px",
            width: "400px",
            maxHeight: "600px",
            backgroundColor: "white",
            borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 1000,
            overflow: "auto",
          }}
        >
          <UserCompanionCard token={token} username={username} roleId={roleId} />
        </div>
      )}
    </>
  );
}
