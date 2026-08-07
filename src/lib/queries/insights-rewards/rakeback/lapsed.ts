import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Lapsed claimants — users who claimed in the PRIOR-equal window but
 * NOT in the current window.
 *
 * For each lapsed user we surface signal columns that help answer
 * "why did they stop":
 *
 *   - priorRakeback       rakeback they earned in the prior window
 *   - currentDeposit      $ deposited in the current window (zero =
 *                         left platform entirely)
 *   - priorDeposit        $ deposited in the prior window (reference)
 *   - currentWager        wager-side gameplay in the current window
 *   - priorWager          wager-side gameplay in the prior window
 *   - lastSeenAt          most recent ledger row in either window
 *
 * Returned as:
 *   - totalLapsedUsers      headline count
 *   - totalLostRakeback     sum of priorRakeback (= "lost claims")
 *   - reasons               three-way breakdown by signal pattern:
 *                           "churned" (no current activity at all)
 *                           "less_active" (still active, less wager)
 *                           "still_active" (similar/more wager, just
 *                            didn't claim — config / UX issue)
 *   - sampleUsers           top 25 by priorRakeback for the detail table
 *
 * Lifetime windows have no prior frame → returns `null`.
 *
 * Source: `rakeback_claims` + `ledger_transactions`. Staff, creators, and blacklist
 * excluded.
 */

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

const TOP_LIMIT = 25;

type RakebackLapsedReason = "churned" | "less_active" | "still_active";

type RakebackLapsedRow = {
  userId: string;
  username: string | null;
  priorRakeback: number;
  priorClaims: number;
  currentDeposit: number;
  priorDeposit: number;
  currentWager: number;
  priorWager: number;
  /** "churned" / "less_active" / "still_active" — see header docs. */
  reason: RakebackLapsedReason;
};

export type RakebackLapsed = {
  totalLapsedUsers: number;
  totalLostRakeback: number;
  reasons: {
    churned: number;
    lessActive: number;
    stillActive: number;
  };
  sampleUsers: RakebackLapsedRow[];
};

async function computeLapsed(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackLapsed | null> {
  const days = daysForInsightsPeriod(period);
  if (days === null) return null;
  const db = await getReadDrizzleDb();
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Single CTE-driven query: identify lapsed users, compute their
  // prior-window rakeback + prior/current wager + prior/current deposit.
  // Limit returned rows to TOP_LIMIT by prior rakeback for the sample
  // table; aggregates use the full set.
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      prior_rakeback: string;
      prior_claims: string;
      current_deposit: string;
      prior_deposit: string;
      current_wager: string;
      prior_wager: string;
    }[]
  >(db, sql`
    WITH current_users AS (
      SELECT DISTINCT rc.user_id
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        AND rc.claimed_at >= NOW() - (${days} * INTERVAL '1 day')
    ),
    prior_lapsed AS (
      SELECT
        rc.user_id,
        SUM(rc.rakeback_amount_usd::numeric) AS prior_rakeback,
        COUNT(*) AS prior_claims
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        AND rc.claimed_at >= NOW() - (${days * 2} * INTERVAL '1 day')
        AND rc.claimed_at < NOW() - (${days} * INTERVAL '1 day')
      GROUP BY rc.user_id
      HAVING SUM(rc.rakeback_amount_usd::numeric) > 0
    ),
    lapsed AS (
      SELECT p.user_id, p.prior_rakeback, p.prior_claims
      FROM prior_lapsed p
      WHERE NOT EXISTS (SELECT 1 FROM current_users c WHERE c.user_id = p.user_id)
    ),
    activity AS (
      SELECT
        l.user_id,
        COALESCE(SUM(CASE
          WHEN lt.type::text = 'deposit'
           AND lt.created_at >= NOW() - (${days} * INTERVAL '1 day')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS current_deposit,
        COALESCE(SUM(CASE
          WHEN lt.type::text = 'deposit'
           AND lt.created_at >= NOW() - (${days * 2} * INTERVAL '1 day')
           AND lt.created_at <  NOW() - (${days} * INTERVAL '1 day')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS prior_deposit,
        COALESCE(SUM(CASE
          WHEN lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
           AND lt.created_at >= NOW() - (${days} * INTERVAL '1 day')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS current_wager,
        COALESCE(SUM(CASE
          WHEN lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
           AND lt.created_at >= NOW() - (${days * 2} * INTERVAL '1 day')
           AND lt.created_at <  NOW() - (${days} * INTERVAL '1 day')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS prior_wager
      FROM lapsed l
      LEFT JOIN ledger_transactions lt
        ON lt.user_id = l.user_id
       AND lt.status = 'completed'
       AND lt.created_at >= NOW() - (${days * 2} * INTERVAL '1 day')
      GROUP BY l.user_id
    )
    SELECT
      l.user_id,
      u.username,
      l.prior_rakeback::text AS prior_rakeback,
      l.prior_claims::text AS prior_claims,
      a.current_deposit::text AS current_deposit,
      a.prior_deposit::text AS prior_deposit,
      a.current_wager::text AS current_wager,
      a.prior_wager::text AS prior_wager
    FROM lapsed l
    JOIN "user" u ON u.id = l.user_id
    JOIN activity a ON a.user_id = l.user_id
    ORDER BY l.prior_rakeback DESC
  `);

  let totalLost = 0;
  let churned = 0;
  let lessActive = 0;
  let stillActive = 0;

  const classify = (
    currentWager: number,
    priorWager: number,
    currentDeposit: number,
  ): RakebackLapsedReason => {
    if (currentWager === 0 && currentDeposit === 0) return "churned";
    // 25% slack — if current wager is at least 75% of prior, treat as
    // "still active" (probably a UX/config issue keeping them from
    // claiming, not disengagement). Anything below that is "less_active".
    if (priorWager === 0) {
      return currentWager > 0 ? "still_active" : "churned";
    }
    if (currentWager >= priorWager * 0.75) return "still_active";
    return "less_active";
  };

  const sampleUsers: RakebackLapsedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prior = toNumber(r.prior_rakeback);
    totalLost += prior;
    const currentWager = toNumber(r.current_wager);
    const priorWager = toNumber(r.prior_wager);
    const currentDeposit = toNumber(r.current_deposit);
    const priorDeposit = toNumber(r.prior_deposit);
    const reason = classify(currentWager, priorWager, currentDeposit);
    if (reason === "churned") churned += 1;
    else if (reason === "less_active") lessActive += 1;
    else stillActive += 1;

    if (sampleUsers.length < TOP_LIMIT) {
      sampleUsers.push({
        userId: r.user_id,
        username: r.username,
        priorRakeback: prior,
        priorClaims: Number(r.prior_claims),
        currentDeposit,
        priorDeposit,
        currentWager,
        priorWager,
        reason,
      });
    }
  }

  return {
    totalLapsedUsers: rows.length,
    totalLostRakeback: totalLost,
    reasons: {
      churned,
      lessActive,
      stillActive,
    },
    sampleUsers,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeLapsed(period, blacklistIds),
  ["insights-rewards-rakeback-lapsed-v2"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeLapsed(period, blacklistIds),
  ["insights-rewards-rakeback-lapsed-lifetime-v2"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackLapsed(
  period: InsightsRewardsPeriod,
): Promise<RakebackLapsed | null> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
