import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { daysForInsightsPeriod } from "@/lib/queries/insights-rewards/_period";

import { CH_DB, toNumber } from "../../_shared";
import { depositBonusCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus ROI lens
 * (`getDepositBonusROI` → `computeRoi` in
 * `src/lib/queries/insights-rewards/deposit-bonus/roi.ts`).
 *
 * Per claimant we take their FIRST in-window bonus claim (`MIN(created_at)`),
 * then sum the wager / payout-side ledger volume in a forward `lookbackDays`
 * window from that claim. Mirrors the PG twin EXACTLY:
 *   • cost     = SUM(ABS(amount))      type='deposit_bonus'   (in window)
 *   • claimants= COUNT(distinct claimants — one row per cost_claimants user)
 *   • wager    = SUM(ABS(amount))      type IN (pack_opening, battle_bet,
 *                                              battle_sponsorship, upgrader_bet)
 *   • payouts  = SUM(ABS(amount))      type IN (battle_refund, upgrader_payout)
 *   • subsequentGgr = wager − payouts
 * Forward window: `created_at >= claim_at AND created_at < claim_at + lookback`
 * for finite periods; `created_at >= claim_at` for lifetime. 2-role customer
 * scope + blacklist; money kept Decimal end-to-end.
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";
const PAYOUT_TYPES = "('battle_refund','upgrader_payout')";

export type DepositBonusRoiCh = {
  cost: number;
  claimants: number;
  wager: number;
  payouts: number;
  subsequentGgr: number;
};

/** Mirrors `resolveLookback` in the PG twin. */
function resolveLookback(period: InsightsRewardsPeriod, raw: number): number {
  if (period === "24h") return 1;
  if (period === "3d") return 3;
  return Math.max(1, Math.min(raw, 180));
}

export async function getDepositBonusRoiFromClickHouse(
  period: InsightsRewardsPeriod,
  rawLookbackDays: number,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusRoiCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = depositBonusCutoff(period, now);
  const scope = depositBonusScopeCte(hasBlacklist);
  const days = daysForInsightsPeriod(period);
  const lookbackDays = resolveLookback(period, rawLookbackDays);

  const costCutoffClause =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const forwardClause =
    days !== null
      ? "AND lt.created_at >= cc.claim_at AND lt.created_at < cc.claim_at + toIntervalDay({lookback:UInt32})"
      : "AND lt.created_at >= cc.claim_at";

  const params: Record<string, unknown> = {
    blacklist,
    cutoff,
    lookback: lookbackDays,
  };

  const sql = `
    WITH ${scope},
    cost_claimants AS (
      SELECT
        lt.user_id              AS user_id,
        min(lt.created_at)      AS claim_at,
        sum(abs(lt.amount))     AS cost
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${costCutoffClause}
      GROUP BY lt.user_id
    ),
    forward_wagers AS (
      SELECT cc.user_id AS user_id, sum(abs(lt.amount)) AS wager
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      INNER JOIN cost_claimants cc ON cc.user_id = lt.user_id
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type IN ${WAGER_TYPES}
        ${forwardClause}
      GROUP BY cc.user_id
    ),
    forward_payouts AS (
      SELECT cc.user_id AS user_id, sum(abs(lt.amount)) AS payout
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      INNER JOIN cost_claimants cc ON cc.user_id = lt.user_id
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type IN ${PAYOUT_TYPES}
        ${forwardClause}
      GROUP BY cc.user_id
    )
    SELECT
      toString(sum(cc.cost))                            AS cost,
      toString(count())                                 AS claimants,
      toString(sum(ifNull(fw.wager, toDecimal128(0, 2))))  AS wager,
      toString(sum(ifNull(fp.payout, toDecimal128(0, 2)))) AS payout
    FROM cost_claimants cc
    LEFT JOIN forward_wagers fw ON fw.user_id = cc.user_id
    LEFT JOIN forward_payouts fp ON fp.user_id = cc.user_id`;

  const rows = await clickhouseRead.query<{
    cost: string;
    claimants: string;
    wager: string;
    payout: string;
  }>({
    queryName: "insights.deposit_bonus.roi",
    sql,
    params,
  });

  const r = rows[0] ?? { cost: "0", claimants: "0", wager: "0", payout: "0" };
  const cost = toNumber(r.cost);
  const claimants = Number(r.claimants);
  const wager = toNumber(r.wager);
  const payouts = toNumber(r.payout);
  return {
    cost,
    claimants,
    wager,
    payouts,
    subsequentGgr: wager - payouts,
  };
}
