import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { WAGER_TYPES_SQL } from "@/lib/queries/_wager-payout-types";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Signup source attribution for /insights/rewards/signup.
 *
 * Two lenses, both keyed on the same in-window signup cohort:
 *
 *   1. PROVIDER — auth `account.providerId` (Discord, Google, …).
 *      One row per provider with: signups, claimants, claim rate,
 *      avg cost per claim, claim volume, 7d retention.
 *
 *   2. AFFILIATE — the affiliate code the user signed up through,
 *      taken from `user.affiliate_code` at signup (NOT current — the
 *      column captures the code applied at the signup step). One row
 *      per affiliate code with: signups, claimants, claim rate, avg
 *      cost, claim volume. "Direct" (NULL code) is the catch-all
 *      bucket.
 *
 * Provider distribution uses the user's PRIMARY (earliest created_at)
 * account row when there are multiple — matches the per-category
 * helper in `rewards-category-extras.ts`. "unknown" catches users
 * with no account row (legacy bootstrap rows, edge-case migrations).
 *
 * Affiliate codes are returned with their `affiliate_codes.code`
 * label when joinable. Code rows whose owner is staff are not
 * filtered here — the cohort is filtered upstream by ROLE, so the
 * affiliate cut is purely a referrer attribution.
 *
 * Top 15 codes by signup count (anything below 15 collapses into an
 * "Other codes" bucket to keep the chart legible without losing the
 * tail volume).
 */

export type SignupSourceRow = {
  key: string;
  /** Pretty label for the UI. */
  label: string;
  signups: number;
  claimants: number;
  /** Share of signups that claimed (0–1). */
  claimRate: number;
  /** Sum of ABS(amount) for cohort `balance_reward_claim` rows from this source. */
  totalCost: number;
  /** Avg of ABS(amount) per claim for this source. */
  avgPerClaim: number;
  /**
   * Share of this source's cohort retained at 7 days (had any wager
   * or deposit within 7 days of signup). Null when signups === 0.
   */
  retention7dShare: number | null;
};

export type SignupSourceBreakdown = {
  providers: SignupSourceRow[];
  affiliates: SignupSourceRow[];
  /** Total cohort signups in the window (shared denominator). */
  totalSignups: number;
};

