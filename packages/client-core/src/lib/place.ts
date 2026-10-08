/**
 * The place ID identifies this client installation (browser profile or
 * desktop app) across logins. The server binds Stream Decks to places, so a
 * deck keeps controlling whoever logs in here. See
 * docs/decisions/0006-shared-roles-and-stream-decks-per-place.md.
 */
export const placeIdStorageKey = "kesher-place-id";

let memoryPlaceId = "";

function newPlaceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getPlaceId(): string {
  try {
    const stored = localStorage.getItem(placeIdStorageKey);
    if (stored) return stored;
    const created = memoryPlaceId || newPlaceId();
    localStorage.setItem(placeIdStorageKey, created);
    return created;
  } catch {
    // No storage (private window): stable for this page load only.
    memoryPlaceId = memoryPlaceId || newPlaceId();
    return memoryPlaceId;
  }
}
