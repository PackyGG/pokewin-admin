import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Overview KPI summary for /insights/rewards/affiliate.
 *
 * Source of truth:
 *   - `ledger_transactions` with `type='affiliate_claim' AND status='completed'`
 *     → commission paid (house cost → rose).
 *   - `affiliate_code_usages` with `status='completed'` → downstream
 *     wager attribution. Each row carries `wager_amount_usd` for the
 *     play that hit through the affiliate code.
 *
 * Staff (admin/support) + blacklisted users excluded on the AFFILIATE
 * side via the same standard subquery the rest of the page uses. The
 * referred-user side is left unfiltered for the wager metric because
 * the platform aggregates the affiliate's earnings off referred wagers
 * regardless of who the referred user is (filtering there would
 * understate the lens).
 *
 * Daily commission series — zero-filled across the active window so
 * the chart has no gaps. Lifetime view caps at the last 90 days of
 * daily data so the chart stays readable.
 */

export type AffiliateOverview = {
  /** Distinct affiliate accounts paid in the window. */
  activeAffiliates: number;
  /** Sum of ABS(amount) of affiliate_claim ledger rows in window. */
  totalCommissionPaid: number;
  /** Sum of `wager_amount_usd` from affiliate_code_usages in window. */
  downstreamWager: number;
  /** Distinct referred users contributing usage rows in window. */
  distinctReferredUsers: number;
  /** Count of affiliate_claim rows in window. */
  claimCount: number;
  /** totalCommissionPaid / activeAffiliates. */
  avgCommissionPerAffiliate: number;
  /**
   * ROI proxy = downstreamWager - totalCommissionPaid. The house pays
   * commission to acquire wager flow; this is the net wager generated
   * minus the cost of generating it. Positive = emerald (house profits
   * from the affiliate program), negative = rose. House-POV.
   */
  roiUsd: number;
  /**
   * Commission as % of downstreamWager. Null when downstreamWager is 0
   * (lifetime view of a brand-new affiliate program with no wager yet).
   */
  commissionPctOfWager: number | null;
  /** Zero-filled daily commission series capped at the chart horizon. */
  dailyCommission: Array<{ date: string; commission: number; count: number }>;
  /** Total wager flowing through affiliate codes per day, same horizon. */
  dailyWager: Array<{ date: string; wager: number }>;
};

const MAX_CHART_DAYS = 90;

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<AffiliateOverview> {
  const db = await getDb();
  const ctx = makePeriodCtx(period);
  const ltDate = ctx.dateFilterFor("lt.created_at");
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistSub = blacklistNotInClause("id", blacklistIds);

  const chartDays = ctx.days === null ? MAX_CHART_DAYS : Math.min(ctx.days, MAX_CHART_DAYS);

  const [claimRollup, usageRollup, dailyClaim, dailyWager] = await Promise.all([
    // Affiliate claim ledger rollup.
    db.$queryRawUnsafe<
      { affiliates: string; total: string; cnt: string }[]
    >(`
      SELECT
        COUNT(DISTINCT lt.user_id)::text AS affiliates,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSub})
        ${ltDate}
    `),
    // Downstream wager + distinct referred users.
    db.$queryRawUnsafe<
      { wager: string; referred: string }[]
    >(`
      SELECT
        COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager,
        COUNT(DISTINCT acu.referred_user_id)::text AS referred
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        ${acuDate}
        ${blacklistNotInClause("acu.affiliate_user_id", blacklistIds)}
    `),
    // Daily commission paid — capped at chart horizon to keep payload sane.
    db.$queryRawUnsafe<
      { date: Date; total: string; cnt: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
        AND lt.created_at >= NOW() - INTERVAL '${chartDays} days'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSub})
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    db.$queryRawUnsafe<
      { date: Date; wager: string }[]
    >(`
      SELECT
        DATE(acu.created_at) AS date,
        COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        AND acu.created_at >= NOW() - INTERVAL '${chartDays} days'
        ${blacklistNotInClause("acu.affiliate_user_id", blacklistIds)}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
  ]);

  const claimRow = claimRollup[0];
  const usageRow = usageRollup[0];

  const activeAffiliates = Number(claimRow?.affiliates ?? 0);
  const totalCommissionPaid = toNumber(claimRow?.total);
  const claimCount = Number(claimRow?.cnt ?? 0);
  const downstreamWager = toNumber(usageRow?.wager);
  const distinctReferredUsers = Number(usageRow?.referred ?? 0);

  const avgCommissionPerAffiliate =
    activeAffiliates > 0 ? totalCommissionPaid / activeAffiliates : 0;
  const roiUsd = downstreamWager - totalCommissionPaid;
  const commissionPctOfWager =
    downstreamWager > 0 ? (totalCommissionPaid / downstreamWager) * 100 : null;

  // Zero-fill the date axis.
  const axis: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().split("T")[0]);
  }
  const claimByDay = new Map<string, { commission: number; count: number }>();
  for (const r of dailyClaim) {
    const day = new Date(r.date).toISOString().split("T")[0];
    claimByDay.set(day, {
      commission: toNumber(r.total),
      count: Number(r.cnt),
    });
  }
  const wagerByDay = new Map<string, number>();
  for (const r of dailyWager) {
    const day = new Date(r.date).toISOString().split("T")[0];
    wagerByDay.set(day, toNumber(r.wager));
  }
  const dailyCommissionSeries = axis.map((date) => ({
    date,
    commission: claimByDay.get(date)?.commission ?? 0,
    count: claimByDay.get(date)?.count ?? 0,
  }));
  const dailyWagerSeries = axis.map((date) => ({
    date,
    wager: wagerByDay.get(date) ?? 0,
  }));

  return {
    activeAffiliates,
    totalCommissionPaid,
    downstreamWager,
    distinctReferredUsers,
    claimCount,
    avgCommissionPerAffiliate,
    roiUsd,
    commissionPctOfWager,
    dailyCommission: dailyCommissionSeries,
    dailyWager: dailyWagerSeries,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-overview-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-overview-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateOverview(
  period: InsightsRewardsPeriod,
): Promise<AffiliateOverview> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedLong(period, blacklist)
    : cachedShort(period, blacklist);
}
