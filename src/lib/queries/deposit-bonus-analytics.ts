import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import { parseRewardsPeriod, type RewardsPeriod } from "./rewards-analytics";

/**
 * Deposit-bonus deep-stats helper for /rewards/analytics.
 *
 * Surfaces the dedicated "Deposit Bonus" panel on the rewards-analytics
 * page: total volume paid out, count, avg / median / max, unique
 * recipients, cap-hit rate (how often a bonus row equals the observed
 * cap), a daily time-series, and the top-10 users + top-10 days by
 * bonus volume.
 *
 * Source of truth: `ledger_transactions` rows with `type =
 * 'deposit_bonus'` AND `status = 'completed'`. Same staff + blacklist
 * exclusion the rest of `rewards-analytics.ts` uses so the totals on
 * the new panel reconcile with the "Bonuses & Promos" headline tile.
 *
 * Cap value: the deposit-bonus cap is configured in the GAME BACKEND
 * (not in `site_config` on the main DB, and not in this admin
 * codebase). We therefore derive it empirically as `MAX(ABS(amount))`
 * observed in the period — that IS the largest payout the backend has
 * actually issued. "Cap hits" = count of rows whose ABS(amount) equals
 * that max. This stays correct if the cap is ever raised: the new max
 * becomes the new cap and the hit-rate naturally tracks it. If the cap
 * key shows up in site_config later, swap the source here and drop
 * the empirical derivation — every other call site (chart, KPIs)
 * stays the same.
 *
 * Per CLAUDE.md House-POV: deposit bonus is money the house GIVES
 * users → drag on house P&L → rose accent on the panel.
 */

export type DepositBonusAnalytics = {
  /** Sum of ABS(amount) for the period — total bonus volume paid out. */
  totalVolume: number;
  /** Number of deposit_bonus rows in the period. */
  count: number;
  /** Mean bonus per claim — totalVolume / count, or 0 when count = 0. */
  avg: number;
  /** Median bonus per claim via PERCENTILE_CONT(0.5). */
  median: number;
  /** Largest single deposit-bonus amount seen in the period. */
  max: number;
  /** Distinct users who received at least one deposit_bonus in the period. */
  uniqueRecipients: number;
  /**
   * Observed cap — equal to `max` for the period. Surfaced separately
   * so callers can render "cap = $X" even when no row hit it.
   */
  capValue: number;
  /** Count of rows where ABS(amount) === capValue. */
  capHits: number;
  /** capHits / count, 0–1. Multiply by 100 in the UI. */
  capHitRate: number;
  /** Daily series sorted ASC by date for the time-series chart. */
  dailyVolume: Array<{ date: string; volume: number; count: number }>;
  /** Top 10 users by total bonus volume in the period. */
  topUsers: Array<{
    userId: string;
    username: string | null;
    volume: number;
    count: number;
  }>;
  /** Top 10 days by bonus volume in the period. */
  topDays: Array<{ date: string; volume: number; count: number }>;
};

function daysForPeriod(period: RewardsPeriod): number | null {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

const TOP_LIMIT = 10;

/**
 * Inner uncached computation. Wrapped in `unstable_cache` below so the
 * blacklist id list participates in the cache key — adding/removing
 * an excluded user invalidates on the next request.
 */
async function computeDepositBonusAnalytics(
  period: RewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusAnalytics> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);
  const blacklistJoinAlias = blacklistNotInClause("u.id", blacklistIds);

  // Single rollup query — total / count / avg / median / max / unique
  // recipients in one scan. PERCENTILE_CONT yields a numeric median
  // matching the rest of the dataset. ABS(amount) keeps the deposit_bonus
  // sign (it's stored negative because it's a credit-side ledger row,
  // same pattern as every other reward type in rewards-analytics.ts).
  const [rollupRows, dailyRows, topUserRows, topDayRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        total: string;
        cnt: string;
        median: string | null;
        max_amount: string | null;
        unique_recipients: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(lt.amount::numeric))::text AS median,
        MAX(ABS(lt.amount::numeric))::text AS max_amount,
        COUNT(DISTINCT lt.user_id)::text AS unique_recipients
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
    `),
    db.$queryRawUnsafe<
      { date: Date; volume: string; cnt: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY date ASC
    `),
    db.$queryRawUnsafe<
      {
        user_id: string;
        username: string | null;
        volume: string;
        cnt: string;
      }[]
    >(`
      SELECT
        u.id AS user_id,
        u.username,
        SUM(ABS(lt.amount::numeric))::text AS volume,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND u.role NOT IN ('admin', 'support') ${blacklistJoinAlias}
        ${dateFilter}
      GROUP BY u.id, u.username
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${TOP_LIMIT}
    `),
    db.$queryRawUnsafe<
      { date: Date; volume: string; cnt: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        SUM(ABS(lt.amount::numeric))::text AS volume,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${TOP_LIMIT}
    `),
  ]);

  const rollup = rollupRows[0];
  const totalVolume = toNumber(rollup?.total);
  const count = Number(rollup?.cnt ?? 0);
  const median = rollup?.median != null ? toNumber(rollup.median) : 0;
  const max = rollup?.max_amount != null ? toNumber(rollup.max_amount) : 0;
  const uniqueRecipients = Number(rollup?.unique_recipients ?? 0);
  const avg = count > 0 ? totalVolume / count : 0;

  // Cap-hit rate — compare against the same MAX we surfaced as the cap
  // value. Counted via a tiny dedicated query so the rollup stays a
  // single scan; this second sweep is bounded to the cap-equal rows
  // only and is cheap.
  let capHits = 0;
  if (max > 0) {
    const capHitRows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
      SELECT COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        AND ABS(lt.amount::numeric) = ${max.toFixed(2)}
        ${dateFilter}
    `);
    capHits = Number(capHitRows[0]?.cnt ?? 0);
  }
  const capHitRate = count > 0 ? capHits / count : 0;

  const dailyVolume = dailyRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    volume: toNumber(r.volume),
    count: Number(r.cnt),
  }));

  const topUsers = topUserRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    volume: toNumber(r.volume),
    count: Number(r.cnt),
  }));

  const topDays = topDayRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    volume: toNumber(r.volume),
    count: Number(r.cnt),
  }));

  return {
    totalVolume,
    count,
    avg,
    median,
    max,
    uniqueRecipients,
    capValue: max,
    capHits,
    capHitRate,
    dailyVolume,
    topUsers,
    topDays,
  };
}

/**
 * Cached entry point — 60s revalidate matches the rewards-analytics
 * cadence and the cache tag aligns with the existing rewards data so
 * a single revalidation invalidates this panel together with the rest
 * of the page when admins push a manual refresh.
 *
 * Cache key carries the period + sorted blacklist signature so admins
 * editing the excluded-users list see the new aggregate on the next
 * tick without manual cache busting.
 */
const cachedDepositBonusAnalytics = unstable_cache(
  async (period: RewardsPeriod, blacklistIds: string[]) =>
    computeDepositBonusAnalytics(period, blacklistIds),
  ["rewards-deposit-bonus-analytics-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getDepositBonusAnalytics(
  period: RewardsPeriod,
): Promise<DepositBonusAnalytics> {
  const blacklist = await getExcludedUserIds();
  // Stable sort so the cache key is order-insensitive — same pattern
  // the dashboard-live cached helpers use.
  const sorted = [...blacklist].sort();
  return cachedDepositBonusAnalytics(period, sorted);
}

// Re-export the period parser used by the analytics page so callers
// outside the page don't need a second import path.
export { parseRewardsPeriod };
