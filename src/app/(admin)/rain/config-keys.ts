/**
 * site_config keys that drive rain behavior on the game backend.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant, which is why the value lives here instead of in
 * rain/actions.ts. Next.js rejects non-async exports from a "use
 * server" file at build time.
 *
 * Both the server action (rain/actions.ts) and the server component
 * that hydrates the config form (rain/page.tsx) import from here, so
 * a rename is a single-line change.
 *
 * IMPORTANT: these values only take effect if the game backend is
 * configured to read these keys. If the backend still hardcodes the
 * defaults, the admin UI will happily persist new values but nothing
 * downstream will use them. Verify with the backend team before
 * trusting the config.
 *
 * Semantics (per current site_config descriptions):
 *
 *  - rain_base_amount_usd      live baseline pot read at start time
 *  - rain_default_base_amount  default base_amount_usd applied to newly
 *                              created rain instances
 *  - rain_duration_minutes     duration of ONE rain (starts_at → ends_at)
 *  - rain_duration_ms          frequency BETWEEN rains (ms between starts)
 *
 * The naming overlap (`rain_base_amount_usd` vs `rain_default_base_amount`)
 * is historical — both currently exist as separate rows in site_config.
 * Keep both editable so an admin can adjust either without database access.
 */
export const RAIN_CONFIG_KEYS = {
  /** Default base_amount_usd applied to newly created rain instances. */
  defaultBaseAmount: "rain_default_base_amount",
  /** Live baseline rain pot amount; backend reads this when starting a rain. */
  liveBaseAmount: "rain_base_amount_usd",
  /** Duration in minutes between rain starts_at and ends_at (one rain). */
  durationMinutes: "rain_duration_minutes",
  /** Frequency between rain starts, in milliseconds. */
  frequencyMs: "rain_duration_ms",
} as const;

/**
 * All site_config keys owned by the /rain?tab=config UI. Used by the
 * /security page to filter these out of its generic config table so
 * the two surfaces don't both let admins edit the same row.
 */
export const RAIN_CONFIG_SITE_CONFIG_KEYS: readonly string[] = [
  RAIN_CONFIG_KEYS.defaultBaseAmount,
  RAIN_CONFIG_KEYS.liveBaseAmount,
  RAIN_CONFIG_KEYS.durationMinutes,
  RAIN_CONFIG_KEYS.frequencyMs,
];
