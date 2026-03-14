import type { Bootstrap } from "../../types";
import { AdminRolesCard } from "./AdminRolesCard";
import { AdminRoomsCard } from "./AdminRoomsCard";
import { AdminChannelsCard } from "./AdminChannelsCard";
import { AdminUsersCard } from "./AdminUsersCard";
import { AdminTelegramCard } from "./AdminTelegramCard";
import { AdminTelegramUsersCard } from "./AdminTelegramUsersCard";
import { AdminRoutingMatrixCard } from "./AdminRoutingMatrixCard";
import { AdminChatHistoryCard } from "./AdminChatHistoryCard";
import { AdminShowfileCard } from "./AdminShowfileCard";

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
    <div className="admin-theme-groups">
      <section className="admin-theme-group" aria-label="Showfile management">
        <div className="admin-theme-group-head">
          <h3>Showfile</h3>
          <p>Import and export complete configuration snapshots.</p>
        </div>

        <AdminShowfileCard
          token={token}
          adminPin={adminPin}
          refreshBootstrapData={refreshBootstrapData}
        />
      </section>

      <section className="admin-theme-group" aria-label="Configuration structure and routing">
        <div className="admin-theme-group-head">
          <h3>Configuration</h3>
          <p>Core intercom structure and routing behavior.</p>
        </div>

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

        <AdminRoutingMatrixCard
          token={token}
          adminPin={adminPin}
          appData={appData}
          refreshBootstrapData={refreshBootstrapData}
        />
      </section>

      <section className="admin-theme-group" aria-label="External integrations">
        <div className="admin-theme-group-head">
          <h3>Integrations</h3>
          <p>Telegram bot mapping and access control.</p>
        </div>

        <AdminTelegramCard token={token} adminPin={adminPin} appData={appData} />

        <AdminTelegramUsersCard token={token} adminPin={adminPin} />
      </section>

      <section className="admin-theme-group" aria-label="Realtime behavior and diagnostics">
        <div className="admin-theme-group-head">
          <h3>Runtime</h3>
          <p>Communication housekeeping and operational cleanup.</p>
        </div>

        <AdminChatHistoryCard
          token={token}
          adminPin={adminPin}
          appData={appData}
          refreshBootstrapData={refreshBootstrapData}
        />
      </section>
    </div>
  );
}
