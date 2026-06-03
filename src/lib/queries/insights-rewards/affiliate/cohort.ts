import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";

/**
 * Referred-user cohort metrics. For each top affiliate by downstream
 * wager in the period, we surface the basics of their cohort:
 *
 *   - Count of distinct referred users active in window (had at least
 *     one usage row).
 *   - Avg wager per referred user in window.
 *   - First-deposit conversion (referred users who deposited at least
 *     once after referral).
 *   - Repeat-deposit conversion (≥2 deposits).
 *   - Avg first-deposit USD.
 *
 * Lift / control comparison (claimants vs non-affiliate-users) is
 * PROPOSED for a future pass — it's a heavy cross-cohort sweep that
 * deserves its own page. Here we focus on the affiliate-cohort lens.
 */

const TOP_AFFILIATES_LIMIT = 15;

export type AffiliateCohortRow = {
  affiliateUserId: string;
  username: string | null;
  /** Referred users active in window (have ≥1 usage row in window). */
  referredActive: number;
  /** Sum of wager across referred users in window. */
  cohortWager: number;
  /** cohortWager / referredActive — avg per active user. */
  avgWagerPerReferred: number;
  /** Cohort with ≥1 deposit since signup (any time, lifetime measure). */
  depositors: number;
  /** Cohort with ≥2 deposits since signup. */
  repeatDepositors: number;
  /** depositors / referredActive — first-deposit conversion. */
  depositConversion: number;
  /** repeatDepositors / referredActive — repeat-deposit share. */
  repeatConversion: number;
  /** Avg first-deposit USD across depositors in cohort. */
  avgFirstDepositUsd: number;
};

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<AffiliateCohortRow[]> {
  const db = await getDb();
  const ctx = makePeriodCtx(period);
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Step 1 — identify top N affiliates by referred-user wager in window.
  const topAffiliates = await db.$queryRawUnsafe<
    { affiliate_user_id: string }[]
  >(`
    SELECT acu.affiliate_user_id
    FROM affiliate_code_usages acu
    JOIN "user" u ON u.id = acu.affiliate_user_id
    WHERE acu.status = 'completed'
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${acuDate}
    GROUP BY acu.affiliate_user_id
    HAVING SUM(acu.wager_amount_usd::numeric) > 0
    ORDER BY SUM(acu.wager_amount_usd::numeric) DESC
    LIMIT ${TOP_AFFILIATES_LIMIT}
  `);
  if (topAffiliates.length === 0) return [];

  // Inline-quote the affiliate id list — safe because it came from our
  // own DB query above (already an array of strings).
  const affiliateIdsSql = `(${topAffiliates
    .map((a) => `'${a.affiliate_user_id.replace(/'/g, "''")}'`)
    .join(",")})`;

  // Step 2 — aggregate per-affiliate cohort metrics.
  const rows = await db.$queryRawUnsafe<
    {
      affiliate_user_id: string;
      username: string | null;
      referred_active: string;
      cohort_wager: string;
      depositors: string;
      repeat_depositors: string;
      avg_first_deposit: string;
    }[]
  >(`
    WITH cohort AS (
      SELECT DISTINCT
        acu.affiliate_user_id,
        acu.referred_user_id
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        AND acu.affiliate_user_id IN ${affiliateIdsSql}
        ${acuDate}
    ),
    cohort_wager AS (
      SELECT
        acu.affiliate_user_id,
        SUM(acu.wager_amount_usd::numeric) AS wager
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        AND acu.affiliate_user_id IN ${affiliateIdsSql}
        ${acuDate}
      GROUP BY acu.affiliate_user_id
    ),
    deposits_per_user AS (
      SELECT
        c.affiliate_user_id,
        c.referred_user_id,
        COUNT(lt.id) AS deposit_count,
        MIN(ABS(lt.amount::numeric)) FILTER (WHERE lt.amount IS NOT NULL) AS first_deposit_proxy
      FROM cohort c
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = c.referred_user_id
        AND lt.type::text = 'deposit'
        AND lt.status = 'completed'
      GROUP BY c.affiliate_user_id, c.referred_user_id
    ),
    cohort_summary AS (
      SELECT
        d.affiliate_user_id,
        COUNT(DISTINCT d.referred_user_id) AS referred_active,
        COUNT(DISTINCT d.referred_user_id) FILTER (WHERE d.deposit_count >= 1) AS depositors,
        COUNT(DISTINCT d.referred_user_id) FILTER (WHERE d.deposit_count >= 2) AS repeat_depositors,
        AVG(d.first_deposit_proxy) FILTER (WHERE d.deposit_count >= 1) AS avg_first_deposit
      FROM deposits_per_user d
      GROUP BY d.affiliate_user_id
    )
    SELECT
      cs.affiliate_user_id,
      u.username,
      cs.referred_active::text AS referred_active,
      COALESCE(cw.wager, 0)::text AS cohort_wager,
      cs.depositors::text AS depositors,
      cs.repeat_depositors::text AS repeat_depositors,
      COALESCE(cs.avg_first_deposit, 0)::text AS avg_first_deposit
    FROM cohort_summary cs
    JOIN "user" u ON u.id = cs.affiliate_user_id
    LEFT JOIN cohort_wager cw ON cw.affiliate_user_id = cs.affiliate_user_id
    ORDER BY COALESCE(cw.wager, 0) DESC
  `);

  return rows.map((r) => {
    const referredActive = Number(r.referred_active);
    const depositors = Number(r.depositors);
    const repeatDepositors = Number(r.repeat_depositors);
    const cohortWager = toNumber(r.cohort_wager);
    return {
      affiliateUserId: r.affiliate_user_id,
      username: r.username,
      referredActive,
      cohortWager,
      avgWagerPerReferred: referredActive > 0 ? cohortWager / referredActive : 0,
      depositors,
      repeatDepositors,
      depositConversion: referredActive > 0 ? depositors / referredActive : 0,
      repeatConversion: referredActive > 0 ? repeatDepositors / referredActive : 0,
      avgFirstDepositUsd: toNumber(r.avg_first_deposit),
    };
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-cohort-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-cohort-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateCohort(
  period: InsightsRewardsPeriod,
): Promise<AffiliateCohortRow[]> {
  const blacklist = await loadBlacklist();
  return period === "all"
    ? cachedLong(period, blacklist)
    : cachedShort(period, blacklist);
}
