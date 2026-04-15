/**
 * site_config keys that drive rain defaults for the game backend.
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
 * configured to read these keys when creating new rain instances. If
 * the backend still hardcodes the defaults, the admin UI will happily
 * persist new values but nothing downstream will use them. Verify
 * with the backend team before trusting the config.
 */
export const RAIN_CONFIG_KEYS = {
  defaultBaseAmount: "rain_default_base_amount",
  durationMinutes: "rain_duration_minutes",
} as const;
