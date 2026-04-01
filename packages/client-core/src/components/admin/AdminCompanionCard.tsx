import { useEffect, useMemo, useState } from "react";
import {
  buildAbsoluteApiUrl,
  getCompanionAdminSummary,
  publishCompanionProfile,
} from "../../api";
import type {
  Bootstrap,
  CompanionAdminSummary,
  CompanionPublishedProfileSummary,
} from "../../types";

type AdminCompanionCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
};

function buildPublishedProfileMap(
  publishedProfiles: CompanionPublishedProfileSummary[],
): Map<string, CompanionPublishedProfileSummary> {
  return new Map(publishedProfiles.map((profile) => [profile.roleId, profile]));
}

function resolveModulePort(protocol: string, port: string): string {
  if (port) return port;
  return protocol === "https:" ? "443" : "80";
}

export function AdminCompanionCard({
  token,
  adminPin,
  appData,
}: AdminCompanionCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [copiedField, setCopiedField] = useState("");
  const [summary, setSummary] = useState<CompanionAdminSummary | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState(
    () => appData.self.roleId || appData.roles[0]?.id || "",
  );

  useEffect(() => {
    if (!selectedRoleId && appData.roles.length > 0) {
      setSelectedRoleId(appData.self.roleId || appData.roles[0]?.id || "");
    }
  }, [appData.roles, appData.self.roleId, selectedRoleId]);

  async function refreshSummary() {
    setLoading(true);
    setError("");
    try {
      const next = await getCompanionAdminSummary(token, adminPin);
      setSummary(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load companion config");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    void refreshSummary();
  }, [isOpen]);

  const publishedProfiles = summary?.publishedProfiles || [];
  const publishedByRoleId = useMemo(
    () => buildPublishedProfileMap(publishedProfiles),
    [publishedProfiles],
  );
  const selectedPublishedProfile = selectedRoleId
    ? publishedByRoleId.get(selectedRoleId)
    : undefined;
  const backendOrigin = useMemo(() => {
    const discovery = buildAbsoluteApiUrl("/api/companion/discovery");
    return new URL(discovery).origin;
  }, []);
  const backendUrl = useMemo(() => new URL(backendOrigin), [backendOrigin]);
  const locationProtocol = backendUrl.protocol;
  const locationHost = backendUrl.hostname;
  const locationPort = resolveModulePort(locationProtocol, backendUrl.port);
  const useTls = locationProtocol === "https:";
  const minimalModeAvailable = publishedProfiles.length === 1;
  const effectiveRoleId = minimalModeAvailable ? "" : selectedRoleId;
  const discoveryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (effectiveRoleId) params.set("roleId", effectiveRoleId);
    if (summary?.sharedSecret) params.set("secret", summary.sharedSecret);
    const base = `${backendOrigin}/api/companion/discovery`;
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }, [backendOrigin, effectiveRoleId, summary?.sharedSecret]);

  const profileUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (effectiveRoleId) params.set("roleId", effectiveRoleId);
    if (summary?.sharedSecret) params.set("secret", summary.sharedSecret);
    const base = `${backendOrigin}/api/companion/profile`;
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }, [backendOrigin, effectiveRoleId, summary?.sharedSecret]);

  const moduleConfigText = useMemo(() => {
    return [
      `Host: ${locationHost}`,
      `Port: ${locationPort}`,
      `Use TLS: ${useTls ? "yes" : "no"}`,
      `Companion shared secret: ${summary?.sharedSecret || ""}`,
      `Role ID: ${effectiveRoleId || "<leave empty for auto>"}`,
      `Discovery URL: ${discoveryUrl}`,
      `Profile URL: ${profileUrl}`,
    ].join("\n");
  }, [discoveryUrl, effectiveRoleId, locationHost, locationPort, profileUrl, summary?.sharedSecret, useTls]);

  async function handlePublish() {
    if (!selectedRoleId) return;
    setPublishing(true);
    setError("");
    setMessage("");
    try {
      const published = await publishCompanionProfile(token, adminPin, selectedRoleId);
      await refreshSummary();
      setMessage(
        `Published ${published.roleId} as version ${published.profileVersion}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to publish companion profile");
    } finally {
      setPublishing(false);
    }
  }

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      window.setTimeout(() => {
        setCopiedField((current) => (current === label ? "" : current));
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "copy to clipboard failed");
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Integration · Companion</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((value) => !value)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Publish profile</h4>
            </div>
            <p>
              Publish a role profile for the Companion module and expose the exact
              connection values needed on the Companion side.
            </p>
            <div className="admin-grid">
              <select
                aria-label="Companion target role"
                value={selectedRoleId}
                onChange={(event) => setSelectedRoleId(event.target.value)}
                disabled={publishing || loading}
              >
                <option value="">Select role…</option>
                {appData.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
              <button
                type="button"
                onClick={() => void handlePublish()}
                disabled={!selectedRoleId || publishing || loading}
              >
                {publishing ? "Publishing…" : "Publish to Companion"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void refreshSummary()}
                disabled={publishing || loading}
              >
                {loading ? "Refreshing…" : "Refresh status"}
              </button>
            </div>
            {message ? <p>{message}</p> : null}
            {error ? <p className="admin-error">{error}</p> : null}
          </div>

          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Module config</h4>
            </div>
            <p>
              Use these values in the Kesher Companion module. When exactly one
              profile is published, the module can run in auto-target mode.
            </p>
            <div className="admin-grid">
              <label>
                <span>Host</span>
                <input readOnly value={locationHost} />
              </label>
              <label>
                <span>Port</span>
                <input readOnly value={locationPort} />
              </label>
              <label>
                <span>Use TLS</span>
                <input readOnly value={useTls ? "true" : "false"} />
              </label>
              <label>
                <span>Shared secret</span>
                <input readOnly value={summary?.sharedSecret || ""} />
              </label>
              <label>
                <span>Role ID</span>
                <input
                  readOnly
                  value={effectiveRoleId || "auto (leave empty in Companion)"}
                />
              </label>
              <label>
                <span>Mode</span>
                <input
                  readOnly
                  value={minimalModeAvailable ? "auto-target" : "explicit role"}
                />
              </label>
            </div>
            <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => void copyValue("module", moduleConfigText)}
              >
                {copiedField === "module" ? "Copied" : "Copy module config"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void copyValue("discovery", discoveryUrl)}
              >
                {copiedField === "discovery" ? "Copied" : "Copy discovery URL"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void copyValue("profile", profileUrl)}
              >
                {copiedField === "profile" ? "Copied" : "Copy profile URL"}
              </button>
            </div>
          </div>

          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Published profiles ({publishedProfiles.length})</h4>
            </div>
            {publishedProfiles.length === 0 ? (
              <p>No Companion profile has been published yet.</p>
            ) : (
              <ul className="admin-list">
                {appData.roles.map((role) => {
                  const profile = publishedByRoleId.get(role.id);
                  return (
                    <li key={role.id}>
                      <strong>{role.name}</strong> ({role.id})
                      {profile
                        ? ` · v${profile.profileVersion} · ${profile.profileStatus}${profile.profileUpdatedAt ? ` · ${new Date(profile.profileUpdatedAt).toLocaleString()}` : ""}`
                        : " · unpublished"}
                    </li>
                  );
                })}
              </ul>
            )}
            {selectedPublishedProfile ? (
              <p>
                Selected role {selectedPublishedProfile.roleId} is currently on
                version {selectedPublishedProfile.profileVersion}.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}