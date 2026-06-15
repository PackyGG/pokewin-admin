import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of `@/lib/queries/analytics-cohorts` `getCohortRetention` —
 * signup-cohort retention + revenue grid, read from the `packy_prod` CDC mirror.
 * Comparison-mode only.
 *
 * SCOPE mirrored EXACTLY from the PG twin:
 *   • role NOT IN ('admin','support','creator') (creators DROPPED — canonical
 *     customer scope) + excluded-users blacklist; signup within the cohort
 *     horizon (140 days for week, 36 months for month).
 *   • cohort bucket = date_trunc(week|month) in UTC; period_index = the PG
 *     epoch-seconds math floor((bucket−cohort) / interval), where the MONTH
 *     interval is a fixed 30-day epoch (2592000s) — replicated as intDiv(days, 30)
 *     so March activity of a January cohort lands in the SAME bucket PG produces.
 *   • revenue = Σ|wager| − (Σ|battle_refund,battle_excess_to_voucher| +
 *     Σ inventory.value_at_obtained[pack|battle]); borrow plays dropped on BOTH
 *     sides; card conversions are NEUTRAL (not on the payout side).
 *   • Payouts are folded in ONLY for (cohort, period_index) pairs that also have
 *     wager activity — replicating the PG final query's
 *     `retained LEFT JOIN payouts ON cohort AND period_index` (a payout in a
 *     period with no wager is dropped).
 *
 * Wager (3-type) + gaming-payout (2-type) literals are inlined (CQRS boundary).
 */

export type CohortGranularity = "week" | "month";

export type CohortRowCh = {
  cohort: string;
  label: string;
  size: number;
  retained: number[];
  revenue: number[];
};

export type CohortDataCh = {
  granularity: CohortGranularity;
  maxPeriods: number;
  rows: CohortRowCh[];
};

const MAX_COHORTS = 16;
const MAX_PERIODS = 10;

function bucketExpr(col: string, granularity: CohortGranularity): string {
  return granularity === "week"
    ? `toStartOfWeek(${col}, 1, 'UTC')`
    : `toStartOfMonth(${col}, 'UTC')`;
}

/**
 * Integer bucket distance from the cohort's signup bucket, clamped to
 * MAX_PERIODS-1. Replicates the PG `FLOOR(EXTRACT(EPOCH …) / EXTRACT(EPOCH FROM
 * INTERVAL …))`:
 *   • week  → intDiv(days, 7)  (week-aligned dates ⇒ days are multiples of 7).
 *   • month → intDiv(days, 30) (PG's INTERVAL '1 month' epoch is a fixed 30d).
 */
function periodIndexExpr(
  tsCol: string,
  cohortCol: string,
  granularity: CohortGranularity,
): string {
  const bucket = bucketExpr(tsCol, granularity);
  const divisor = granularity === "week" ? 7 : 30;
  return `least(${MAX_PERIODS - 1}, toInt32(intDiv(dateDiff('day', ${cohortCol}, ${bucket}), ${divisor})))`;
}

function horizonCutoff(granularity: CohortGranularity, now: Date): Date {
  if (granularity === "week") {
    return new Date(now.getTime() - 140 * 86_400_000);
  }
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - 36);
  return d;
}

