import { z } from "zod";

import {
  DASHBOARD_PERIODS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";

/**
 * Search / sort params for the Creator Hub roster (`/creator-hub/creators`).
 *
 * This is the Hub's OWN param surface — deliberately separate from the
 * legacy `/creators` `_lib/search-params.ts` (which carries the old page's
 * tab/filter/view machinery the Hub roster doesn't use). It reuses the
 * SAME canonical dashboard period set so the windowed metrics line up with
 * the rest of the app, but exposes only the controls the Hub roster needs:
 * a username/email instant filter (`?q=`) and the owner-specified sort set.
 */

/**
 * Roster sort modes — the owner's spec for the Hub roster
 * (plan: "/creators roster — filters / sorts", 2026-06-06):
 *
 *   newest / oldest        — by creator account creation date.
 *   wager_desc             — most affiliate wager (windowed cohort wager).
 *   ftd_desc               — most first-time depositors (lifetime).
 *   signups_desc           — most sign-ups from the creator's code (lifetime).
 *   pnl_desc / pnl_asc     — best / worst lifetime House P&L
 *                            (deposits − card withdrawals, from the cached
 *                            roster-wide lifetime-PnL breakdown).
 *   deal_desc / deal_asc   — biggest / smallest FULL DEAL VALUE: withdrawal
 *                            cap + leaderboard funding (× house share %) +
 *                            tip allowance + sponsorship allowance.
 *
 * Default `newest` so first paint shows the freshest creators (matches the
 * "roster" mental model). `z.enum` rejects unknown values so a fuzzed URL
 * silently falls back to the default rather than breaking the render.
 */
export const RosterSortMode = z.enum([
  "newest",
  "oldest",
  "wager_desc",
  "ftd_desc",
  "signups_desc",
  "pnl_desc",
  "pnl_asc",
  "deal_desc",
  "deal_asc",
]);
export type RosterSortMode = z.infer<typeof RosterSortMode>;

/** Human labels for the sort dropdown — kept beside the enum so they stay in lockstep. */
export const ROSTER_SORT_LABELS: Record<RosterSortMode, string> = {
  newest: "Newest",
  oldest: "Oldest",
  wager_desc: "Most wager",
  ftd_desc: "Most FTDs",
  signups_desc: "Most sign-ups",
  pnl_desc: "Best PnL",
  pnl_asc: "Worst PnL",
  deal_desc: "Biggest deal",
  deal_asc: "Smallest deal",
};

/** Ordered list for rendering the sort dropdown (same order as the spec). */
export const ROSTER_SORT_ORDER: readonly RosterSortMode[] = [
  "newest",
  "oldest",
  "wager_desc",
  "ftd_desc",
  "signups_desc",
  "pnl_desc",
  "pnl_asc",
  "deal_desc",
  "deal_asc",
];

/**
 * The Hub roster period chip set — a compact slice of the canonical
 * dashboard windows (48h · 7d · 30d · all). `wager_desc` is the only sort
 * that consults the window (windowed cohort wager); every other metric is
 * lifetime, so the window only re-scopes the wager column + sort. Default
 * is `7d` (a meaningful recent window without 24h-noise).
 */
export const ROSTER_PERIODS: readonly DashboardPeriod[] = [
  "48h",
  "7d",
  "30d",
  "all",
];

export const ROSTER_DEFAULT_PERIOD: DashboardPeriod = "7d";

/**
 * Roster population tab — mirrors `/creators` deal programs:
 *   • fill       — creators with at least one fill (weekly) deal.
 *   • multiplier — creators with at least one multiplier deal.
 *   • past       — canceled / ex-creators (DB-sourced).
 * Default `fill` carries no `?tab` param. Legacy `?tab=active` maps to fill.
 */
export const RosterTab = z.enum(["fill", "multiplier", "past"]);
export type RosterTab = z.infer<typeof RosterTab>;
export const ROSTER_DEFAULT_TAB: RosterTab = "fill";

/** Active roster tabs (not past/ex-creators). */
export type RosterActiveTab = Exclude<RosterTab, "past">;

/**
 * Grid / List render mode (`?view=`). Parsed on the server so the page only
 * builds the server-rendered card set when the grid actually renders — list
 * view skips the card build entirely.
 */
export type RosterViewMode = "grid" | "list";
export const ROSTER_DEFAULT_VIEW: RosterViewMode = "grid";

/**
 * Resolve a raw `?period=` value to a roster window. Unknown / unsupported
 * values fall back to the default. Shared by the server page parse and the
 * client period chips so the loaded window and the highlighted chip agree.
 */
export function resolveRosterPeriod(
  value: string | undefined | null,
): DashboardPeriod {
  const v = (value ?? "") as DashboardPeriod;
  if ((ROSTER_PERIODS as readonly string[]).includes(v)) return v;
  // Tolerate any other canonical window by clamping to default — never
  // surface a window the chip row can't represent.
  if ((DASHBOARD_PERIODS as readonly string[]).includes(v)) {
    return ROSTER_DEFAULT_PERIOD;
  }
  return ROSTER_DEFAULT_PERIOD;
}

const RosterSearchParamsSchema = z.object({
  /**
   * Fill / Multiplier / Past roster tab. `fill` is the default (omitted from
   * the URL). Legacy `?tab=active` resolves to `fill`.
   */
  tab: z
    .string()
    .optional()
    .transform((v) => {
      if (v === "active") return ROSTER_DEFAULT_TAB;
      const parsed = RosterTab.safeParse(v);
      return parsed.success ? parsed.data : ROSTER_DEFAULT_TAB;
    }),
  /**
   * Username / email / code instant filter. Lives in the URL for
   * bookmark + share parity, but NEVER gates a server query — the page
   * reads it only to seed the input's initial value, and the client
   * provider filters the already-fetched rows in place (no refetch).
   */
  q: z.string().trim().max(200).optional(),
  sortBy: RosterSortMode.default("newest"),
  /**
   * Windowed scope for the wager column + `wager_desc` sort. Coerced from a
   * free string (not `z.enum`) so a legacy/out-of-range value clamps to the
   * default instead of resetting to a hidden value. Active-timeframe-only:
   * only this one window is fetched per render.
   */
  period: z
    .string()
    .optional()
    .transform((v) => resolveRosterPeriod(v)),
  /**
   * Grid / List view. `grid` is the default (omitted from the URL). Parsed
   * here so the server builds grid cards only when they will render.
   */
  view: z
    .string()
    .optional()
    .transform((v): RosterViewMode => (v === "list" ? "list" : "grid")),
});

export type RosterSearchParams = z.infer<typeof RosterSearchParamsSchema>;

/**
 * Parse raw Next.js search params into a typed, defaulted roster param
 * object. Invalid values silently fall back to defaults so a bad URL never
 * breaks the render.
 */
export function parseRosterSearchParams(
  raw: Record<string, string | undefined>,
): RosterSearchParams {
  const parsed = RosterSearchParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : RosterSearchParamsSchema.parse({});
}
