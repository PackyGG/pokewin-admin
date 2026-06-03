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
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * First-deposit cohort comparison for /insights/rewards/signup.
 *
 * Splits the in-window signup cohort by whether the user claimed at
 * least one `balance_reward_claim` (claimer) or not (non-claimer),
 * then for each cut computes:
 *
 *   - users  — count with at least one `deposit` ledger row
 *   - avgFirstDeposit — average of the FIRST deposit amount per user
 *   - medianFirstDeposit — median of the FIRST deposit amount per user
 *   - totalFirstDeposit — sum of FIRST deposit amounts per user
 *
 * Lift % = (claimer avg − non-claimer avg) / non-claimer avg —
 * answers "do claimers deposit larger than non-claimers".
 *
 * Buckets the first deposit into 5 amount buckets ($0–$10, $10–$50,
 * $50–$100, $100–$500, $500+) for the distribution chart on the tab —
 * lets the admin see whether the claimer cut is concentrated in a
 * higher amount band, not just whether the avg is higher.
 */

export type FirstDepositCohortBucket = {
  label: string;
  edgeUsd: number;
  claimerCount: number;
  nonClaimerCount: number;
};

export type FirstDepositCohort = {
  claimers: {
    users: number;
    avg: number;
    median: number;
    total: number;
  };
  nonClaimers: {
    users: number;
    avg: number;
    median: number;
    total: number;
  };
  /** % lift of claimer avg over non-claimer avg. null when non-claimer = 0. */
  liftPct: number | null;
  buckets: FirstDepositCohortBucket[];
};

const BUCKETS: Array<{ label: string; edge: number }> = [
  { label: "≤$10", edge: 10 },
  { label: "$10–$50", edge: 50 },
  { label: "$50–$100", edge: 100 },
  { label: "$100–$500", edge: 500 },
  { label: "$500+", edge: Number.POSITIVE_INFINITY },
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function computeFirstDeposit(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<FirstDepositCohort> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter =
    days !== null
      ? `AND u.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  type Row = {
    had_claim: number;
    first_deposit_usd: string;
  };
  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH cohort AS (
      SELECT u.id AS user_id
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    claim_users AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    ),
    first_deposit AS (
      SELECT DISTINCT ON (c.user_id)
        c.user_id,
        ABS(lt.amount::numeric) AS amount
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'deposit'
      ORDER BY c.user_id, lt.created_at ASC
    )
    SELECT
      CASE WHEN cu.user_id IS NULL THEN 0 ELSE 1 END AS had_claim,
      fd.amount::text AS first_deposit_usd
    FROM first_deposit fd
    LEFT JOIN claim_users cu ON cu.user_id = fd.user_id
  `);

  const claimerFD: number[] = [];
  const nonClaimerFD: number[] = [];
  const buckets: FirstDepositCohortBucket[] = BUCKETS.map((b) => ({
    label: b.label,
    edgeUsd: b.edge,
    claimerCount: 0,
    nonClaimerCount: 0,
  }));

  for (const r of rows) {
    const amt = toNumber(r.first_deposit_usd);
    const hadClaim = Number(r.had_claim) === 1;
    if (hadClaim) claimerFD.push(amt);
    else nonClaimerFD.push(amt);
    for (let i = 0; i < buckets.length; i++) {
      if (amt <= buckets[i].edgeUsd) {
        if (hadClaim) buckets[i].claimerCount += 1;
        else buckets[i].nonClaimerCount += 1;
        break;
      }
    }
  }

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const claimers = {
    users: claimerFD.length,
    avg: claimerFD.length > 0 ? sum(claimerFD) / claimerFD.length : 0,
    median: median(claimerFD),
    total: sum(claimerFD),
  };
  const nonClaimers = {
    users: nonClaimerFD.length,
    avg: nonClaimerFD.length > 0 ? sum(nonClaimerFD) / nonClaimerFD.length : 0,
    median: median(nonClaimerFD),
    total: sum(nonClaimerFD),
  };
  const liftPct =
    nonClaimers.avg > 0
      ? ((claimers.avg - nonClaimers.avg) / nonClaimers.avg) * 100
      : null;

  return { claimers, nonClaimers, liftPct, buckets };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeFirstDeposit(period, blacklistIds),
  ["insights-rewards-signup-first-deposit-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeFirstDeposit(period, blacklistIds),
  ["insights-rewards-signup-first-deposit-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupFirstDeposit(
  period: InsightsRewardsPeriod,
): Promise<FirstDepositCohort> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
