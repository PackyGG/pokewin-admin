/**
 * Pure client-safe types + constants + validators for admin preferences.
 *
 * Split out of `./admin-preferences.ts` so "use client" components (like
 * the profile preferences form) can import without dragging `adminDb` +
 * `pg` into the browser bundle — Turbopack pulls the whole module even
 * for type-only imports when any value import crosses the boundary.
 */

export type AdminPreferences = {
  /**
   * UI theme. Falls back to "system" when the column is unset.
   * "grailed" is a dark-family theme (premium indigo/cyan palette);
   * theme-conditional consumers treat it as dark. "grailed-light" is its
   * LIGHT-family sibling (grey-white indigo-tinted ramp) — treated as light.
   */
  theme: "light" | "dark" | "system" | "grailed" | "grailed-light";
  /**
   * IANA timezone identifier (e.g. "Europe/Berlin"). `null` means
   * "use the browser's detected timezone" — the client provider falls
   * back to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
   */
  timezone: string | null;
  /** Preferred date format preset. */
  dateFormat?: "MMM d, yyyy" | "dd/MM/yyyy" | "yyyy-MM-dd";
};

export const DEFAULT_PREFERENCES: AdminPreferences = {
  theme: "system",
  timezone: null,
};

export const THEME_VALUES: ReadonlyArray<AdminPreferences["theme"]> = [
  "light",
  "dark",
  "system",
  "grailed",
  "grailed-light",
];

export const DATE_FORMAT_VALUES: ReadonlyArray<
  NonNullable<AdminPreferences["dateFormat"]>
> = ["MMM d, yyyy", "dd/MM/yyyy", "yyyy-MM-dd"];

/**
 * IANA timezone check — uses `Intl.DateTimeFormat` which is available
 * in both Node and the browser. Returns true if the zone is accepted
 * by the runtime.
 *
 * Re-homed into the shared timezone layer (`@/lib/timezone/core`) so there
 * is a single implementation. Re-exported here under the original name so
 * the existing import sites (admin-preferences, profile form/actions) keep
 * working unchanged. `core` is pure + isomorphic (no React, no server-only)
 * so this client-safe types module can import it freely.
 */
export { isValidTimeZone as isValidTimezone } from "@/lib/timezone/core";
