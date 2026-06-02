import { z } from "zod";

import {
  DASHBOARD_PERIODS,
  DEFAULT_DASHBOARD_PERIOD,
} from "@/lib/queries/dashboard-period";

/**
 * Sort modes for /creators.
 *   • recent   — default backend-paginated view (creation-order
 *                tiebreak); active-deal creators are pinned to the
 *                top of each page client-side.
 *   • ggr_desc — biggest house win first. Orders the page rows by the
 *                windowed code-user GGR (`getAllCreatorsNetGgr`) merged
 *                onto each visible creator — positive = the cohort lost
 *                money to us (house win). GGR-side only; the full Net
 *                PnL (GGR − cost) lives on /creators/[id].
 *   • ggr_asc  — biggest house loss first (cohorts we paid out to).
 *   • ftd_desc — most first-time depositors first.
 *   • ftd_asc  — fewest first-time depositors first.
 *
 * The ggr_* / ftd_* sorts re-order ONLY the current page's rows in
 * memory (after the per-row GGR/FTD enrichment lands) — the same model
 * the `recent` active-deal pin uses. They do NOT trigger a full-pool
 * walk; the proper roster-wide ranking lives on the detail surfaces.
 */
export const CreatorsSortMode = z.enum([
  "recent",
  "ggr_desc",
  "ggr_asc",
  "ftd_desc",
  "ftd_asc",
]);
export type CreatorsSortMode = z.infer<typeof CreatorsSortMode>;

/**
 * Which creator-deal program the list is filtered to — the page's
 * Fill / Multiplier tabs.
 *   • fill       — creators with at least one fill (weekly) deal.
 *   • multiplier — creators with at least one multiplier deal.
 * Default `fill`. A creator with neither deal type appears on no tab.
 */
export const CreatorsTab = z.enum(["fill", "multiplier"]);
export type CreatorsTab = z.infer<typeof CreatorsTab>;

// NOTE: the Grid / List render mode is NOT a search param. It's pure
// presentation over the same fetched data, so it lives as client state
// (see _components/creators-view-context.tsx) — putting it in the URL
// would re-run this server page and refetch the whole creator pool on
// every toggle. Persisted via localStorage instead.

const CreatorsSearchParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  // `filter` powers the click-through from the Live Now / Active Deals
  // tiles. Optional — when absent the page renders the normal
  // paginated list. When set, the page switches to
  // `listCreatorsFiltered` and shows the matching subset on a single
  // page (pagination is hidden). `z.enum` rejects unknown values so a
  // URL-fuzzer can't smuggle garbage into the page's render path.
  filter: z.enum(["live", "active-deals"]).optional(),
  sortBy: CreatorsSortMode.default("recent"),
  tab: CreatorsTab.default("fill"),
  // `period` scopes the per-creator windowed code-user GGR shown on the
  // list (and the roster-wide Net Code-User GGR tile). Reuses the
  // dashboard period set so the chip values line up with the rest of
  // the app. Active-timeframe-only: only this one window is fetched per
  // render — switching it is a fresh `?period=` navigation, never an
  // eager preload of every window.
  period: z.enum(DASHBOARD_PERIODS).default(DEFAULT_DASHBOARD_PERIOD),
});

export type CreatorsSearchParams = z.infer<typeof CreatorsSearchParamsSchema>;

/**
 * Parse the raw search params from a Next.js page and coerce to a typed,
 * defaulted object. Invalid values silently fall back to defaults so that
 * a bad URL never breaks the page render — we only care about valid ones.
 */
export function parseCreatorsSearchParams(
  raw: Record<string, string | undefined>,
): CreatorsSearchParams {
  const parsed = CreatorsSearchParamsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : CreatorsSearchParamsSchema.parse({});
}
