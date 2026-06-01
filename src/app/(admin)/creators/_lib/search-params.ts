import { z } from "zod";

/**
 * Sort modes for /creators.
 *   • recent   — default backend-paginated view (creation-order
 *                tiebreak); active-deal creators are pinned to the
 *                top of each page client-side. Cheap — only 20
 *                rows + their PnLs hit the main DB per page.
 *   • pnl_desc — best house P&L first. Forces a full creator-pool
 *                walk + per-creator lifetime PnL fetch, then
 *                sorts + slices in memory. Bounded by SORT_FETCH_CAP.
 *   • pnl_asc  — worst house P&L first (creators we LOST money on).
 *                Same expensive path as pnl_desc.
 */
export const CreatorsSortMode = z.enum(["recent", "pnl_desc", "pnl_asc"]);
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

/**
 * How the creator list is rendered.
 *   • grid — default. Self-contained cards (1 / 2 / 3 cols), rich
 *            per-creator detail. Best for browsing.
 *   • list — compact one-creator-per-row table for scanning a large
 *            roster quickly. Surfaces the same data the card shows,
 *            inline as columns.
 * URL-driven via `?view=`; absent → `grid` so the default experience
 * is unchanged for anyone who doesn't pick list.
 */
export const CreatorsView = z.enum(["grid", "list"]);
export type CreatorsView = z.infer<typeof CreatorsView>;

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
  // Grid (cards) vs list (compact rows). Default `grid` carries no
  // `?view` param. `z.enum` rejects unknown values so a bad URL falls
  // back to the card grid rather than breaking the render.
  view: CreatorsView.default("grid"),
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
