// Shared tab vocabulary for the merged Upgrader surface (/upgrader).
// Imported by both the server page (to parse `?tab=`) and the client tab nav.
// Dependency-free so it serializes across the RSC boundary.

export const UPGRADER_TABS = ["catalog", "transactions"] as const;

export type UpgraderTab = (typeof UPGRADER_TABS)[number];

/**
 * Parse an untrusted `?tab=` value to a known tab, defaulting to "catalog".
 * The "transactions" tab is gated by its own page key
 * (`/transactions/upgrader`) — this parser only normalizes the string; the
 * page enforces `requirePageAccess` before mounting the tab, so resolving to
 * "transactions" here for a user without that grant is harmless (the page
 * redirects them).
 */
export function parseUpgraderTab(value: string | undefined): UpgraderTab {
  return (UPGRADER_TABS as readonly string[]).includes(value ?? "")
    ? (value as UpgraderTab)
    : "catalog";
}
