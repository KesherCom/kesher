import React from "react";
import type { Bootstrap } from "../../types";
import { AdminRolesCard } from "./AdminRolesCard";
import { AdminRoomsCard } from "./AdminRoomsCard";
import { AdminChannelsCard } from "./AdminChannelsCard";
import { AdminUsersCard } from "./AdminUsersCard";

type AdminConfigCardProps = {
  token: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminConfigCard({
  token,
  appData,
  refreshBootstrapData
}: AdminConfigCardProps) {
  return (
    <>
      <AdminRolesCard
        token={token}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
      
      <AdminUsersCard
        token={token}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
      
      <AdminRoomsCard
        token={token}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
      
      <AdminChannelsCard
        token={token}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
    </>
  );
}
