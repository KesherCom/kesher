import type { Bootstrap } from "../../types";
import { AdminConfigCard } from "./AdminConfigCard";
import { AdminPinCard } from "./AdminPinCard";
import { AdminMonitoringCard } from "./AdminMonitoringCard";

type AdminMenuProps = {
  token: string | null;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
  adminPin: string;
  onUpdateAdminPin: (currentPin: string, newPin: string) => Promise<void>;
  audioStats: {
    inKbps: number;
    outKbps: number;
    jitterMs: number;
    roundTripMs: number;
    playoutDelayMs: number;
  };
  activeRoutesCount: number;
};

export function AdminMenu({
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
      <div className="admin-settings-layout">
        <section className="admin-settings-main" aria-label="Configuration settings">
          <div className="admin-layout-intro">
            <span className="admin-layout-eyebrow">Configuration</span>
            <h2>Core setup</h2>
            <p>
              Manage showfiles, operator roles, party lines, channels, Telegram
              mappings, users and routing.
            </p>
          </div>

          <AdminConfigCard
            token={token}
            adminPin={adminPin}
            appData={appData}
            refreshBootstrapData={refreshBootstrapData}
          />
        </section>

        <aside className="admin-settings-side" aria-label="Security and monitoring">
          <div className="admin-layout-intro admin-layout-intro-compact">
            <span className="admin-layout-eyebrow">Operations</span>
            <h2>Access and runtime</h2>
            <p>
              Keep admin access under control and monitor live system health.
            </p>
          </div>

          <AdminPinCard onUpdateAdminPin={onUpdateAdminPin} />

          <AdminMonitoringCard
            token={token}
            adminPin={adminPin}
            audioStats={audioStats}
            activeRoutesCount={activeRoutesCount}
          />
        </aside>
      </div>
    </div>
  );
}
