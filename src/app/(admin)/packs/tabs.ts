// Shared tab vocabulary for the merged Packs surface (/packs).
// Imported by both the server page (to parse `?tab=`) and the client tab nav.
// Dependency-free so it serializes across the RSC boundary.

export const PACKS_TABS = ["catalog", "transactions"] as const;

export type PacksTab = (typeof PACKS_TABS)[number];

/**
 * Parse an untrusted `?tab=` value to a known tab, defaulting to "catalog".
 * Note: the "transactions" tab is gated by its own page key
 * (`/transactions/packs`) — this parser only normalizes the string; the
 * page itself enforces `requirePageAccess` before mounting the tab, so
 * resolving to "transactions" here for a user without that grant is harmless
 * (the page redirects them).
 */
export function parsePacksTab(value: string | undefined): PacksTab {
  return (PACKS_TABS as readonly string[]).includes(value ?? "")
    ? (value as PacksTab)
    : "catalog";
}
