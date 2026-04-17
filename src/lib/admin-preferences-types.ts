/**
 * Pure client-safe types + constants + validators for admin preferences.
 *
 * Split out of `./admin-preferences.ts` so "use client" components (like
 * the profile preferences form) can import without dragging `adminDb` +
 * `pg` into the browser bundle — Turbopack pulls the whole module even
 * for type-only imports when any value import crosses the boundary.
 */

export type AdminPreferences = {
  /** UI theme. Falls back to "system" when the column is unset. */
  theme: "light" | "dark" | "system";
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
];

export const DATE_FORMAT_VALUES: ReadonlyArray<
  NonNullable<AdminPreferences["dateFormat"]>
> = ["MMM d, yyyy", "dd/MM/yyyy", "yyyy-MM-dd"];

/**
 * IANA timezone check — uses `Intl.DateTimeFormat` which is available
 * in both Node and the browser. Returns true if the zone is accepted
 * by the runtime.
 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
