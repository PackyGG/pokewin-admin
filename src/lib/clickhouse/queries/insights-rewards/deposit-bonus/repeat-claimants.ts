import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusRepeatClaimants } from "@/lib/queries/insights-rewards/deposit-bonus/behavior";

import { CH_DB, toNumber } from "../../_shared";
import { cutoffClause, depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus repeat-claimant segmentation
 * (`getDepositBonusRepeatClaimants` → `computeRepeatClaimants` in
 * `src/lib/queries/insights-rewards/deposit-bonus/behavior.ts`).
 *
 * Segments in-window claimants by LIFETIME claim count (1 / 2–5 / 6–20 / 21+),
 * mirroring PG exactly: per-segment users, Σ bonus volume (window), Σ wager
 * (window) are count/cent-exact and gated; `avgBonusPerUser` is derived in TS.
 * The "in window" scans use the plain `windowDateFilter` cutoff (unbounded on
 * lifetime); the lifetime claim count is all-time for the in-window claimant
 * set. 2-role customer scope + blacklist.
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

export async function getDepositBonusRepeatClaimantsFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusRepeatClaimants> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCutoff(period, now);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const sql = `
    WITH ${scope},
    window_users AS (
      SELECT DISTINCT lt.user_id AS user_id
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}
    ),
    lifetime_counts AS (
      SELECT lt.user_id AS user_id, count() AS lifetime_claims
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM window_users)
      GROUP BY lt.user_id
    ),
    bonus_window AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS bonus
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM window_users)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    ),
    wager_window AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS wager
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type IN ${WAGER_TYPES}
        AND lt.user_id IN (SELECT user_id FROM window_users)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    ),
    per_user AS (
      SELECT
        wu.user_id AS user_id,
        coalesce(lc.lifetime_claims, 0) AS lifetime_claims,
        coalesce(bw.bonus, toDecimal128(0, 2)) AS bonus,
        coalesce(ww.wager, toDecimal128(0, 2)) AS wager
      FROM window_users AS wu
      LEFT JOIN lifetime_counts AS lc ON lc.user_id = wu.user_id
      LEFT JOIN bonus_window AS bw ON bw.user_id = wu.user_id
      LEFT JOIN wager_window AS ww ON ww.user_id = wu.user_id
    )
    SELECT
      toString(multiIf(lifetime_claims <= 1, 0, lifetime_claims <= 5, 1, lifetime_claims <= 20, 2, 3)) AS seg,
      toString(count())     AS users,
      toString(sum(bonus))  AS total_bonus,
      toString(sum(wager))  AS wager_in_window
    FROM per_user
    GROUP BY seg
    ORDER BY seg`;

  const rows = await clickhouseRead.query<{
    seg: string;
    users: string;
    total_bonus: string;
    wager_in_window: string;
  }>({
    queryName: "insights.deposit_bonus.repeat_claimants",
    sql,
    params,
    timeoutMs: 30_000,
  });

  const segments = [
    { label: "1 claim", minClaims: 1, maxClaims: 1, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
    { label: "2–5", minClaims: 2, maxClaims: 5, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
    { label: "6–20", minClaims: 6, maxClaims: 20, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
    { label: "21+", minClaims: 21, maxClaims: Number.POSITIVE_INFINITY, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
  ];
  let totalClaimants = 0;
  let totalBonus = 0;
  for (const r of rows) {
    const idx = Number(r.seg);
    if (idx < 0 || idx >= segments.length) continue;
    const users = Number(r.users ?? 0);
    const bonus = toNumber(r.total_bonus);
    const wager = toNumber(r.wager_in_window);
    segments[idx].users = users;
    segments[idx].totalBonus = bonus;
    segments[idx].wagerInWindow = wager;
    totalClaimants += users;
    totalBonus += bonus;
  }
  for (const seg of segments) {
    seg.avgBonusPerUser = seg.users > 0 ? seg.totalBonus / seg.users : 0;
  }

  return { segments, totalClaimants, totalBonus };
}
