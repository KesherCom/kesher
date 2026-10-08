import { useState, type ReactNode } from "react";
import type { Bootstrap } from "../../types";
import { AdminCardDefaultOpenContext } from "./adminCardOpen";
import { AdminChannelsCard } from "./AdminChannelsCard";
import { AdminChatHistoryCard } from "./AdminChatHistoryCard";
import { AdminCompanionCard } from "./AdminCompanionCard";
import { AdminCompanionPageConfigCard } from "./AdminCompanionPageConfigCard";
import { AdminDevicesCard } from "./AdminDevicesCard";
import { AdminLiveOverview } from "./AdminLiveOverview";
import { AdminLogsCard } from "./AdminLogsCard";
import { AdminMonitoringCard } from "./AdminMonitoringCard";
import { AdminPinCard } from "./AdminPinCard";
import { AdminRolesCard } from "./AdminRolesCard";
import { AdminRoomsCard } from "./AdminRoomsCard";
import { AdminRoutingMatrixCard } from "./AdminRoutingMatrixCard";
import { AdminShowfileCard } from "./AdminShowfileCard";
import { AdminStreamDeckCard } from "./AdminStreamDeckCard";
import { AdminStreamDecksCard } from "./AdminStreamDecksCard";
import { AdminTelegramCard } from "./AdminTelegramCard";
import { AdminTelegramUsersCard } from "./AdminTelegramUsersCard";
import { AdminUsersCard } from "./AdminUsersCard";
import { useAdminLiveData } from "./useAdminLiveData";

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

export type AdminSection = "live" | "setup" | "devices" | "system";

const sections: { id: AdminSection; label: string; hint: string }[] = [
  { id: "live", label: "Live", hint: "Who is online, what needs attention" },
  { id: "setup", label: "Setup", hint: "Roles, party lines, who talks and hears where" },
  { id: "devices", label: "Devices", hint: "Stations, Stream Decks, Companion" },
  { id: "system", label: "System", hint: "Backup, admin PIN, Telegram, logs" },
];

const sectionStorageKey = "kesher-admin-section";

function loadSection(): AdminSection {
  try {
    const stored = localStorage.getItem(sectionStorageKey);
    if (sections.some((s) => s.id === stored)) return stored as AdminSection;
  } catch {
    // No storage: start on Live.
  }
  return "live";
}

/**
 * Admin console: a navigation with four sections instead of one long list.
 * Live is the start page; cards in a section start expanded.
 */
export function AdminMenu(props: AdminMenuProps) {
  if (!props.token) return null;
  return <AdminConsole {...props} token={props.token} />;
}

function AdminConsole({
  token,
  appData,
  refreshBootstrapData,
  adminPin,
  onUpdateAdminPin,
  audioStats,
  activeRoutesCount,
}: AdminMenuProps & { token: string }) {
  const [section, setSectionState] = useState<AdminSection>(loadSection);
  const { data: live, reload } = useAdminLiveData(token, adminPin);

  function setSection(next: AdminSection) {
    setSectionState(next);
    try {
      localStorage.setItem(sectionStorageKey, next);
    } catch {
      // Not remembered; fine.
    }
  }

  const badges: Partial<Record<AdminSection, number>> = {
    devices:
      live.devices.filter((d) => d.status === "pending").length +
      live.decks.filter((d) => !d.placeId).length,
  };
  const common = { token, adminPin, appData, refreshBootstrapData };

  let content: ReactNode;
  switch (section) {
    case "live":
      content = (
        <>
          <AdminLiveOverview
            token={token}
            adminPin={adminPin}
            appData={appData}
            live={live}
            reload={reload}
            onNavigate={setSection}
          />
          <AdminCardDefaultOpenContext.Provider value={false}>
            <AdminMonitoringCard
              token={token}
              adminPin={adminPin}
              audioStats={audioStats}
              activeRoutesCount={activeRoutesCount}
            />
          </AdminCardDefaultOpenContext.Provider>
        </>
      );
      break;
    case "setup":
      content = (
        <>
          <AdminRoutingMatrixCard {...common} />
          <AdminRoomsCard {...common} />
          <AdminRolesCard {...common} />
          <AdminChannelsCard {...common} />
          <AdminUsersCard {...common} />
        </>
      );
      break;
    case "devices":
      content = (
        <>
          <AdminDevicesCard token={token} adminPin={adminPin} appData={appData} />
          <AdminStreamDecksCard token={token} adminPin={adminPin} appData={appData} />
          <div className="admin-subsection">
            <h3>Older Companion setup</h3>
            <p>
              Companion connections with a role ID instead of a Stream Deck name. New setups use one connection per
              Stream Deck (above).
            </p>
          </div>
          <AdminCardDefaultOpenContext.Provider value={false}>
            <AdminCompanionCard token={token} adminPin={adminPin} appData={appData} />
            <AdminStreamDeckCard token={token} adminPin={adminPin} appData={appData} />
            <AdminCompanionPageConfigCard token={token} adminPin={adminPin} appData={appData} />
          </AdminCardDefaultOpenContext.Provider>
        </>
      );
      break;
    case "system":
      content = (
        <>
          <AdminShowfileCard token={token} adminPin={adminPin} refreshBootstrapData={refreshBootstrapData} />
          <AdminPinCard onUpdateAdminPin={onUpdateAdminPin} />
          <AdminCardDefaultOpenContext.Provider value={false}>
            <AdminTelegramCard token={token} adminPin={adminPin} appData={appData} />
            <AdminTelegramUsersCard token={token} adminPin={adminPin} />
            <AdminLogsCard token={token} adminPin={adminPin} />
            <AdminChatHistoryCard {...common} />
          </AdminCardDefaultOpenContext.Provider>
        </>
      );
      break;
  }

  const current = sections.find((s) => s.id === section) ?? sections[0];

  return (
    <div className="admin-stack admin-console">
      <nav className="admin-nav" aria-label="Admin sections">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`admin-nav-item ${s.id === section ? "active" : ""}`}
            aria-current={s.id === section ? "page" : undefined}
            onClick={() => setSection(s.id)}
          >
            <span className="admin-nav-label">
              {s.label}
              {badges[s.id] ? <span className="admin-device-badge">{badges[s.id]}</span> : null}
            </span>
            <span className="admin-nav-hint">{s.hint}</span>
          </button>
        ))}
      </nav>
      <main className="admin-section" aria-label={current.label}>
        <div className="admin-layout-intro">
          <h2>{current.label}</h2>
          <p>{current.hint}</p>
        </div>
        <AdminCardDefaultOpenContext.Provider value={true}>
          <div className="admin-section-cards">{content}</div>
        </AdminCardDefaultOpenContext.Provider>
      </main>
    </div>
  );
}
