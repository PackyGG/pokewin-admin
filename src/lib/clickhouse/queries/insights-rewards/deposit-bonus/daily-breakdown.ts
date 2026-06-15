import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusDailyRow } from "@/lib/queries/insights-rewards/deposit-bonus/daily-breakdown";

import { CH_DB, toNumber } from "../../_shared";
import { depositBonusCappedCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus day-by-day breakdown table
 * (`getDepositBonusDailyBreakdown` → `computeDailyBreakdown` in
 * `src/lib/queries/insights-rewards/deposit-bonus/daily-breakdown.ts`).
 *
 * Mirrors EXACTLY the three per-day PG rollups joined on day:
 *   • deposits         — count + Σ|amount|              type='deposit'
 *   • bonuses          — count + Σ|amount| + claimants  type='deposit_bonus'
 *   • with_bonus_count — deposits whose canonical bonus-pairing
 *                        (balance_before = balance_after, < 30s after the
 *                        deposit) matched ≥ 1 deposit_bonus row
 * status='completed', 2-role customer scope + blacklist. Deposit + bonus
 * aggregates use the CAPPED window cutoff (`windowDateFilterCapped`, 365d on
 * lifetime); the pairing bonus set carries NO date bound (matching the PG inner
 * EXISTS, which only constrains user + balance + the 30s window). Lifetime is
 * additionally row-capped to the latest 60 days (`ORDER BY day DESC LIMIT 60`),
 * exactly like the PG twin. The derived ratios (`bonusToDepositRatio`,
 * `attachRate`, `avgBonus`) are recomputed in TS identically to PG.
 *
 * Balance-pairing leg (§5c): the with-bonus count is built via an equi-join on
 * (user_id, bonus.balance_before = deposit.balance_after) + the 30s range
 * filter, deduped with `uniqExact(deposit.id)` so each qualifying deposit is
 * counted exactly once — reproducing PG's `EXISTS` semantics.
 */

const LIFETIME_DAY_LIMIT = 60;

type DailyRow = {
  day: string;
  deposit_count: string;
  deposit_volume: string;
  with_bonus_count: string;
  bonus_count: string;
  bonus_volume: string;
  claimants: string;
};

export async function getDepositBonusDailyBreakdownFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusDailyRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCappedCutoff(period, now);
  const isLifetime = daysForInsightsPeriod(period) === null;
  const params: Record<string, unknown> = { blacklist, cutoff };

  const sql = `
    WITH ${scope},
    dep_rows AS (
      SELECT d.id AS id, d.user_id AS user_id, d.balance_after AS bal_after,
             abs(d.amount) AS amt, d.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS d FINAL
      WHERE d._peerdb_is_deleted = 0
        AND d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN (SELECT id FROM real_users)
        AND d.created_at >= {cutoff:DateTime64(6)}
    ),
    bon_rows AS (
      SELECT b.user_id AS user_id, b.balance_before AS bal_before, b.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS b FINAL
      WHERE b._peerdb_is_deleted = 0
        AND b.status = 'completed'
        AND b.type = 'deposit_bonus'
    ),
    deposits AS (
      SELECT toDate(created_at) AS day, count() AS deposit_count, sum(amt) AS deposit_volume
      FROM dep_rows
      GROUP BY day
    ),
    bonuses AS (
      SELECT toDate(lt.created_at) AS day, count() AS bonus_count,
             sum(abs(lt.amount)) AS bonus_volume, uniqExact(lt.user_id) AS claimants
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        AND lt.created_at >= {cutoff:DateTime64(6)}
      GROUP BY day
    ),
    with_bonus AS (
      SELECT day, uniqExact(id) AS with_bonus_count
      FROM (
        SELECT d.id AS id, toDate(d.created_at) AS day
        FROM dep_rows AS d
        INNER JOIN bon_rows AS b ON b.user_id = d.user_id AND b.bal_before = d.bal_after
        WHERE b.created_at >= d.created_at
          AND b.created_at < d.created_at + INTERVAL 30 SECOND
      )
      GROUP BY day
    ),
    all_days AS (
      SELECT day FROM deposits
      UNION DISTINCT SELECT day FROM bonuses
      UNION DISTINCT SELECT day FROM with_bonus
    )
    SELECT
      toString(ad.day)                              AS day,
      toString(coalesce(d.deposit_count, 0))        AS deposit_count,
      toString(coalesce(d.deposit_volume, 0))       AS deposit_volume,
      toString(coalesce(wb.with_bonus_count, 0))    AS with_bonus_count,
      toString(coalesce(b.bonus_count, 0))          AS bonus_count,
      toString(coalesce(b.bonus_volume, 0))         AS bonus_volume,
      toString(coalesce(b.claimants, 0))            AS claimants
    FROM all_days AS ad
    LEFT JOIN deposits AS d ON d.day = ad.day
    LEFT JOIN bonuses AS b ON b.day = ad.day
    LEFT JOIN with_bonus AS wb ON wb.day = ad.day
    ORDER BY ad.day DESC
    ${isLifetime ? `LIMIT ${LIFETIME_DAY_LIMIT}` : ""}`;

  const rows = await clickhouseRead.query<DailyRow>({
    queryName: "insights.deposit_bonus.daily_breakdown",
    sql,
    params,
  });

  return rows.map((r) => {
    const depositCount = Number(r.deposit_count ?? 0);
    const depositVolume = toNumber(r.deposit_volume);
    const bonusCount = Number(r.bonus_count ?? 0);
    const bonusVolume = toNumber(r.bonus_volume);
    const withBonusCount = Number(r.with_bonus_count ?? 0);
    return {
      date: r.day,
      depositCount,
      depositVolume,
      depositWithBonusCount: withBonusCount,
      bonusCount,
      bonusVolume,
      uniqueClaimants: Number(r.claimants ?? 0),
      bonusToDepositRatio: depositVolume > 0 ? bonusVolume / depositVolume : 0,
      attachRate: depositCount > 0 ? withBonusCount / depositCount : 0,
      avgBonus: bonusCount > 0 ? bonusVolume / bonusCount : 0,
    };
  });
}
