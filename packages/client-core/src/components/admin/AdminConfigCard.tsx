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
import { AdminCompanionCard } from "./AdminCompanionCard";
import { AdminCompanionPageConfigCard } from "./AdminCompanionPageConfigCard";
import { AdminStreamDeckCard } from "./AdminStreamDeckCard";
import { AdminLogsCard } from "./AdminLogsCard";

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

        <AdminUsersCard
          token={token}
          adminPin={adminPin}
          appData={appData}
          refreshBootstrapData={refreshBootstrapData}
        />

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
          <p>Companion publish flow, Telegram bot mapping and access control.</p>
        </div>

        <AdminCompanionCard token={token} adminPin={adminPin} appData={appData} />

        <AdminStreamDeckCard token={token} adminPin={adminPin} appData={appData} />

        <AdminCompanionPageConfigCard token={token} adminPin={adminPin} appData={appData} />

        <AdminTelegramCard token={token} adminPin={adminPin} appData={appData} />

        <AdminTelegramUsersCard token={token} adminPin={adminPin} />
      </section>

      <section className="admin-theme-group" aria-label="Realtime behavior and diagnostics">
        <div className="admin-theme-group-head">
          <h3>Runtime</h3>
          <p>Communication housekeeping and operational cleanup.</p>
        </div>

        <AdminLogsCard token={token} adminPin={adminPin} />

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
