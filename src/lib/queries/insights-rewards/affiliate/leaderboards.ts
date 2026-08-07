import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Two-lens leaderboards for the affiliate program. Both lenses sit on
 * different source tables and answer different questions:
 *
 *   1. Top by commission earned — ranks affiliates by what we PAID them
 *      in the window. Sourced from `ledger_transactions` rows of type
 *      `affiliate_claim` filed under the affiliate user_id. Skews
 *      toward affiliates settling stored balance (high commission can
 *      coincide with low recent activity if the affiliate just claimed
 *      accrued balance for old referrals).
 *
 *   2. Top by downstream wager — ranks affiliates by their referred
 *      users' wager in the window. Sourced from `affiliate_code_usages`
 *      where each row already carries the `wager_amount_usd` for the
 *      play that hit through the affiliate code. Skews toward
 *      affiliates whose cohort is currently active, not necessarily
 *      claiming yet.
 *
 * Both leaderboards top-out at 25 entries so the page can render a
 * proper deep-dive table without scrollbar fatigue.
 */

const TOP_LIMIT = 25;

type TopAffiliateByCommission = {
  affiliateUserId: string;
  username: string | null;
  commissionPaid: number;
  claimCount: number;
  /**
   * Distinct referred users contributing usage rows in the same window.
   * Mostly a sanity check — affiliates can claim with zero referred
   * activity if they're settling stored balance.
   */
  referredUsersInWindow: number;
};

export type TopAffiliateByWager = {
  affiliateUserId: string;
  username: string | null;
  referredWager: number;
  referredCount: number;
  /**
   * Commission earned in the same window for context. Pairs the wager
   * with the commission so the admin sees both at once.
   */
  commissionPaid: number;
};

async function computeTopByCommission(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<TopAffiliateByCommission[]> {
  const db = await getReadDrizzleDb();
  const ctx = makePeriodCtx(period);
  const ltDate = ctx.dateFilterFor("lt.created_at");
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  const rows = await queryRows<
    {
      affiliate_user_id: string;
      username: string | null;
      commission: string;
      claims: string;
      referred_users: string;
    }[]
  >(db, sql`
    WITH claim_agg AS (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS commission,
        COUNT(*) AS claims
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
        ${ltDate}
      GROUP BY lt.user_id
    ),
    referred_agg AS (
      SELECT
        acu.affiliate_user_id,
        COUNT(DISTINCT acu.referred_user_id) AS referred_count
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        ${acuDate}
      GROUP BY acu.affiliate_user_id
    )
    SELECT
      ca.user_id AS affiliate_user_id,
      u.username,
      ca.commission::text AS commission,
      ca.claims::text AS claims,
      COALESCE(ra.referred_count, 0)::text AS referred_users
    FROM claim_agg ca
    JOIN "user" u ON u.id = ca.user_id
    LEFT JOIN referred_agg ra ON ra.affiliate_user_id = ca.user_id
    WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
    ORDER BY ca.commission DESC
    LIMIT ${TOP_LIMIT}
  `);

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    commissionPaid: toNumber(r.commission),
    claimCount: Number(r.claims),
    referredUsersInWindow: Number(r.referred_users),
  }));
}

async function computeTopByWager(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<TopAffiliateByWager[]> {
  const db = await getReadDrizzleDb();
  const ctx = makePeriodCtx(period);
  const ltDate = ctx.dateFilterFor("lt.created_at");
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  const rows = await queryRows<
    {
      affiliate_user_id: string;
      username: string | null;
      wager: string;
      referred_count: string;
      commission: string;
    }[]
  >(db, sql`
    WITH wager_agg AS (
      SELECT
        acu.affiliate_user_id,
        SUM(acu.wager_amount_usd::numeric) AS wager,
        COUNT(DISTINCT acu.referred_user_id) AS referred_count
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        ${acuDate}
      GROUP BY acu.affiliate_user_id
    ),
    claim_agg AS (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS commission
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
        ${ltDate}
      GROUP BY lt.user_id
    )
    SELECT
      wa.affiliate_user_id,
      u.username,
      wa.wager::text AS wager,
      wa.referred_count::text AS referred_count,
      COALESCE(ca.commission, 0)::text AS commission
    FROM wager_agg wa
    JOIN "user" u ON u.id = wa.affiliate_user_id
    LEFT JOIN claim_agg ca ON ca.user_id = wa.affiliate_user_id
    WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      AND wa.wager > 0
    ORDER BY wa.wager DESC
    LIMIT ${TOP_LIMIT}
  `);

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    referredWager: toNumber(r.wager),
    referredCount: Number(r.referred_count),
    commissionPaid: toNumber(r.commission),
  }));
}

const cachedTopByCommissionShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopByCommission(period, blacklistIds),
  ["insights-affiliate-top-commission-v2-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedTopByCommissionLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopByCommission(period, blacklistIds),
  ["insights-affiliate-top-commission-v2-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

const cachedTopByWagerShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopByWager(period, blacklistIds),
  ["insights-affiliate-top-wager-v2-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedTopByWagerLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopByWager(period, blacklistIds),
  ["insights-affiliate-top-wager-v2-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

async function getTopAffiliatesByCommission(
  period: InsightsRewardsPeriod,
): Promise<TopAffiliateByCommission[]> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedTopByCommissionLong(period, blacklist)
    : cachedTopByCommissionShort(period, blacklist);
}

export async function getTopAffiliatesByWager(
  period: InsightsRewardsPeriod,
): Promise<TopAffiliateByWager[]> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedTopByWagerLong(period, blacklist)
    : cachedTopByWagerShort(period, blacklist);
}
