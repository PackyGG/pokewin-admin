import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Top 25 rakeback claimers. Two flavours:
 *
 *   - scope = "period"    top by rakeback claimed in current window
 *   - scope = "lifetime"  top by all-time rakeback claimed (period
 *                         filter dropped — handy for an admin who
 *                         wants the absolute leaderboard regardless
 *                         of the page's current period selector)
 *
 * Each row carries:
 *   - userId / username (link target)
 *   - period or lifetime rakeback total
 *   - claim count
 *   - avg per claim
 *   - lifetime rakeback (also returned when scope = period for context)
 *
 * Staff + blacklist excluded.
 */

export type RakebackTopClaimerScope = "period" | "lifetime";

const TOP_LIMIT = 25;

export type RakebackTopClaimer = {
  userId: string;
  username: string | null;
  /** Total $ rakeback claimed in scope (period total OR lifetime). */
  totalRakeback: number;
  /** Claim count in scope. */
  claimCount: number;
  /** Avg per claim in scope. */
  avgPerClaim: number;
  /** Lifetime $ rakeback for context — always all-time regardless of scope. */
  lifetimeRakeback: number;
};

async function computeTopClaimers(
  period: InsightsRewardsPeriod,
  scope: RakebackTopClaimerScope,
  blacklistIds: string[],
): Promise<RakebackTopClaimer[]> {
  const db = await getDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);
  const scopeDateFilter = daysAgoFilter(
    "rc.claimed_at",
    scope === "period" ? days : null,
  );

  // First slice (scope window) drives the ORDER BY and the LIMIT.
  // The lifetime sum is a JOIN against the same table without a date
  // filter to give context. Both sides share the staff/blacklist join.
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      total_rakeback: string;
      claim_count: string;
      lifetime_rakeback: string;
    }[]
  >(db, sql`
    WITH scoped AS (
      SELECT
        rc.user_id,
        SUM(rc.rakeback_amount_usd::numeric) AS total_rakeback,
        COUNT(*) AS claim_count
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${scopeDateFilter}
      GROUP BY rc.user_id
      ORDER BY SUM(rc.rakeback_amount_usd::numeric) DESC
      LIMIT ${TOP_LIMIT}
    ),
    lifetime AS (
      SELECT
        rc.user_id,
        SUM(rc.rakeback_amount_usd::numeric) AS lifetime_rakeback
      FROM rakeback_claims rc
      WHERE rc.claimed_at IS NOT NULL
        AND rc.user_id IN (SELECT user_id FROM scoped)
      GROUP BY rc.user_id
    )
    SELECT
      s.user_id,
      u.username,
      s.total_rakeback::text AS total_rakeback,
      s.claim_count::text AS claim_count,
      COALESCE(l.lifetime_rakeback, 0)::text AS lifetime_rakeback
    FROM scoped s
    JOIN "user" u ON u.id = s.user_id
    LEFT JOIN lifetime l ON l.user_id = s.user_id
    ORDER BY s.total_rakeback DESC
  `);

  return rows.map((r) => {
    const total = toNumber(r.total_rakeback);
    const count = Number(r.claim_count);
    return {
      userId: r.user_id,
      username: r.username,
      totalRakeback: total,
      claimCount: count,
      avgPerClaim: count > 0 ? total / count : 0,
      lifetimeRakeback: toNumber(r.lifetime_rakeback),
    };
  });
}

const cachedShort = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    scope: RakebackTopClaimerScope,
    blacklistIds: string[],
  ) => computeTopClaimers(period, scope, blacklistIds),
  ["insights-rewards-rakeback-top-claimers-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    scope: RakebackTopClaimerScope,
    blacklistIds: string[],
  ) => computeTopClaimers(period, scope, blacklistIds),
  ["insights-rewards-rakeback-top-claimers-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackTopClaimers(
  period: InsightsRewardsPeriod,
  scope: RakebackTopClaimerScope = "period",
): Promise<RakebackTopClaimer[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300 || scope === "lifetime"
    ? cachedLong(period, scope, sorted)
    : cachedShort(period, scope, sorted);
}

export function parseRakebackTopClaimerScope(
  raw: string | undefined,
): RakebackTopClaimerScope {
  return raw === "lifetime" ? "lifetime" : "period";
}
