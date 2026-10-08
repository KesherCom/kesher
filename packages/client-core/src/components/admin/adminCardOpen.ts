import { createContext, useContext } from "react";

/**
 * Whether admin cards start expanded. The admin console shows one section
 * at a time, so its cards open right away; on their own (tests, older
 * layouts) they start collapsed.
 */
export const AdminCardDefaultOpenContext = createContext(false);

export function useAdminCardDefaultOpen(): boolean {
  return useContext(AdminCardDefaultOpenContext);
}
