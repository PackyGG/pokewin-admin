// Shared tab vocabulary for the merged Admins & Access surface (/admin-users).
// Imported by both the server page (to parse `?tab=`) and the client tab nav.
// Dependency-free so it serializes across the RSC boundary.

export const ADMINS_ACCESS_TABS = ["admins", "roles"] as const;

export type AdminsAccessTab = (typeof ADMINS_ACCESS_TABS)[number];

/**
 * Parse an untrusted `?tab=` value to a known tab, defaulting to "admins".
 * Note: the "roles" tab is ADMIN-ONLY — this parser only normalizes the
 * string; the Roles segment enforces `requireAdmin()` itself, so resolving to
 * "roles" here for a non-admin is harmless (the segment redirects them).
 */
export function parseAdminsAccessTab(value: string | undefined): AdminsAccessTab {
  return (ADMINS_ACCESS_TABS as readonly string[]).includes(value ?? "")
    ? (value as AdminsAccessTab)
    : "admins";
}