async function computeSourceBreakdown(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<SignupSourceBreakdown> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter =
    days !== null
      ? `AND u.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // ── Provider breakdown ────────────────────────────────────────────
  // One CTE per stage so the final SELECT can pivot on
  // primary_provider.provider. Provider == "unknown" fallback catches
  // users with no account row (legacy / migration cases).
  type ProviderRow = {
    provider: string;
    signups: string;
    claimants: string;
    total_cost: string;
    retained_7d: string;
  };
  const providerRows = await db.$queryRawUnsafe<ProviderRow[]>(`
    WITH cohort AS (
      SELECT u.id AS user_id, u.created_at AS signed_up_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    primary_provider AS (
      SELECT DISTINCT ON (a."userId")
        a."userId" AS user_id,
        a."providerId" AS provider
      FROM account a
      JOIN cohort c ON c.user_id = a."userId"
      ORDER BY a."userId", a.created_at ASC NULLS LAST
    ),
    cohort_with_provider AS (
      SELECT
        c.user_id,
        c.signed_up_at,
        COALESCE(pp.provider, 'unknown') AS provider
      FROM cohort c
      LEFT JOIN primary_provider pp ON pp.user_id = c.user_id
    ),
    claim_users AS (
      SELECT DISTINCT cwp.user_id, cwp.provider
      FROM cohort_with_provider cwp
      JOIN ledger_transactions lt
        ON lt.user_id = cwp.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    ),
    claim_cost AS (
      SELECT cwp.provider, SUM(ABS(lt.amount::numeric)) AS total_cost
      FROM cohort_with_provider cwp
      JOIN ledger_transactions lt
        ON lt.user_id = cwp.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
      GROUP BY cwp.provider
    ),
    retained_7d AS (
      SELECT cwp.provider, COUNT(DISTINCT cwp.user_id) AS retained
      FROM cohort_with_provider cwp
      WHERE EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = cwp.user_id
          AND lt.status = 'completed'
          AND (lt.type::text = 'deposit' OR lt.type::text IN ${WAGER_TYPES_SQL})
          AND lt.created_at <= cwp.signed_up_at + INTERVAL '7 days'
      )
      GROUP BY cwp.provider
    )
    SELECT
      cwp.provider,
      COUNT(*)::text AS signups,
      (SELECT COUNT(*) FROM claim_users cu WHERE cu.provider = cwp.provider)::text AS claimants,
      COALESCE((SELECT total_cost FROM claim_cost cc WHERE cc.provider = cwp.provider), 0)::text AS total_cost,
      COALESCE((SELECT retained FROM retained_7d rt WHERE rt.provider = cwp.provider), 0)::text AS retained_7d
    FROM cohort_with_provider cwp
    GROUP BY cwp.provider
    ORDER BY COUNT(*) DESC
  `);

  const totalSignups = providerRows.reduce(
    (a, r) => a + Number(r.signups),
    0,
  );

  const providers: SignupSourceRow[] = providerRows.map((r) => {
    const signups = Number(r.signups);
    const claimants = Number(r.claimants);
    const totalCost = toNumber(r.total_cost);
    const retained7d = Number(r.retained_7d);
    return {
      key: r.provider,
      label: r.provider,
      signups,
      claimants,
      claimRate: signups > 0 ? claimants / signups : 0,
      totalCost,
      avgPerClaim: claimants > 0 ? totalCost / claimants : 0,
      retention7dShare: signups > 0 ? retained7d / signups : null,
    };
  });

  // ── Affiliate breakdown ────────────────────────────────────────────
  // `user.affiliate_code` carries the affiliate text-code at signup
  // time. We left-join to `affiliate_codes` for the owner relation if
  // the code still exists; otherwise we keep the raw code text. NULL
  // (or empty) code → "Direct" bucket.
  type AffiliateRow = {
    code: string;
    signups: string;
    claimants: string;
    total_cost: string;
    retained_7d: string;
  };
  const affiliateRows = await db.$queryRawUnsafe<AffiliateRow[]>(`
    WITH cohort AS (
      SELECT u.id AS user_id, u.created_at AS signed_up_at,
             NULLIF(u.affiliate_code, '') AS affiliate_code
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    cohort_with_code AS (
      SELECT
        c.user_id,
        c.signed_up_at,
        COALESCE(c.affiliate_code, '__direct__') AS code
      FROM cohort c
    ),
    claim_users AS (
      SELECT DISTINCT cwc.user_id, cwc.code
      FROM cohort_with_code cwc
      JOIN ledger_transactions lt
        ON lt.user_id = cwc.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    ),
    claim_cost AS (
      SELECT cwc.code, SUM(ABS(lt.amount::numeric)) AS total_cost
      FROM cohort_with_code cwc
      JOIN ledger_transactions lt
        ON lt.user_id = cwc.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
      GROUP BY cwc.code
    ),
    retained_7d AS (
      SELECT cwc.code, COUNT(DISTINCT cwc.user_id) AS retained
      FROM cohort_with_code cwc
      WHERE EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = cwc.user_id
          AND lt.status = 'completed'
          AND (lt.type::text = 'deposit' OR lt.type::text IN ${WAGER_TYPES_SQL})
          AND lt.created_at <= cwc.signed_up_at + INTERVAL '7 days'
      )
      GROUP BY cwc.code
    )
    SELECT
      cwc.code,
      COUNT(*)::text AS signups,
      (SELECT COUNT(*) FROM claim_users cu WHERE cu.code = cwc.code)::text AS claimants,
      COALESCE((SELECT total_cost FROM claim_cost cc WHERE cc.code = cwc.code), 0)::text AS total_cost,
      COALESCE((SELECT retained FROM retained_7d rt WHERE rt.code = cwc.code), 0)::text AS retained_7d
    FROM cohort_with_code cwc
    GROUP BY cwc.code
    ORDER BY COUNT(*) DESC
    LIMIT 100
  `);

  // Top 15 by signup count + collapse the tail into "Other codes".
  const TOP_LIMIT = 15;
  const top = affiliateRows.slice(0, TOP_LIMIT);
  const tail = affiliateRows.slice(TOP_LIMIT);

  const buildRow = (r: AffiliateRow): SignupSourceRow => {
    const signups = Number(r.signups);
    const claimants = Number(r.claimants);
    const totalCost = toNumber(r.total_cost);
    const retained7d = Number(r.retained_7d);
    const code = r.code === "__direct__" ? "Direct" : r.code;
    return {
      key: r.code,
      label: code,
      signups,
      claimants,
      claimRate: signups > 0 ? claimants / signups : 0,
      totalCost,
      avgPerClaim: claimants > 0 ? totalCost / claimants : 0,
      retention7dShare: signups > 0 ? retained7d / signups : null,
    };
  };

  const affiliates: SignupSourceRow[] = top.map(buildRow);
  if (tail.length > 0) {
    const tailSignups = tail.reduce((a, r) => a + Number(r.signups), 0);
    const tailClaimants = tail.reduce((a, r) => a + Number(r.claimants), 0);
    const tailCost = tail.reduce((a, r) => a + toNumber(r.total_cost), 0);
    const tailRetained = tail.reduce(
      (a, r) => a + Number(r.retained_7d),
      0,
    );
    affiliates.push({
      key: "__other__",
      label: `Other codes (${tail.length})`,
      signups: tailSignups,
      claimants: tailClaimants,
      claimRate: tailSignups > 0 ? tailClaimants / tailSignups : 0,
      totalCost: tailCost,
      avgPerClaim: tailClaimants > 0 ? tailCost / tailClaimants : 0,
      retention7dShare: tailSignups > 0 ? tailRetained / tailSignups : null,
    });
  }

  return { providers, affiliates, totalSignups };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeSourceBreakdown(period, blacklistIds),
  ["insights-rewards-signup-source-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeSourceBreakdown(period, blacklistIds),
  ["insights-rewards-signup-source-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupSourceBreakdown(
  period: InsightsRewardsPeriod,
): Promise<SignupSourceBreakdown> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
