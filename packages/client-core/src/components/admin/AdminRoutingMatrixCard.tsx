import { useCallback, useMemo, useState } from "react";
import type { Bootstrap, Room, Role } from "../../types";
import { updateRoutingMatrix, type RoutingMatrixEntry } from "../../api";
import { Icon } from "../Icon";

type AdminRoutingMatrixCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

type CellState = { talk: boolean; listen: boolean; forced: boolean };

/**
 * One click per cell steps through the useful combinations. Being allowed to
 * hear a party line does not mean hearing it all the time: the station
 * switches listening on and off. Only "always" (forced listen) keeps it on.
 */
const cellCycle: CellState[] = [
  { talk: false, listen: false, forced: false },
  { talk: false, listen: true, forced: false },
  { talk: false, listen: true, forced: true },
  { talk: true, listen: true, forced: false },
  { talk: true, listen: true, forced: true },
];

function cellKey(cell: CellState): string {
  return `${cell.talk ? 1 : 0}${cell.listen ? 1 : 0}${cell.forced ? 1 : 0}`;
}

function nextCell(cell: CellState): CellState {
  const index = cellCycle.findIndex((c) => cellKey(c) === cellKey(cell));
  // Unusual combinations (e.g. talk without listening) go back to "none".
  return index < 0 ? cellCycle[0] : cellCycle[(index + 1) % cellCycle.length];
}

type CellView = {
  talk: boolean;
  hear: "no" | "can" | "always";
  long: string;
};

const hearingWords = {
  no: "cannot hear",
  can: "can switch listening on",
  always: "always hears",
} as const;

function describeCell(cell: CellState): CellView {
  const hear = !cell.listen ? "no" : cell.forced ? "always" : "can";
  const long = cell.talk
    ? `can talk, ${hearingWords[hear]}`
    : hear === "no"
      ? "no access"
      : hearingWords[hear];
  return { talk: cell.talk, hear, long };
}

function CellContent({ view }: { view: CellView }) {
  if (!view.talk && view.hear === "no") return <>–</>;
  return (
    <>
      {view.talk ? (
        <span className="routing-matrix-part talk">
          <Icon name="mic" size={14} />
          Talk
        </span>
      ) : null}
      {view.hear !== "no" ? (
        <span className={`routing-matrix-part hear ${view.hear}`}>
          <Icon
            name={view.hear === "always" ? "lock" : "headphones"}
            size={14}
          />
          {view.hear === "always" ? "Always" : "Hear"}
        </span>
      ) : null}
    </>
  );
}

/** Build a map of roleId → roomId → { talk, listen, forced } from the current bootstrap data. */
function buildMatrix(
  roles: Role[],
  rooms: Room[],
): Record<string, Record<string, CellState>> {
  const matrix: Record<string, Record<string, CellState>> = {};
  for (const role of roles) {
    matrix[role.id] = {};
    for (const room of rooms) {
      matrix[role.id][room.id] = {
        talk: (room.senderRoleIds ?? []).includes(role.id),
        listen: (room.receiverRoleIds ?? []).includes(role.id),
        forced: (room.forcedListenRoleIds ?? []).includes(role.id),
      };
    }
  }
  return matrix;
}

/** Convert local matrix state back to per-room entries suitable for the API. */
function matrixToEntries(
  matrix: Record<string, Record<string, CellState>>,
  roles: Role[],
  rooms: Room[],
): RoutingMatrixEntry[] {
  return rooms.map((room) => {
    const senderRoleIds: string[] = [];
    const receiverRoleIds: string[] = [];
    const forcedListenRoleIds: string[] = [];
    for (const role of roles) {
      const cell = matrix[role.id]?.[room.id];
      if (cell?.talk) senderRoleIds.push(role.id);
      if (cell?.listen) receiverRoleIds.push(role.id);
      if (cell?.forced) forcedListenRoleIds.push(role.id);
    }
    return {
      roomId: room.id,
      senderRoleIds,
      receiverRoleIds,
      forcedListenRoleIds,
    };
  });
}

