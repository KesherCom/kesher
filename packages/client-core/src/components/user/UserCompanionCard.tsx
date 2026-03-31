import { useCallback, useState } from "react";
import { publishUserCompanionProfile } from "../../api";
import type { CompanionProfileResponse } from "../../types";

type UserCompanionCardProps = {
  token: string;
  username: string;
  roleId: string;
};

export function UserCompanionCard({
  token,
  username,
  roleId,
}: UserCompanionCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [published, setPublished] = useState<CompanionProfileResponse | null>(
    null
  );

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    setError("");
    setMessage("");
    try {
      const result = await publishUserCompanionProfile(token);
      setPublished(result);
      setMessage(
        `Published ${result.roleId} as version ${result.profileVersion}`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to publish profile"
      );
    } finally {
      setPublishing(false);
    }
  }, [token]);

  return (
    <div className="card">
      <div
        className="card-header"
        style={{ cursor: "pointer" }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <h3 style={{ margin: 0 }}>
          Companion Profile Publishing {isOpen ? "▼" : "▶"}
        </h3>
      </div>
      {isOpen && (
        <div className="card-content">
          {error && <div className="error-message">{error}</div>}
          {message && <div className="success-message">{message}</div>}

          <div style={{ marginBottom: "1rem" }}>
            <p>
              <strong>Your Role:</strong> {roleId}
            </p>
            <p>
              Click the button below to publish your Companion profile to the
              Streamdeck.
            </p>
          </div>

          <button
            onClick={handlePublish}
            disabled={publishing}
            className="button"
            style={{
              backgroundColor: publishing ? "#ccc" : "#4CAF50",
              color: "white",
              padding: "10px 20px",
              border: "none",
              borderRadius: "4px",
              cursor: publishing ? "not-allowed" : "pointer",
              marginBottom: "1rem",
            }}
          >
            {publishing ? "Publishing..." : "Publish My Profile"}
          </button>

          {published && (
            <div style={{ marginTop: "1rem" }}>
              <h4>Publication Details:</h4>
              <ul style={{ lineHeight: "1.8" }}>
                <li>
                  <strong>Role ID:</strong> {published.roleId}
                </li>
                <li>
                  <strong>Username:</strong> {published.username}
                </li>
                <li>
                  <strong>Version:</strong> {published.profileVersion}
                </li>
                <li>
                  <strong>Status:</strong> {published.profileStatus}
                </li>
                {published.profileUpdatedAt && (
                  <li>
                    <strong>Updated:</strong>{" "}
                    {new Date(published.profileUpdatedAt).toLocaleString()}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
