import React from "react";
import type { Bootstrap } from "../../types";
import { AdminConfigCard } from "./AdminConfigCard";
import { AdminPinCard } from "./AdminPinCard";
import { AdminMonitoringCard } from "./AdminMonitoringCard";

type AdminMenuProps = {
  isOpen: boolean;
  setIsOpen: (value: boolean) => void;
  token: string | null;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  adminPin: string;
  onUpdateAdminPin: (currentPin: string, newPin: string) => Promise<void>;
  audioStats: { inKbps: number; outKbps: number };
  activeRoutesCount: number;
};

export function AdminMenu({
  isOpen,
  setIsOpen,
  token,
  appData,
  refreshBootstrapData,
  adminPin,
  onUpdateAdminPin,
  audioStats,
  activeRoutesCount,
}: AdminMenuProps) {
  if (!token) return null;

  return (
    <div className="admin-stack">
      <AdminConfigCard
        token={token}
        adminPin={adminPin}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />

      <AdminPinCard onUpdateAdminPin={onUpdateAdminPin} />

      <AdminMonitoringCard
        token={token}
        audioStats={audioStats}
        activeRoutesCount={activeRoutesCount}
      />
    </div>
  );
}
