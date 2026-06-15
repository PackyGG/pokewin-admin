import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackTopClaimer,
  RakebackTopClaimerScope,
} from "@/lib/queries/insights-rewards/rakeback/top-claimers";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackTopClaimers`
 * (`src/lib/queries/insights-rewards/rakeback/top-claimers.ts`).
 *
 * PARITY: top 25 claimers by rakeback in scope (`period` → current window;
 * `lifetime` → all-time), each with claim count + a lifetime-rakeback context
 * column (all-time SUM for the same top-25 users). The per-claim average is
 * derived in TS with the IDENTICAL arithmetic the PG twin uses.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support','creator')` +
 * blacklist — `customerScopeCte`. The lifetime context CTE is restricted to the
 * scoped top-25 users (no extra role filter), exactly like the PG twin.
 *
 * NOTE: `ORDER BY rakeback DESC LIMIT 25` has no secondary tiebreaker on either
 * engine, so a tie straddling the 25th slot could pick a different row set. The
 * compare hook diffs the leaderboard aggregate (Σ rakeback, Σ claims, row count)
 * which is stable whenever the top-25 sums are distinct.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 25;

type Row = {
  user_id: string;
  username: string | null;
  total_rakeback: string;
  claim_count: string;
  lifetime_rakeback: string;
};

export async function getRakebackTopClaimersFromClickHouse(
  period: InsightsRewardsPeriod,
  scope: RakebackTopClaimerScope,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackTopClaimer[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scopeCte = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let scopeDateFilter = "";
  if (scope === "period" && days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    scopeDateFilter = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.rewards.rakeback.top-claimers",
    sql: `
      WITH
        ${scopeCte},
        scoped AS (
          SELECT
            rc.user_id AS user_id,
            sum(rc.rakeback_amount_usd) AS total_rakeback,
            count() AS claim_count
          FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
          WHERE rc._peerdb_is_deleted = 0
            AND rc.claimed_at IS NOT NULL
            AND rc.user_id IN (SELECT id FROM real_users)
            ${scopeDateFilter}
          GROUP BY rc.user_id
          ORDER BY sum(rc.rakeback_amount_usd) DESC
          LIMIT ${TOP_LIMIT}
        ),
        lifetime AS (
          SELECT
            rc.user_id AS user_id,
            sum(rc.rakeback_amount_usd) AS lifetime_rakeback
          FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
          WHERE rc._peerdb_is_deleted = 0
            AND rc.claimed_at IS NOT NULL
            AND rc.user_id IN (SELECT user_id FROM scoped)
          GROUP BY rc.user_id
        )
      SELECT
        s.user_id                  AS user_id,
        u.username                 AS username,
        toString(s.total_rakeback) AS total_rakeback,
        toString(s.claim_count)    AS claim_count,
        toString(coalesce(l.lifetime_rakeback, toDecimal128(0, 2))) AS lifetime_rakeback
      FROM scoped AS s
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = s.user_id
      LEFT JOIN lifetime AS l ON l.user_id = s.user_id
      WHERE u._peerdb_is_deleted = 0
      ORDER BY s.total_rakeback DESC`,
    params,
  });

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
