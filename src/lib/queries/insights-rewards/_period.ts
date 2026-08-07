import type { RewardsPeriod } from "@/lib/queries/rewards-analytics";

/**
 * Shared period helpers for the /insights/rewards page. The page exposes
 * a wider set of windows than /rewards/analytics — admins need to compare
 * 24h / 3d / 7d / 30d / 90d / lifetime, not just the four the existing
 * rewards-analytics page supports.
 *
 * Internally each helper maps the wider set down to either:
 *   - a `RewardsPeriod` for the upstream per-category helpers (today /
 *     7d / 30d / all), so the per-category tab on /insights/rewards can
 *     reuse the cached rewards-category-analytics + rewards-category-extras
 *     helpers without forking a second cache key set, OR
 *   - a raw day count (number | null) for the cross-category queries
 *     in this folder, which compute pre/post / lift / stacking lenses
 *     across reward types and need the full 6-window precision.
 *
 * The two ranges are deliberately layered: per-category panels stay
 * coarse (matching the experience on /rewards/analytics so the user
 * doesn't see numbers shift between the two pages) while the
 * cross-category lenses use the finer grain (24h spikes, 90d roll-up).
 */

export type InsightsRewardsPeriod =
  | "24h"
  | "3d"
  | "7d"
  | "30d"
  | "90d"
  | "all";

export function parseInsightsRewardsPeriod(
  value: string | undefined,
): InsightsRewardsPeriod {
  switch (value) {
    case "24h":
    case "3d":
    case "7d":
    case "30d":
    case "90d":
    case "all":
      return value;
    default:
      return "30d";
  }
}

export function insightsRewardsPeriodLabel(p: InsightsRewardsPeriod): string {
  switch (p) {
    case "24h":
      return "Last 24 hours";
    case "3d":
      return "Last 3 days";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "All time";
  }
}

/** Day count for the raw cross-category queries. `null` = lifetime. */
export function daysForInsightsPeriod(
  p: InsightsRewardsPeriod,
): number | null {
  switch (p) {
    case "24h":
      return 1;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

/**
 * Lifetime lookback cap (days) for HEAVY reward sweeps whose `all` window
 * would otherwise scan the entire ledger_transactions / user_inventory
 * history with no lower bound — the unbounded-lifetime pattern CLAUDE.md
 * ("Performance & Daten-Laden") forbids. Mirrors the deposit-bonus
 * `LIFETIME_PAIRING_LOOKBACK_DAYS` (365d) one folder over so the two stay
 * aligned. Covers effectively all currently-relevant reward activity while
 * keeping the cold/first cache fill tractable.
 */
const INSIGHTS_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Like {@link daysForInsightsPeriod}, but the lifetime (`all`) window
 * resolves to {@link INSIGHTS_LIFETIME_LOOKBACK_DAYS} instead of `null`
 * (unbounded). Use this for the heavy headline reward-cost / daily-pack
 * scans so a lifetime view does not trigger a full-history table scan.
 * Finite windows return the same value as `daysForInsightsPeriod`.
 */
export function daysForInsightsPeriodCapped(p: InsightsRewardsPeriod): number {
  return daysForInsightsPeriod(p) ?? INSIGHTS_LIFETIME_LOOKBACK_DAYS;
}

/**
 * Map an InsightsRewardsPeriod onto the closest `RewardsPeriod` used by
 * the existing per-category helpers (`rewards-category-analytics.ts` and
 * `rewards-category-extras.ts`). The /rewards/analytics page only exposes
 * today / 7d / 30d / all — finer windows (3d / 90d) round to the nearest
 * supported bucket so the per-category panels still reconcile with what
 * an admin sees on /rewards/analytics for the same range. Lifetime (all)
 * stays lifetime.
 *
 * 3d → 7d (closer to 7d than to today); 90d → 30d (no 90d cache key on
 * the per-category side and we don't want to fork a second cache layer
 * for this page).
 */
export function insightsPeriodToCategoryPeriod(
  p: InsightsRewardsPeriod,
): RewardsPeriod {
  switch (p) {
    case "24h":
      return "today";
    case "3d":
    case "7d":
      return "7d";
    case "30d":
    case "90d":
      return "30d";
    case "all":
      return "all";
  }
}

/**
 * Default cache TTL for cross-category helpers — 60 seconds for shorter
 * windows where activity changes fast, 5 minutes for the lifetime view
 * which barely moves second-to-second. Mirrors the pattern used in
 * `rewards-category-analytics.ts` (60s revalidate) while loosening it
 * for the lifetime sweep so the heavier query doesn't refire on every
 * admin scroll.
 */
export function cacheTtlForInsightsPeriod(p: InsightsRewardsPeriod): number {
  return p === "all" ? 300 : 60;
}
