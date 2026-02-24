import React from "react";
import type { Bootstrap } from "../../types";
import { AdminConfigCard } from "./AdminConfigCard";
import { AdminPinCard } from "./AdminPinCard";
import { AdminMonitoringCard } from "./AdminMonitoringCard";

type AdminMenuProps = {
  token: string | null;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  adminPin: string;
  onUpdateAdminPin: (next: string) => void;
  audioStats: { inKbps: number; outKbps: number };
  activeRoutesCount: number;
};

export function AdminMenu({
  token,
  appData,
  refreshBootstrapData,
  adminPin,
  onUpdateAdminPin,
  audioStats,
  activeRoutesCount
}: AdminMenuProps) {
  if (!token) return null;
  
  return (
    <div className="admin-stack">
      <AdminConfigCard
        token={token}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
      
      <AdminPinCard
        adminPin={adminPin}
        onUpdateAdminPin={onUpdateAdminPin}
      />
      
      <AdminMonitoringCard
        audioStats={audioStats}
        activeRoutesCount={activeRoutesCount}
      />
    </div>
  );
}