export function AdminRoutingMatrixCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminRoutingMatrixCardProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  // Local working copy of the matrix (editable before saving)
  const serverMatrix = useMemo(
    () => buildMatrix(appData.roles, appData.rooms),
    [appData.roles, appData.rooms],
  );
  const [localMatrix, setLocalMatrix] = useState<
    Record<string, Record<string, CellState>>
  >(() => buildMatrix(appData.roles, appData.rooms));

  // Re-sync local matrix when server data changes (e.g. after save)
  const [prevRooms, setPrevRooms] = useState(appData.rooms);
  const [prevRoles, setPrevRoles] = useState(appData.roles);
  if (appData.rooms !== prevRooms || appData.roles !== prevRoles) {
    setPrevRooms(appData.rooms);
    setPrevRoles(appData.roles);
    setLocalMatrix(buildMatrix(appData.roles, appData.rooms));
  }

  const isDirty = useMemo(() => {
    for (const role of appData.roles) {
      for (const room of appData.rooms) {
        const local = localMatrix[role.id]?.[room.id];
        const server = serverMatrix[role.id]?.[room.id];
        if (!local || !server) continue;
        if (
          local.talk !== server.talk ||
          local.listen !== server.listen ||
          local.forced !== server.forced
        )
          return true;
      }
    }
    return false;
  }, [localMatrix, serverMatrix, appData.roles, appData.rooms]);

  const cycleCell = useCallback((roleId: string, roomId: string) => {
    setLocalMatrix((prev) => {
      const next = { ...prev };
      next[roleId] = { ...next[roleId] };
      next[roleId][roomId] = nextCell(next[roleId][roomId]);
      return next;
    });
  }, []);

  const resetMatrix = useCallback(() => {
    setLocalMatrix(buildMatrix(appData.roles, appData.rooms));
  }, [appData.roles, appData.rooms]);

  async function saveMatrix() {
    setAdminBusy(true);
    setAdminError("");
    try {
      const entries = matrixToEntries(
        localMatrix,
        appData.roles,
        appData.rooms,
      );
      await updateRoutingMatrix(token, adminPin, entries);
      await refreshBootstrapData();
    } catch (error) {
      setAdminError(
        error instanceof Error ? error.message : "failed to save matrix",
      );
    } finally {
      setAdminBusy(false);
    }
  }

  if (appData.roles.length === 0 || appData.rooms.length === 0) {
    return null;
  }

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Who talks and hears where</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          {adminError ? <p className="admin-error">{adminError}</p> : null}

          <p className="routing-matrix-hint">
            Click a cell to step through: – no access → <strong>Hear</strong> →{" "}
            <strong>Always</strong> → <strong>Talk + Hear</strong> →{" "}
            <strong>Talk + Always</strong>. <strong>Hear</strong> means the
            station may listen and switches it on or off itself;{" "}
            <strong>Always</strong> keeps listening on. Changes apply after
            Save.
          </p>

          <div className="routing-matrix-wrapper">
            <table className="routing-matrix" role="grid">
              <thead>
                <tr>
                  <th className="routing-matrix-corner">Role ╲ Party Line</th>
                  {appData.rooms.map((room) => (
                    <th key={room.id} className="routing-matrix-col-header">
                      {room.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {appData.roles.map((role) => (
                  <tr key={role.id}>
                    <th className="routing-matrix-row-header">{role.name}</th>
                    {appData.rooms.map((room) => {
                      const cell = localMatrix[role.id]?.[room.id] ?? {
                        talk: false,
                        listen: false,
                        forced: false,
                      };
                      const shown = describeCell(cell);
                      const changed =
                        cellKey(cell) !==
                        cellKey(
                          serverMatrix[role.id]?.[room.id] ?? {
                            talk: false,
                            listen: false,
                            forced: false,
                          },
                        );
                      return (
                        <td key={room.id} className="routing-matrix-cell">
                          <button
                            type="button"
                            className={`routing-matrix-state${changed ? " changed" : ""}`}
                            onClick={() => cycleCell(role.id, room.id)}
                            disabled={adminBusy}
                            aria-label={`${role.name} on ${room.name}: ${shown.long}`}
                            title={`${role.name} on ${room.name}: ${shown.long} (click to change)`}
                          >
                            <CellContent view={shown} />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="routing-matrix-legend">
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-part talk">
                <Icon name="mic" size={14} />
                Talk
              </span>
              may talk
            </span>
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-part hear can">
                <Icon name="headphones" size={14} />
                Hear
              </span>
              may listen, switched at the station
            </span>
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-part hear always">
                <Icon name="lock" size={14} />
                Always
              </span>
              always listening, cannot be switched off
            </span>
          </div>

          {isDirty ? (
            <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
              <button
                onClick={() => void saveMatrix()}
                disabled={adminBusy}
                className="primary"
              >
                {adminBusy ? "Saving…" : "Save changes"}
              </button>
              <button
                onClick={resetMatrix}
                disabled={adminBusy}
                className="secondary"
              >
                Discard
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
