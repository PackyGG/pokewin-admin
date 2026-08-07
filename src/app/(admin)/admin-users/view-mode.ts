// Shared view-mode vocabulary for the Admins list (/admin-users, Admins tab).
// Two presentations of the same admin-user data:
//   • gallery — a responsive grid of admin cards (default; easier to scan).
//   • rows    — the existing TanStack-style table, unchanged.
// Dependency-free so it can be imported by both the toggle and the list
// wrapper without dragging client-only modules across boundaries.

export const ADMINS_VIEW_MODES = ["gallery", "rows"] as const;

export type AdminsViewMode = (typeof ADMINS_VIEW_MODES)[number];

/** Default view — the owner finds the card layout easier to scan. */
export const DEFAULT_ADMINS_VIEW: AdminsViewMode = "gallery";

/** localStorage key mirroring the user's last-chosen view (persists across nav). */
export const ADMINS_VIEW_STORAGE_KEY = "admins-list-view";

/**
 * Parse an untrusted `?view=` value to a known mode, defaulting to gallery.
 * Pure string normalization — no side effects.
 */
export function parseAdminsViewMode(
  value: string | null | undefined,
): AdminsViewMode {
  return (ADMINS_VIEW_MODES as readonly string[]).includes(value ?? "")
    ? (value as AdminsViewMode)
    : DEFAULT_ADMINS_VIEW;
}
