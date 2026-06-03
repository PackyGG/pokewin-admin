import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
  windowDateFilter,
} from "./_shared";

/**
 * Overview rollup for /insights/rewards/deposit-bonus.
 *
 * Drives the top KPI strip + daily volume chart on the Overview tab.
 * Includes prior-window comparison so the page can render a delta vs
 * the previous equal window (only finite windows — lifetime has no
 * "prior" frame).
 *
 * Source of truth: `ledger_transactions` rows with
 *   - status = 'completed'
 *   - type = 'deposit_bonus'
 *   - user is non-staff + non-blacklisted
 *
 * Same shape as the existing `getDepositBonusAnalytics` baseline +
 * `cross-category-summary` (for the prior-window pattern). House-POV
 * everywhere — bonuses are house cost → rose.
 */

export type DepositBonusOverview = {
  /** Total bonus volume in the window (sum of ABS(amount)). */
  totalCost: number;
  /** Number of bonus rows in the window. */
  count: number;
  /** Distinct claimants in the window. */
  uniqueClaimants: number;
  /** Avg bonus = totalCost / count. */
  avg: number;
  /** Median bonus via PERCENTILE_CONT(0.5). */
  median: number;
  /** Largest single bonus = empirical cap. */
  max: number;
  /** Daily series (ASC). */
  dailyVolume: Array<{
    date: string;
    volume: number;
    count: number;
    /** Distinct claimants on that day. */
    claimants: number;
  }>;
  /** Prior equal window — null for lifetime. */
  priorWindow: {
    totalCost: number;
    count: number;
    uniqueClaimants: number;
    /** (current − prior) / prior, null when prior was zero. */
    costDelta: number | null;
    countDelta: number | null;
    claimantDelta: number | null;
  } | null;
};

async function computeOverview(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusOverview> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Headline rollup + daily series in parallel — same filter shape so
  // totals reconcile by construction.
  const [rollupRows, dailyRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        total: string;
        cnt: string;
        claimants: string;
        median: string | null;
        max_amount: string | null;
      }[]
    >(`
      SELECT
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS claimants,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(lt.amount::numeric))::text AS median,
        MAX(ABS(lt.amount::numeric))::text AS max_amount
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
    `),
    db.$queryRawUnsafe<
      { date: Date; volume: string; cnt: string; claimants: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS claimants
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY date ASC
    `),
  ]);

  const rollup = rollupRows[0];
  const totalCost = toNumber(rollup?.total);
  const count = Number(rollup?.cnt ?? 0);
  const uniqueClaimants = Number(rollup?.claimants ?? 0);
  const median = rollup?.median != null ? toNumber(rollup.median) : 0;
  const max = rollup?.max_amount != null ? toNumber(rollup.max_amount) : 0;
  const avg = count > 0 ? totalCost / count : 0;

  const dailyVolume = dailyRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    volume: toNumber(r.volume),
    count: Number(r.cnt),
    claimants: Number(r.claimants ?? 0),
  }));

  // Prior window — only finite periods. Same status / type / scope so
  // the delta is apples-to-apples.
  let priorWindow: DepositBonusOverview["priorWindow"] = null;
  if (days !== null) {
    const priorRows = await db.$queryRawUnsafe<
      { total: string; cnt: string; claimants: string }[]
    >(`
      SELECT
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt,
        COUNT(DISTINCT lt.user_id)::text AS claimants
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        AND lt.created_at >= NOW() - INTERVAL '${days * 2} days'
        AND lt.created_at < NOW() - INTERVAL '${days} days'
    `);
    const prev = priorRows[0];
    const prevCost = toNumber(prev?.total);
    const prevCount = Number(prev?.cnt ?? 0);
    const prevClaimants = Number(prev?.claimants ?? 0);
    const delta = (now: number, prior: number): number | null =>
      prior > 0 ? (now - prior) / prior : null;
    priorWindow = {
      totalCost: prevCost,
      count: prevCount,
      uniqueClaimants: prevClaimants,
      costDelta: delta(totalCost, prevCost),
      countDelta: delta(count, prevCount),
      claimantDelta: delta(uniqueClaimants, prevClaimants),
    };
  }

  return {
    totalCost,
    count,
    uniqueClaimants,
    avg,
    median,
    max,
    dailyVolume,
    priorWindow,
  };
}

const cachedOverview = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeOverview(period, blacklistIds),
  ["insights-rewards-deposit-bonus-overview-v1"],
  { revalidate: 60, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

const cachedOverviewLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeOverview(period, blacklistIds),
  ["insights-rewards-deposit-bonus-overview-lifetime-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusOverview(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusOverview> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedOverviewLifetime(period, blacklist)
    : cachedOverview(period, blacklist);
}
