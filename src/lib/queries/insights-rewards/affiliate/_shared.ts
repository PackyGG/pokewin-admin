import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Shared helpers for /insights/rewards/affiliate query modules.
 *
 * Every helper in this directory keeps the same shape:
 *   - blacklist + staff exclusion via the existing helpers in
 *     `_blacklist.ts` and the standard `role NOT IN ('admin','support')`
 *     subquery — keeps numbers reconciling against the rest of the
 *     /insights/rewards surface.
 *   - period selector mapped through `daysForInsightsPeriod` — `null`
 *     means "lifetime" (no date filter at all).
 *   - cache TTL via `cacheTtlForInsightsPeriod` — 60s for tracked
 *     windows, 5min for the lifetime sweep.
 *
 * The page is read-only against the Main DB. No mutations, no shape
 * changes to upstream tables. Every query uses `$queryRawUnsafe` with
 * inline-quoted constants (NEVER user input) so it can take the
 * statement-level filters PostgreSQL would otherwise refuse on a
 * prepared statement (e.g. `INTERVAL '7 days'`).
 */

export const CACHE_TAG = "insights-rewards-affiliate";

export type AffiliatePeriodCtx = {
  period: InsightsRewardsPeriod;
  /** day count for the active window, null = lifetime */
  days: number | null;
  /** SQL fragment for date-filtering a column. Includes the leading `AND`. */
  dateFilterFor: (column: string) => string;
  /** Cache TTL in seconds for the active window. */
  ttl: number;
};

export function makePeriodCtx(period: InsightsRewardsPeriod): AffiliatePeriodCtx {
  const days = daysForInsightsPeriod(period);
  return {
    period,
    days,
    dateFilterFor: (column: string) =>
      days !== null ? `AND ${column} >= NOW() - INTERVAL '${days} days'` : "",
    ttl: cacheTtlForInsightsPeriod(period),
  };
}

export async function loadBlacklist(): Promise<string[]> {
  const blacklist = await getExcludedUserIds();
  return [...blacklist].sort();
}
