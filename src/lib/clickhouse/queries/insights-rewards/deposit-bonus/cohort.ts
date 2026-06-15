import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusCohortComparison } from "@/lib/queries/insights-rewards/deposit-bonus/cohort";

import { CH_DB, toNumber } from "../../_shared";
import {
  depositBonusCappedCutoff,
  depositBonusCappedTailCutoff,
  depositBonusScopeCte,
} from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus with/without-bonus cohort comparison
 * (`getDepositBonusCohortComparison` → `computeCohortComparison` in
 * `src/lib/queries/insights-rewards/deposit-bonus/cohort.ts`).
 *
 * Pairs each CAPPED-window completed deposit to its FIRST matching deposit_bonus
 * (canonical balance pairing, earliest via `argMin`); the with/without split,
 * per-side COUNT / Σ deposit / distinct users / 7d+30d retention counts are
 * cent/count-exact and gated. `avg` = Σ/count (matches PG `AVG(numeric)`); the
 * `median`/`p99` percentiles are returned for shape parity but NOT gated
 * (PG `PERCENTILE_CONT` vs CH Float64 quantile cannot be bit-exact). The
 * derived lift %s are recomputed in TS identically to PG.
 *
 * Retention mirrors PG's `bool_or` over wagers in (claim+1h, claim+7d] /
 * (…+30d]: wager timestamps are grouped per user into an array and tested with
 * `arrayExists`, which reproduces the boolean EXACTLY without the row-explosion
 * of a user-id cross join. Wager scan is the capped-tail (+30d) window scoped to
 * in-window depositors, exactly like PG. 2-role customer scope + blacklist.
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

type SideRow = {
  side: "with" | "without";
  cnt: string;
  sum_dep: string;
  median_dep: string | null;
  p99_dep: string | null;
  users: string;
  ret7: string;
  ret30: string;
};

const liftPct = (a: number, b: number): number => (b > 0 ? ((a - b) / b) * 100 : 0);

function emptySide(): DepositBonusCohortComparison["withBonus"] {
  return {
    count: 0,
    sum: 0,
    avg: 0,
    median: 0,
    p99: 0,
    uniqueUsers: 0,
    retain7d: 0,
    retain30d: 0,
  };
}

export async function getDepositBonusCohortComparisonFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusCohortComparison> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCappedCutoff(period, now);
  const wagerCutoff = depositBonusCappedTailCutoff(period, now, 30);
  const params: Record<string, unknown> = { blacklist, cutoff, wagerCutoff };

  const sql = `
    WITH ${scope},
    dep_rows AS (
      SELECT d.id AS id, d.user_id AS user_id, abs(d.amount) AS deposit_usd,
             d.balance_after AS bal_after, d.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS d FINAL
      WHERE d._peerdb_is_deleted = 0
        AND d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN (SELECT id FROM real_users)
        AND d.created_at >= {cutoff:DateTime64(6)}
    ),
    bon_rows AS (
      SELECT b.user_id AS user_id, b.balance_before AS bal_before,
             abs(b.amount) AS bonus_usd, b.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS b FINAL
      WHERE b._peerdb_is_deleted = 0
        AND b.status = 'completed'
        AND b.type = 'deposit_bonus'
        AND b.created_at >= {cutoff:DateTime64(6)}
    ),
    matched_bonus AS (
      SELECT d.id AS id, argMin(b.bonus_usd, b.created_at) AS bonus_usd, toUInt8(1) AS has_bonus
      FROM dep_rows AS d
      INNER JOIN bon_rows AS b ON b.user_id = d.user_id AND b.bal_before = d.bal_after
      WHERE b.created_at >= d.created_at
        AND b.created_at < d.created_at + INTERVAL 30 SECOND
      GROUP BY d.id
    ),
    wager_by_user AS (
      SELECT w.user_id AS user_id, groupArray(w.created_at) AS ts
      FROM ${CH_DB}.public_ledger_transactions AS w FINAL
      WHERE w._peerdb_is_deleted = 0
        AND w.status = 'completed'
        AND w.type IN ${WAGER_TYPES}
        AND w.user_id IN (SELECT user_id FROM dep_rows)
        AND w.created_at >= {wagerCutoff:DateTime64(6)}
      GROUP BY w.user_id
    ),
    paired AS (
      SELECT
        d.user_id AS user_id,
        d.deposit_usd AS deposit_usd,
        d.created_at AS created_at,
        coalesce(mb.has_bonus, toUInt8(0)) AS has_bonus,
        arrayExists(t -> t > d.created_at + INTERVAL 1 HOUR AND t <= d.created_at + INTERVAL 7 DAY, coalesce(wbu.ts, [])) AS r7,
        arrayExists(t -> t > d.created_at + INTERVAL 1 HOUR AND t <= d.created_at + INTERVAL 30 DAY, coalesce(wbu.ts, [])) AS r30
      FROM dep_rows AS d
      LEFT JOIN matched_bonus AS mb ON mb.id = d.id
      LEFT JOIN wager_by_user AS wbu ON wbu.user_id = d.user_id
    )
    SELECT
      if(has_bonus = 1, 'with', 'without')                          AS side,
      toString(count())                                             AS cnt,
      toString(sum(deposit_usd))                                    AS sum_dep,
      toString(quantileExactInclusive(0.5)(toFloat64(deposit_usd)))            AS median_dep,
      toString(quantileExactInclusive(0.99)(toFloat64(deposit_usd)))           AS p99_dep,
      toString(uniqExact(user_id))                                  AS users,
      toString(countIf(r7))                                         AS ret7,
      toString(countIf(r30))                                        AS ret30
    FROM paired
    GROUP BY side`;

  const rows = await clickhouseRead.query<SideRow>({
    queryName: "insights.deposit_bonus.cohort_comparison",
    sql,
    params,
    timeoutMs: 30_000,
  });

  const parseSide = (
    side: "with" | "without",
  ): DepositBonusCohortComparison["withBonus"] => {
    const row = rows.find((r) => r.side === side);
    if (!row) return emptySide();
    const count = Number(row.cnt ?? 0);
    const sum = toNumber(row.sum_dep);
    return {
      count,
      sum,
      avg: count > 0 ? sum / count : 0,
      median: row.median_dep != null ? toNumber(row.median_dep) : 0,
      p99: row.p99_dep != null ? toNumber(row.p99_dep) : 0,
      uniqueUsers: Number(row.users ?? 0),
      retain7d: count > 0 ? Number(row.ret7 ?? 0) / count : 0,
      retain30d: count > 0 ? Number(row.ret30 ?? 0) / count : 0,
    };
  };

  const withBonus = parseSide("with");
  const withoutBonus = parseSide("without");

  return {
    totalDeposits: withBonus.count + withoutBonus.count,
    withBonus,
    withoutBonus,
    avgLiftPct: liftPct(withBonus.avg, withoutBonus.avg),
    medianLiftPct: liftPct(withBonus.median, withoutBonus.median),
    retain7dLiftPct: liftPct(withBonus.retain7d, withoutBonus.retain7d),
    retain30dLiftPct: liftPct(withBonus.retain30d, withoutBonus.retain30d),
  };
}
