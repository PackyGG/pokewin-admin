import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusTopSpender } from "@/lib/queries/insights-rewards/deposit-bonus/top-spenders";

import { CH_DB, toNumber } from "../../_shared";
import { cutoffClause, depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus top-25 recipients
 * (`getDepositBonusTopSpenders` → `computeTopSpenders` in
 * `src/lib/queries/insights-rewards/deposit-bonus/top-spenders.ts`).
 *
 * Top 25 in-window bonus recipients by Σ bonus volume, with their lifetime
 * bonus, in-window deposit / wager / payout totals + window PnL. All Decimal
 * sums + counts are cent/count-exact. `windowDateFilter` (plain, unbounded on
 * lifetime). 2-role customer scope + blacklist.
 *
 * Tie-break (§5c): PG's `ORDER BY bonus_total DESC` has no secondary key, so a
 * deterministic `user_id ASC` is added on the CH side (and pinned on PG in the
 * parity script) — the top-25 membership/order is stable unless two users tie
 * to the cent on bonus volume at the rank-25 boundary.
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";
const PAYOUT_TYPES = "('battle_refund','upgrader_payout')";
const TOP_LIMIT = 25;

export async function getDepositBonusTopSpendersFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusTopSpender[]> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCutoff(period, now);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const sql = `
    WITH ${scope},
    window_bonus AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS bonus_total, count() AS bonus_count
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
      ORDER BY sum(abs(lt.amount)) DESC, lt.user_id ASC
      LIMIT ${TOP_LIMIT}
    ),
    lifetime_bonus AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS lifetime_bonus_total, count() AS lifetime_bonus_count
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
      GROUP BY lt.user_id
    ),
    window_deposits AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS deposit_total
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit'
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    ),
    window_wager AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS wager_total
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type IN ${WAGER_TYPES}
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    ),
    window_payout AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS payout_total
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type IN ${PAYOUT_TYPES}
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    )
    SELECT
      wb.user_id                                                            AS user_id,
      u.username                                                            AS username,
      toString(wb.bonus_total)                                              AS bonus_total,
      toString(wb.bonus_count)                                              AS bonus_count,
      toString(coalesce(lb.lifetime_bonus_total, wb.bonus_total))           AS lifetime_bonus_total,
      toString(coalesce(lb.lifetime_bonus_count, wb.bonus_count))           AS lifetime_bonus_count,
      toString(coalesce(wd.deposit_total, toDecimal128(0, 2)))              AS deposit_total,
      toString(coalesce(ww.wager_total, toDecimal128(0, 2)))                AS wager_total,
      toString(coalesce(wp.payout_total, toDecimal128(0, 2)))               AS payout_total
    FROM window_bonus AS wb
    INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = wb.user_id
    LEFT JOIN lifetime_bonus AS lb ON lb.user_id = wb.user_id
    LEFT JOIN window_deposits AS wd ON wd.user_id = wb.user_id
    LEFT JOIN window_wager AS ww ON ww.user_id = wb.user_id
    LEFT JOIN window_payout AS wp ON wp.user_id = wb.user_id
    WHERE u._peerdb_is_deleted = 0
    ORDER BY wb.bonus_total DESC, wb.user_id ASC`;

  const rows = await clickhouseRead.query<{
    user_id: string;
    username: string | null;
    bonus_total: string;
    bonus_count: string;
    lifetime_bonus_total: string;
    lifetime_bonus_count: string;
    deposit_total: string;
    wager_total: string;
    payout_total: string;
  }>({
    queryName: "insights.deposit_bonus.top_spenders",
    sql,
    params,
    timeoutMs: 30_000,
  });

  return rows.map((r) => {
    const wagerTotal = toNumber(r.wager_total);
    const payoutTotal = toNumber(r.payout_total);
    return {
      userId: r.user_id,
      username: r.username,
      bonusTotal: toNumber(r.bonus_total),
      bonusCount: Number(r.bonus_count ?? 0),
      lifetimeBonusTotal: toNumber(r.lifetime_bonus_total),
      lifetimeBonusCount: Number(r.lifetime_bonus_count ?? 0),
      depositTotal: toNumber(r.deposit_total),
      wagerTotal,
      payoutTotal,
      pnlInWindow: wagerTotal - payoutTotal,
    };
  });
}