export async function getCohortRetentionFromClickHouse(
  granularity: CohortGranularity,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CohortDataCh> {
  const hasBlacklist = blacklist.length > 0;
  const horizon = chDateTime(horizonCutoff(granularity, now));
  const params: Record<string, unknown> = { horizon, blacklist };

  const blacklistClause = hasBlacklist
    ? "AND id NOT IN {blacklist:Array(String)}"
    : "";

  const cohortsCte = `cohorts AS (
      SELECT
        id AS user_id,
        created_at,
        ${bucketExpr("created_at", granularity)} AS cohort
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${blacklistClause}
        AND created_at >= {horizon:DateTime64(6)}
    )`;

  const nonBorrowSessionsCte = `non_borrow_battle_sessions AS (
      SELECT bp.game_session_id AS game_session_id
      FROM ${CH_DB}.public_battle_participants AS bp FINAL
      JOIN ${CH_DB}.public_battles AS b FINAL ON b.id = bp.battle_id
      WHERE bp._peerdb_is_deleted = 0
        AND b._peerdb_is_deleted = 0
        AND coalesce(b.borrow_percentage, 0) = 0
    )`;

  const sizesSql = `
    WITH ${cohortsCte}
    SELECT toString(cohort) AS cohort, toString(count()) AS size
    FROM cohorts
    GROUP BY cohort`;

  // Wager activity (3-type set), borrow plays excluded symmetrically.
  const retainedSql = `
    WITH
      ${cohortsCte},
      ${nonBorrowSessionsCte}
    SELECT
      toString(c.cohort) AS cohort,
      ${periodIndexExpr("lt.created_at", "c.cohort", granularity)} AS period_index,
      toString(uniqExact(lt.user_id)) AS retained_count,
      toString(sum(abs(lt.amount)))   AS wager
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    INNER JOIN cohorts AS c ON c.user_id = lt.user_id
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
      AND lt.created_at >= c.created_at
      AND (
        (lt.type = 'pack_opening' AND positionCaseInsensitive(lt.description, 'borrow') = 0)
        OR (lt.type IN ('battle_bet','battle_sponsorship')
            AND ifNull(lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions), 0))
      )
    GROUP BY c.cohort, period_index`;

  // Ledger gaming-payout leg (battle_refund + battle_excess_to_voucher).
  const payoutLedgerSql = `
    WITH ${cohortsCte}
    SELECT
      toString(c.cohort) AS cohort,
      ${periodIndexExpr("lt.created_at", "c.cohort", granularity)} AS period_index,
      toString(sum(abs(lt.amount))) AS payout
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    INNER JOIN cohorts AS c ON c.user_id = lt.user_id
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('battle_refund','battle_excess_to_voucher')
      AND lt.created_at >= c.created_at
    GROUP BY c.cohort, period_index`;

  // Dominant pack/battle payout: inventory value_at_obtained, bucketed by
  // obtained_at, borrow plays excluded to match the wager side.
  const payoutInventorySql = `
    WITH
      ${cohortsCte},
      ${nonBorrowSessionsCte},
      pack_sessions AS (
        SELECT game_session_id
        FROM ${CH_DB}.public_ledger_transactions FINAL
        WHERE _peerdb_is_deleted = 0
          AND type = 'pack_opening'
          AND status = 'completed'
          AND game_session_id IS NOT NULL
          AND positionCaseInsensitive(description, 'borrow') = 0
      )
    SELECT
      toString(c.cohort) AS cohort,
      ${periodIndexExpr("ui.obtained_at", "c.cohort", granularity)} AS period_index,
      toString(sum(ui.value_at_obtained)) AS payout
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    INNER JOIN cohorts AS c ON c.user_id = ui.user_id
    WHERE ui._peerdb_is_deleted = 0
      AND ui.source_type IN ('pack','battle')
      AND ui.obtained_at >= c.created_at
      AND (
        (ui.source_type = 'pack'
          AND ifNull(ui.source_id IN (SELECT game_session_id FROM pack_sessions), 0))
        OR (ui.source_type = 'battle'
          AND ifNull(ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions), 0))
      )
    GROUP BY c.cohort, period_index`;

  const [sizesRows, retainedRows, payoutLedgerRows, payoutInventoryRows] =
    await Promise.all([
      clickhouseRead.query<{ cohort: string; size: string }>({
        queryName: "analytics.cohorts.sizes",
        sql: sizesSql,
        params,
      }),
      clickhouseRead.query<{
        cohort: string;
        period_index: number;
        retained_count: string;
        wager: string;
      }>({ queryName: "analytics.cohorts.retained", sql: retainedSql, params }),
      clickhouseRead.query<{
        cohort: string;
        period_index: number;
        payout: string;
      }>({
        queryName: "analytics.cohorts.payout_ledger",
        sql: payoutLedgerSql,
        params,
      }),
      clickhouseRead.query<{
        cohort: string;
        period_index: number;
        payout: string;
      }>({
        queryName: "analytics.cohorts.payout_inventory",
        sql: payoutInventorySql,
        params,
      }),
    ]);

  const clampIdx = (p: number): number =>
    Math.max(0, Math.min(MAX_PERIODS - 1, p));

  // payout[`${cohort}|${idx}`] = Σ ledger-payout + Σ inventory-payout.
  const payoutMap = new Map<string, number>();
  for (const r of payoutLedgerRows) {
    const key = `${r.cohort}|${clampIdx(r.period_index)}`;
    payoutMap.set(key, (payoutMap.get(key) ?? 0) + toNumber(r.payout));
  }
  for (const r of payoutInventoryRows) {
    const key = `${r.cohort}|${clampIdx(r.period_index)}`;
    payoutMap.set(key, (payoutMap.get(key) ?? 0) + toNumber(r.payout));
  }

  const byCohort = new Map<
    string,
    { date: Date; size: number; retained: number[]; revenue: number[] }
  >();
  for (const r of sizesRows) {
    byCohort.set(r.cohort, {
      date: new Date(r.cohort),
      size: Number(r.size),
      retained: Array(MAX_PERIODS).fill(0),
      revenue: Array(MAX_PERIODS).fill(0),
    });
  }

  // Revenue is folded in ONLY for (cohort, period_index) pairs present in the
  // wager-activity (retained) set, mirroring the PG retained-LEFT-JOIN-payouts.
  for (const r of retainedRows) {
    const entry = byCohort.get(r.cohort);
    if (!entry) continue;
    const idx = clampIdx(r.period_index);
    entry.retained[idx] += Number(r.retained_count);
    const wager = toNumber(r.wager);
    const payout = payoutMap.get(`${r.cohort}|${idx}`) ?? 0;
    entry.revenue[idx] += wager - payout;
  }

  const sorted = Array.from(byCohort.values()).sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  const capped = sorted.slice(0, MAX_COHORTS).reverse();

  const labelFormatter =
    granularity === "week"
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
      : new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

  return {
    granularity,
    maxPeriods: MAX_PERIODS,
    rows: capped.map((c) => ({
      cohort: c.date.toISOString().slice(0, 10),
      label: labelFormatter.format(c.date),
      size: c.size,
      retained: c.retained,
      revenue: c.revenue,
    })),
  };
}
