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
 * Time-to-claim distribution for /insights/rewards/signup.
 *
 * For every cohort user that claimed at least one `balance_reward_claim`,
 * compute the gap between signup and their FIRST claim. Return:
 *
 *   - median + p25 + p75 + p95 hours-to-claim
 *   - cumulative shares: claimed in 1h / 1d / 7d / 30d / ever
 *   - log-scale-friendly histogram buckets so an admin can see whether
 *     the cohort skews "minutes" or "days"
 *   - the count of cohort users who NEVER claimed (drop-off bucket)
 *
 * Histogram buckets (right-edge inclusive):
 *   ≤ 1 min, ≤ 5 min, ≤ 30 min, ≤ 1 h, ≤ 6 h, ≤ 24 h, ≤ 3 d,
 *   ≤ 7 d, ≤ 30 d, > 30 d
 *
 * Buckets are intentionally non-uniform so the "instant claim" cohort
 * (sub-minute) doesn't get smeared into the "claimed within a day"
 * cohort. The wider tail (3d / 7d / 30d / 30d+) catches lagging
 * claimers without inflating the bucket count.
 */

export type TimeToClaimBucket = {
  label: string;
  count: number;
  /** Right edge in hours. -1 sentinel = "never" bucket (no claim). */
  edgeHours: number;
};

export type TimeToClaim = {
  /** Cohort users that claimed at least once (the histogram denominator). */
  claimants: number;
  /** Cohort users that never claimed — for the "never" bucket / drop-off. */
  neverClaimed: number;
  medianHours: number;
  p25Hours: number;
  p75Hours: number;
  p95Hours: number;
  shareWithin1h: number;
  shareWithin1d: number;
  shareWithin7d: number;
  shareWithin30d: number;
  buckets: TimeToClaimBucket[];
};

const BUCKET_EDGES_HOURS: Array<{ label: string; edge: number }> = [
  { label: "≤1m", edge: 1 / 60 },
  { label: "≤5m", edge: 5 / 60 },
  { label: "≤30m", edge: 30 / 60 },
  { label: "≤1h", edge: 1 },
  { label: "≤6h", edge: 6 },
  { label: "≤24h", edge: 24 },
  { label: "≤3d", edge: 72 },
  { label: "≤7d", edge: 168 },
  { label: "≤30d", edge: 720 },
  { label: ">30d", edge: Number.POSITIVE_INFINITY },
];

async function computeTimeToClaim(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<TimeToClaim> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter =
    days !== null
      ? `AND u.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Pull each claimant's gap hours + the percentile summary in one
  // sweep. The histogram is computed in JS from the raw gap list so
  // the bucket boundaries stay declarative (changing edges doesn't
  // require touching SQL).
  type Row = {
    hours_diff: string;
    p25: string | null;
    p50: string | null;
    p75: string | null;
    p95: string | null;
    total_claimants: string;
  };
  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH cohort AS (
      SELECT u.id AS user_id, u.created_at AS signed_up_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    first_claim AS (
      SELECT
        c.user_id,
        c.signed_up_at,
        MIN(lt.created_at) AS first_claim_at
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type = 'balance_reward_claim'
      GROUP BY c.user_id, c.signed_up_at
    ),
    gap AS (
      SELECT
        EXTRACT(EPOCH FROM (first_claim_at - signed_up_at)) / 3600 AS hours_diff
      FROM first_claim
    ),
    summary AS (
      SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY hours_diff) AS p25,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY hours_diff) AS p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY hours_diff) AS p75,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY hours_diff) AS p95,
        COUNT(*) AS total_claimants
      FROM gap
    )
    SELECT
      g.hours_diff::text AS hours_diff,
      s.p25::text AS p25,
      s.p50::text AS p50,
      s.p75::text AS p75,
      s.p95::text AS p95,
      s.total_claimants::text AS total_claimants
    FROM gap g, summary s
  `);

  // Total cohort signups (for never-claimed denominator).
  const cohortRows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*)::text AS cnt
    FROM "user" u
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${signupDateFilter}
  `);
  const cohortSignups = Number(cohortRows[0]?.cnt ?? 0);

  if (rows.length === 0) {
    return {
      claimants: 0,
      neverClaimed: cohortSignups,
      medianHours: 0,
      p25Hours: 0,
      p75Hours: 0,
      p95Hours: 0,
      shareWithin1h: 0,
      shareWithin1d: 0,
      shareWithin7d: 0,
      shareWithin30d: 0,
      buckets: BUCKET_EDGES_HOURS.map((b) => ({
        label: b.label,
        count: 0,
        edgeHours: b.edge,
      })),
    };
  }

  const claimants = Number(rows[0].total_claimants ?? 0);
  const neverClaimed = Math.max(0, cohortSignups - claimants);
  const medianHours = toNumber(rows[0].p50 ?? "0");
  const p25Hours = toNumber(rows[0].p25 ?? "0");
  const p75Hours = toNumber(rows[0].p75 ?? "0");
  const p95Hours = toNumber(rows[0].p95 ?? "0");

  const buckets: TimeToClaimBucket[] = BUCKET_EDGES_HOURS.map((b) => ({
    label: b.label,
    count: 0,
    edgeHours: b.edge,
  }));
  let within1h = 0;
  let within1d = 0;
  let within7d = 0;
  let within30d = 0;
  for (const r of rows) {
    const h = Number(r.hours_diff);
    if (!Number.isFinite(h) || h < 0) continue;
    if (h <= 1) within1h += 1;
    if (h <= 24) within1d += 1;
    if (h <= 168) within7d += 1;
    if (h <= 720) within30d += 1;
    for (let i = 0; i < buckets.length; i++) {
      if (h <= buckets[i].edgeHours) {
        buckets[i].count += 1;
        break;
      }
    }
  }
  const shareWithin1h = claimants > 0 ? within1h / claimants : 0;
  const shareWithin1d = claimants > 0 ? within1d / claimants : 0;
  const shareWithin7d = claimants > 0 ? within7d / claimants : 0;
  const shareWithin30d = claimants > 0 ? within30d / claimants : 0;

  return {
    claimants,
    neverClaimed,
    medianHours,
    p25Hours,
    p75Hours,
    p95Hours,
    shareWithin1h,
    shareWithin1d,
    shareWithin7d,
    shareWithin30d,
    buckets,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTimeToClaim(period, blacklistIds),
  ["insights-rewards-signup-time-to-claim-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTimeToClaim(period, blacklistIds),
  ["insights-rewards-signup-time-to-claim-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupTimeToClaim(
  period: InsightsRewardsPeriod,
): Promise<TimeToClaim> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
