import React from "react";

type AdminMonitoringCardProps = {
  audioStats: { inKbps: number; outKbps: number };
  activeRoutesCount: number;
};

export function AdminMonitoringCard({
  audioStats,
  activeRoutesCount
}: AdminMonitoringCardProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Monitoring · Audio / RTP</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Verbergen" : "Anzeigen"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body admin-metrics">
          <div className="admin-metric">
            <div className="admin-metric-label">Inbound</div>
            <div className="admin-metric-value">{audioStats.inKbps} kbps</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Outbound</div>
            <div className="admin-metric-value">{audioStats.outKbps} kbps</div>
          </div>
          <div className="admin-metric">
            <div className="admin-metric-label">Active routes</div>
            <div className="admin-metric-value">{activeRoutesCount}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
