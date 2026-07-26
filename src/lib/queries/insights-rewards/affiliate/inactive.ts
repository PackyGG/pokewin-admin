import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Inactive-affiliate lens. We surface affiliate_accounts rows that
 * historically referred users (total_referred > 0) but had ZERO
 * `affiliate_claim` ledger rows in the active window.
 *
 * Two sub-categories matter operationally:
 *
 *   - Has downstream usage in window, no commission claimed yet
 *     → the affiliate may be earning but not claiming (stored balance).
 *     Or their referred users haven't hit the threshold yet.
 *
 *   - No downstream usage in window either → genuine dormant cohort.
 *     The affiliate isn't bringing in new traffic, the referred users
 *     aren't playing.
 *
 * Per row we include the affiliate's last claim date, last usage date,
 * total referrals (lifetime count from `affiliate_accounts`), and the
 * affiliate's downstream wager / commission accrued in window.
 *
 * Order — surface the highest-value-dormant affiliates first (the ones
 * with the biggest lifetime payouts who suddenly went quiet). Capped
 * at 25 so the page renders cleanly.
 */

const ROW_LIMIT = 25;

export type InactiveAffiliateRow = {
  affiliateUserId: string;
  username: string | null;
  /** Lifetime referred user count from affiliate_accounts.total_referred. */
  totalReferred: number;
  /** Lifetime total paid out so far (denormalised). */
  totalPaidOutLifetime: number;
  /** Last affiliate_claim ledger row date for this affiliate (any time). */
  lastClaimAt: string | null;
  /** Last affiliate_code_usages row date for this affiliate (any time). */
  lastUsageAt: string | null;
  /** Wager attributed to referred cohort IN window. */
  windowDownstreamWager: number;
  /** Whether the cohort had ANY usage in window. */
  hasWindowUsage: boolean;
};

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<InactiveAffiliateRow[]> {
  const db = await getDrizzleDb();
  const ctx = makePeriodCtx(period);
  const ltDate = ctx.dateFilterFor("lt.created_at");
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Approach:
  //   - paid_in_window = affiliate user_ids with an affiliate_claim
  //     ledger row in window.
  //   - aa.total_referred > 0 → has lifetime referrals.
  //   - NOT IN paid_in_window → didn't claim in window.
  //   - Left-join lifetime aggregates for last claim / last usage / in-
  //     window wager.
  //   - Order by lifetime payout DESC so the most-valuable-dormant
  //     affiliates float to the top.
  const rows = await queryRows<
    {
      affiliate_user_id: string;
      username: string | null;
      total_referred: string;
      total_paid_out_lifetime: string;
      last_claim_at: Date | null;
      last_usage_at: Date | null;
      window_wager: string;
      has_window_usage: boolean;
    }[]
  >(db, sql`
    WITH paid_in_window AS (
      SELECT DISTINCT lt.user_id
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
        ${ltDate}
    ),
    lifetime_claim AS (
      SELECT lt.user_id, MAX(lt.created_at) AS last_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'affiliate_claim'
      GROUP BY lt.user_id
    ),
    lifetime_usage AS (
      SELECT acu.affiliate_user_id, MAX(acu.created_at) AS last_at
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
      GROUP BY acu.affiliate_user_id
    ),
    window_usage AS (
      SELECT
        acu.affiliate_user_id,
        SUM(acu.wager_amount_usd::numeric) AS wager
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        ${acuDate}
      GROUP BY acu.affiliate_user_id
    )
    SELECT
      aa.user_id AS affiliate_user_id,
      u.username,
      aa.total_referred::text AS total_referred,
      aa.total_paid_out_usd::text AS total_paid_out_lifetime,
      lc.last_at AS last_claim_at,
      lu.last_at AS last_usage_at,
      COALESCE(wu.wager, 0)::text AS window_wager,
      (wu.affiliate_user_id IS NOT NULL) AS has_window_usage
    FROM affiliate_accounts aa
    JOIN "user" u ON u.id = aa.user_id
    LEFT JOIN lifetime_claim lc ON lc.user_id = aa.user_id
    LEFT JOIN lifetime_usage lu ON lu.affiliate_user_id = aa.user_id
    LEFT JOIN window_usage wu ON wu.affiliate_user_id = aa.user_id
    WHERE aa.total_referred > 0
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      AND aa.user_id NOT IN (SELECT user_id FROM paid_in_window)
    ORDER BY aa.total_paid_out_usd DESC, aa.total_referred DESC
    LIMIT ${ROW_LIMIT}
  `);

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    totalReferred: Number(r.total_referred),
    totalPaidOutLifetime: toNumber(r.total_paid_out_lifetime),
    lastClaimAt: r.last_claim_at ? new Date(r.last_claim_at).toISOString() : null,
    lastUsageAt: r.last_usage_at ? new Date(r.last_usage_at).toISOString() : null,
    windowDownstreamWager: toNumber(r.window_wager),
    hasWindowUsage: Boolean(r.has_window_usage),
  }));
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-inactive-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-inactive-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getInactiveAffiliates(
  period: InsightsRewardsPeriod,
): Promise<InactiveAffiliateRow[]> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedLong(period, blacklist)
    : cachedShort(period, blacklist);
}
