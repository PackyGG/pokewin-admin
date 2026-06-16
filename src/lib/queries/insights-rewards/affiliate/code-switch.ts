import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import {
  type InsightsRewardsPeriod,
} from "../_period";
import { CACHE_TAG, loadBlacklist, makePeriodCtx } from "./_shared";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getAffiliateCodeSwitchFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/affiliate/code-switch";

/**
 * Code-switch correlation lens.
 *
 * Some affiliates' referred users disproportionately switch to OTHER
 * affiliate codes after their initial code use. This can signal:
 *
 *   - Aggressive snipers in that affiliate's cohort (users who chase
 *     every bonus and rotate codes constantly).
 *   - Poor onboarding (the affiliate's pitch isn't sticky — users
 *     wander to whichever code a competitor offers them).
 *   - Code retirement (an old code's users naturally migrating to
 *     newer codes after promo changes).
 *
 * Method:
 *   For each referred_user_id with usage rows in the window, count the
 *   number of DISTINCT codes they used in their lifetime
 *   (affiliate_code_usages.code). Group by their FIRST affiliate
 *   (the affiliate_user_id of their earliest usage row). For each
 *   first-affiliate, report:
 *     - cohort size in window
 *     - users who used ≥2 different codes in their lifetime
 *     - users whose latest code differs from their first code
 *     - share of cohort that switched away
 *
 * The "first affiliate" attribution uses earliest `created_at` per
 * referred_user_id, which is what the platform uses for affiliate
 * accounting. Top 25 first-affiliates by switching share so the page
 * highlights the affiliates with the highest churn signal.
 *
 * Switching share is bucketed so a small-cohort affiliate doesn't
 * outrank a large-cohort one purely by noise. We require cohort ≥ 5
 * to be ranked.
 */

const COHORT_MIN_USERS = 5;
const ROW_LIMIT = 25;

export type CodeSwitchRow = {
  affiliateUserId: string;
  username: string | null;
  /** Distinct referred users with first usage attributed to this affiliate, active in window. */
  cohortSize: number;
  /** Users in the cohort with ≥2 distinct codes used in their lifetime. */
  switchersAny: number;
  /** Users in the cohort whose LATEST code != first code. */
  switchersAway: number;
  /** switchersAway / cohortSize. */
  switchAwayShare: number;
  /** switchersAny / cohortSize. */
  multiCodeShare: number;
};

async function compute(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<CodeSwitchRow[]> {
  const db = await getDb();
  const ctx = makePeriodCtx(period);
  const acuDate = ctx.dateFilterFor("acu.created_at");
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  const rows = await db.$queryRawUnsafe<
    {
      first_affiliate_user_id: string;
      username: string | null;
      cohort_size: string;
      switchers_any: string;
      switchers_away: string;
    }[]
  >(`
    WITH active_referred AS (
      SELECT DISTINCT acu.referred_user_id
      FROM affiliate_code_usages acu
      WHERE acu.status = 'completed'
        ${acuDate}
    ),
    per_user AS (
      SELECT
        ar.referred_user_id,
        (
          SELECT acu.affiliate_user_id
          FROM affiliate_code_usages acu
          WHERE acu.referred_user_id = ar.referred_user_id
            AND acu.status = 'completed'
          ORDER BY acu.created_at ASC
          LIMIT 1
        ) AS first_affiliate_user_id,
        (
          SELECT acu.code
          FROM affiliate_code_usages acu
          WHERE acu.referred_user_id = ar.referred_user_id
            AND acu.status = 'completed'
          ORDER BY acu.created_at ASC
          LIMIT 1
        ) AS first_code,
        (
          SELECT acu.code
          FROM affiliate_code_usages acu
          WHERE acu.referred_user_id = ar.referred_user_id
            AND acu.status = 'completed'
          ORDER BY acu.created_at DESC
          LIMIT 1
        ) AS last_code,
        (
          SELECT COUNT(DISTINCT acu.code)
          FROM affiliate_code_usages acu
          WHERE acu.referred_user_id = ar.referred_user_id
            AND acu.status = 'completed'
        ) AS distinct_codes
      FROM active_referred ar
    ),
    grouped AS (
      SELECT
        first_affiliate_user_id,
        COUNT(*) AS cohort_size,
        COUNT(*) FILTER (WHERE distinct_codes >= 2) AS switchers_any,
        COUNT(*) FILTER (WHERE first_code IS DISTINCT FROM last_code) AS switchers_away
      FROM per_user
      WHERE first_affiliate_user_id IS NOT NULL
      GROUP BY first_affiliate_user_id
    )
    SELECT
      g.first_affiliate_user_id,
      u.username,
      g.cohort_size::text AS cohort_size,
      g.switchers_any::text AS switchers_any,
      g.switchers_away::text AS switchers_away
    FROM grouped g
    JOIN "user" u ON u.id = g.first_affiliate_user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      AND g.cohort_size >= ${COHORT_MIN_USERS}
    ORDER BY (g.switchers_away::numeric / NULLIF(g.cohort_size, 0)) DESC NULLS LAST,
             g.cohort_size DESC
    LIMIT ${ROW_LIMIT}
  `);

  return rows.map((r) => {
    const cohortSize = Number(r.cohort_size);
    const switchersAny = Number(r.switchers_any);
    const switchersAway = Number(r.switchers_away);
    return {
      affiliateUserId: r.first_affiliate_user_id,
      username: r.username,
      cohortSize,
      switchersAny,
      switchersAway,
      switchAwayShare: cohortSize > 0 ? switchersAway / cohortSize : 0,
      multiCodeShare: cohortSize > 0 ? switchersAny / cohortSize : 0,
    };
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-code-switch-v1-short"],
  { revalidate: 60, tags: [CACHE_TAG, "rewards-analytics"] },
);
const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    compute(period, blacklistIds),
  ["insights-affiliate-code-switch-v1-long"],
  { revalidate: 300, tags: [CACHE_TAG, "rewards-analytics"] },
);

export async function getAffiliateCodeSwitch(
  period: InsightsRewardsPeriod,
): Promise<CodeSwitchRow[]> {
  const blacklist = await loadBlacklist();
  return resolveAdminRead<CodeSwitchRow[]>("insights_affiliate_code_switch", {
    pg: () =>
      period === "all"
        ? cachedLong(period, blacklist)
        : cachedShort(period, blacklist),
    ch: () =>
      getAffiliateCodeSwitchFromClickHouse(period, blacklist, new Date()),
  });
}

export const AFFILIATE_CODE_SWITCH_MIN_COHORT = COHORT_MIN_USERS;
