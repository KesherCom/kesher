import { useState } from "react";
import type { Bootstrap } from "../../types";
import { UsersPanel } from "./UsersPanel";

type AdminUsersCardProps = {
  appData: Bootstrap;
};

export function AdminUsersCard({ appData }: AdminUsersCardProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Configuration · Users</div>
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
          <UsersPanel appData={appData} />
        </div>
      ) : null}
    </div>
  );
}
