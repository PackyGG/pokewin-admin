import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Per-affiliate-code funnel — click → signup → first deposit → wager.
 *
 * Source tables:
 *   - `affiliate_clicks`        → top of funnel (raw landing-page hits)
 *   - `affiliate_code_usages`   → middle / bottom of funnel. Each row
 *     carries a `code` + `referred_user_id`. The bottom funnel stages
 *     are derived from this table:
 *       - distinct signups   = COUNT(DISTINCT referred_user_id) where
 *         the usage row's affiliate type was a signup-style event.
 *         (The platform creates a usage row at signup with usage_type =
 *         'deposit' or 'wager'; we use distinct referred_user_id as the
 *         signup proxy because every referred user has at least one row.)
 *       - depositors          = COUNT(DISTINCT referred_user_id) with
 *         `deposit_amount_usd > 0`.
 *       - wagerers            = COUNT(DISTINCT referred_user_id) with
 *         `wager_amount_usd > 0`.
 *       - totalDownstreamWager = SUM(wager_amount_usd).
 *
 * We can't tell which `affiliate_clicks` row matches which `referred_user_id`
 * (the clicks table doesn't carry a user id — they're pre-signup). So
 * the click → signup conversion is the AGGREGATE: total clicks for the
 * code vs total distinct referred users for the code. Not 1:1 attribution,
 * but the right population-level metric for "is this code converting
 * the traffic it's getting?".
 *
 * Top 25 codes by downstream wager so the page focuses on the codes
 * that matter.
 */

const ROW_LIMIT = 25;

export type CodePerformanceRow = {
  code: string;
  affiliateUserId: string;
  affiliateUsername: string | null;
  /** Total affiliate_clicks rows in window for this code. */
  clicks: number;
  /** Distinct referred users contributing usage rows in window. */
  signups: number;
  /** Distinct referred users with deposit_amount_usd > 0 in window. */
  depositors: number;
  /** Distinct referred users with wager_amount_usd > 0 in window. */
  wagerers: number;
  /** Sum of wager_amount_usd across all usage rows for this code in window. */
  totalDownstreamWager: number;
  /** Commission accrued under this code in window (sum of referrer_cut_usd). */
  commissionAccrued: number;
  /** signups / clicks. Null when clicks is 0. */
  clickToSignupPct: number | null;
  /** depositors / signups. Null when signups is 0. */
  signupToDepositPct: number | null;
  /** wagerers / depositors. Null when depositors is 0. */
  depositToWagerPct: number | null;
};

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<CodePerformanceRow[]> {
  const db = await getDb();
  const ctx = makePeriodCtx(period);
  const clickDate = ctx.dateFilterFor("ac.created_at");
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  const rows = await db.$queryRawUnsafe<
    {
      code: string;
      affiliate_user_id: string;
      affiliate_username: string | null;
      clicks: string;
      signups: string;
      depositors: string;
      wagerers: string;
      total_wager: string;
      commission_accrued: string;
    }[]
  >(`
    WITH usage_agg AS (
      SELECT
        acu.code,
        acu.affiliate_user_id,
        COUNT(DISTINCT acu.referred_user_id) AS signups,
        COUNT(DISTINCT acu.referred_user_id) FILTER (WHERE acu.deposit_amount_usd::numeric > 0) AS depositors,
        COUNT(DISTINCT acu.referred_user_id) FILTER (WHERE acu.wager_amount_usd::numeric > 0) AS wagerers,
        SUM(acu.wager_amount_usd::numeric) AS total_wager,
        SUM(acu.referrer_cut_usd::numeric) AS commission_accrued
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        ${acuDate}
      GROUP BY acu.code, acu.affiliate_user_id
    ),
    click_agg AS (
      SELECT
        ac.code,
        COUNT(*) AS clicks
      FROM affiliate_clicks ac
      WHERE 1 = 1
        ${clickDate}
      GROUP BY ac.code
    )
    SELECT
      ua.code,
      ua.affiliate_user_id,
      u.username AS affiliate_username,
      COALESCE(ca.clicks, 0)::text AS clicks,
      ua.signups::text AS signups,
      ua.depositors::text AS depositors,
      ua.wagerers::text AS wagerers,
      COALESCE(ua.total_wager, 0)::text AS total_wager,
      COALESCE(ua.commission_accrued, 0)::text AS commission_accrued
    FROM usage_agg ua
    LEFT JOIN click_agg ca ON ca.code = ua.code
    JOIN "user" u ON u.id = ua.affiliate_user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
    ORDER BY COALESCE(ua.total_wager, 0) DESC, ua.signups DESC
    LIMIT ${ROW_LIMIT}
  `);

  return rows.map((r) => {
    const clicks = Number(r.clicks);
    const signups = Number(r.signups);
    const depositors = Number(r.depositors);
    const wagerers = Number(r.wagerers);
    return {
      code: r.code,
      affiliateUserId: r.affiliate_user_id,
      affiliateUsername: r.affiliate_username,
      clicks,
      signups,
      depositors,
      wagerers,
      totalDownstreamWager: toNumber(r.total_wager),
      commissionAccrued: toNumber(r.commission_accrued),
      clickToSignupPct: clicks > 0 ? (signups / clicks) * 100 : null,
      signupToDepositPct: signups > 0 ? (depositors / signups) * 100 : null,
      depositToWagerPct: depositors > 0 ? (wagerers / depositors) * 100 : null,
    };
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-code-perf-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-code-perf-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateCodePerformance(
  period: InsightsRewardsPeriod,
): Promise<CodePerformanceRow[]> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedLong(period, blacklist)
    : cachedShort(period, blacklist);
}
