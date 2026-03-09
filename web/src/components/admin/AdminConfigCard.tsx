import type { Bootstrap } from "../../types";
import { AdminRolesCard } from "./AdminRolesCard";
import { AdminRoomsCard } from "./AdminRoomsCard";
import { AdminChannelsCard } from "./AdminChannelsCard";
import { AdminUsersCard } from "./AdminUsersCard";
import { AdminTelegramCard } from "./AdminTelegramCard";
import { AdminRoutingMatrixCard } from "./AdminRoutingMatrixCard";
import { AdminChatHistoryCard } from "./AdminChatHistoryCard";

type AdminConfigCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminConfigCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminConfigCardProps) {
  return (
    <>
      <AdminRolesCard
        token={token}
        adminPin={adminPin}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />

      <AdminUsersCard appData={appData} />

      <AdminRoomsCard
        token={token}
        adminPin={adminPin}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />

      <AdminChannelsCard
        token={token}
        adminPin={adminPin}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
      <AdminTelegramCard token={token} adminPin={adminPin} appData={appData} />

      <AdminChatHistoryCard token={token} adminPin={adminPin} />

      <AdminRoutingMatrixCard
        token={token}
        adminPin={adminPin}
        appData={appData}
        refreshBootstrapData={refreshBootstrapData}
      />
    </>
  );
}
