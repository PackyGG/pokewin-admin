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

const CreatorsSearchParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  sortBy: CreatorsSortMode.default("recent"),
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
