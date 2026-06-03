import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { WAGER_TYPES_SQL } from "@/lib/queries/_wager-payout-types";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Weekly cohort retention matrix for /insights/rewards/signup.
 *
 * For each ISO-week signup cohort inside the window, returns:
 *
 *   - week              — Monday-anchored cohort week label (YYYY-MM-DD)
 *   - signups           — cohort size
 *   - claimers          — cohort users with ≥1 balance_reward_claim
 *   - claimRate         — claimers / signups
 *   - retained30dShare  — cohort share with any wager/deposit ≤ signup_at + 30d
 *   - claimerRetained30dShare    — same lens, claimer cut
 *   - nonClaimerRetained30dShare — same lens, non-claimer cut
 *
 * Reads as a single chart row per week — admins compare cohort cohorts
 * over time + see whether the bonus-claiming cohort retains better
 * (the lift in the per-cut shares).
 *
 * Implementation note: every retention test is a 30-day window after
 * signup. For cohorts < 30 days old at query time, the share gets
 * suppressed in the UI (incomplete window). The query still returns
 * the value — the page handles the truncation render.
 *
 * Caps the matrix at the last ~52 weeks (1 year) so a "lifetime"
 * period doesn't blow up into 200+ rows.
 */

export type CohortMatrixRow = {
  /** ISO week start (Mon-anchored, YYYY-MM-DD). */
  week: string;
  signups: number;
  claimers: number;
  claimRate: number;
  retained30d: number;
  retained30dShare: number;
  claimerRetained30d: number;
  claimerRetained30dShare: number;
  nonClaimerRetained30d: number;
  nonClaimerRetained30dShare: number;
  /**
   * True when the cohort's signup week is older than `now - 30d` —
   * the 30d retention window has fully elapsed, the numbers are
   * comparable. False = still incomplete.
   */
  retentionWindowComplete: boolean;
};

async function computeCohortMatrix(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<CohortMatrixRow[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  // Cap at 52 weeks even for "lifetime" so the matrix is readable.
  const weeksBack = days !== null ? Math.ceil(days / 7) : 52;
  const dateFilter = `AND u.created_at >= NOW() - INTERVAL '${weeksBack * 7} days'`;
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  type Row = {
    week: Date;
    signups: string;
    claimers: string;
    retained_30d: string;
    claimer_retained_30d: string;
    non_claimer_retained_30d: string;
    non_claimers: string;
  };

  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH cohort AS (
      SELECT
        u.id AS user_id,
        u.created_at AS signed_up_at,
        DATE_TRUNC('week', u.created_at)::date AS week
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    ),
    claim_users AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    ),
    retention_flags AS (
      SELECT
        c.user_id,
        c.week,
        c.signed_up_at,
        CASE WHEN cu.user_id IS NULL THEN 0 ELSE 1 END AS had_claim,
        CASE WHEN EXISTS (
          SELECT 1 FROM ledger_transactions lt
          WHERE lt.user_id = c.user_id
            AND lt.status = 'completed'
            AND (lt.type::text = 'deposit' OR lt.type::text IN ${WAGER_TYPES_SQL})
            AND lt.created_at <= c.signed_up_at + INTERVAL '30 days'
        ) THEN 1 ELSE 0 END AS retained_30d
      FROM cohort c
      LEFT JOIN claim_users cu ON cu.user_id = c.user_id
    )
    SELECT
      week,
      COUNT(*)::text AS signups,
      SUM(had_claim)::text AS claimers,
      SUM(retained_30d)::text AS retained_30d,
      SUM(CASE WHEN had_claim = 1 AND retained_30d = 1 THEN 1 ELSE 0 END)::text AS claimer_retained_30d,
      SUM(CASE WHEN had_claim = 0 AND retained_30d = 1 THEN 1 ELSE 0 END)::text AS non_claimer_retained_30d,
      SUM(CASE WHEN had_claim = 0 THEN 1 ELSE 0 END)::text AS non_claimers
    FROM retention_flags
    GROUP BY week
    ORDER BY week ASC
  `);

  // PostgreSQL DATE_TRUNC('week', …) anchors to Monday, so the week
  // label is the cohort's Monday in YYYY-MM-DD. JS Date conversion +
  // toISOString().split("T")[0] keeps it UTC.
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  return rows.map((r) => {
    const signups = Number(r.signups);
    const claimers = Number(r.claimers);
    const nonClaimers = Number(r.non_claimers);
    const retained30d = Number(r.retained_30d);
    const claimerRetained30d = Number(r.claimer_retained_30d);
    const nonClaimerRetained30d = Number(r.non_claimer_retained_30d);
    const weekStart = new Date(r.week);
    const retentionWindowComplete =
      now - weekStart.getTime() > THIRTY_DAYS_MS;
    return {
      week: weekStart.toISOString().split("T")[0],
      signups,
      claimers,
      claimRate: signups > 0 ? claimers / signups : 0,
      retained30d,
      retained30dShare: signups > 0 ? retained30d / signups : 0,
      claimerRetained30d,
      claimerRetained30dShare:
        claimers > 0 ? claimerRetained30d / claimers : 0,
      nonClaimerRetained30d,
      nonClaimerRetained30dShare:
        nonClaimers > 0 ? nonClaimerRetained30d / nonClaimers : 0,
      retentionWindowComplete,
    };
  });
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCohortMatrix(period, blacklistIds),
  ["insights-rewards-signup-cohort-matrix-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCohortMatrix(period, blacklistIds),
  ["insights-rewards-signup-cohort-matrix-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupCohortMatrix(
  period: InsightsRewardsPeriod,
): Promise<CohortMatrixRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
