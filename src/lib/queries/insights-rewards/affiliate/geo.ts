import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Geo distribution lens. Two side-by-side breakdowns:
 *
 *   - Affiliate geo       — top 12 countries of the AFFILIATE accounts
 *     paid in the window. Each row carries the ISO-2 code, distinct
 *     affiliates, total commission, share of commission.
 *
 *   - Referred-user geo   — top 12 countries of the REFERRED users who
 *     contributed downstream wager via `affiliate_code_usages`. Same
 *     columns scoped to the referred side.
 *
 * Mostly an operational signal — admins running geo-targeted promos
 * want to see which geographies the affiliate program is actually
 * reaching, and where the referred users live.
 *
 * Country comes from `user.country_code` (ISO-2). NULL collapses to
 * "??" so the chart axis stays full. Lifetime view uses the same
 * COUNT-by-country lens — no special handling needed.
 */

const COUNTRY_LIMIT = 12;

export type AffiliateGeoRow = {
  code: string;
  affiliateCount: number;
  commission: number;
  share: number;
};

export type ReferredGeoRow = {
  code: string;
  referredUserCount: number;
  downstreamWager: number;
  share: number;
};

export type AffiliateGeoBreakdown = {
  affiliateGeo: AffiliateGeoRow[];
  referredGeo: ReferredGeoRow[];
  /** Sum of commission across visible affiliate-side buckets. */
  totalCommission: number;
  /** Sum of downstream wager across visible referred-side buckets. */
  totalDownstreamWager: number;
};

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<AffiliateGeoBreakdown> {
  const db = await getReadDrizzleDb();
  const ctx = makePeriodCtx(period);
  const ltDate = ctx.dateFilterFor("lt.created_at");
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  const [affRows, refRows] = await Promise.all([
    queryRows<
      { code: string; affiliates: string; commission: string }[]
    >(db, sql`
      SELECT
        COALESCE(u.country_code, '??') AS code,
        COUNT(DISTINCT lt.user_id)::text AS affiliates,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS commission
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${ltDate}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
    queryRows<
      { code: string; referred_users: string; wager: string }[]
    >(db, sql`
      SELECT
        COALESCE(u.country_code, '??') AS code,
        COUNT(DISTINCT acu.referred_user_id)::text AS referred_users,
        COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager
      FROM affiliate_code_usages acu
      JOIN "user" u ON u.id = acu.referred_user_id
      WHERE acu.status = 'completed'
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${acuDate}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY SUM(acu.wager_amount_usd::numeric) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
  ]);

  const totalCommission = affRows.reduce((a, r) => a + toNumber(r.commission), 0);
  const totalDownstreamWager = refRows.reduce(
    (a, r) => a + toNumber(r.wager),
    0,
  );

  return {
    affiliateGeo: affRows.map((r) => {
      const commission = toNumber(r.commission);
      return {
        code: r.code,
        affiliateCount: Number(r.affiliates),
        commission,
        share: totalCommission > 0 ? (commission / totalCommission) * 100 : 0,
      };
    }),
    referredGeo: refRows.map((r) => {
      const wager = toNumber(r.wager);
      return {
        code: r.code,
        referredUserCount: Number(r.referred_users),
        downstreamWager: wager,
        share:
          totalDownstreamWager > 0 ? (wager / totalDownstreamWager) * 100 : 0,
      };
    }),
    totalCommission,
    totalDownstreamWager,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-geo-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-geo-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateGeoBreakdown(
  period: InsightsRewardsPeriod,
): Promise<AffiliateGeoBreakdown> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedLong(period, blacklist)
    : cachedShort(period, blacklist);
}
