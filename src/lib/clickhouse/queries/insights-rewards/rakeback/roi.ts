import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackRoi,
  RakebackRoiLookback,
} from "@/lib/queries/insights-rewards/rakeback/roi";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackRoi`
 * (`src/lib/queries/insights-rewards/rakeback/roi.ts`).
 *
 * PARITY: rakeback cost in window (Σ rakeback_amount_usd over in-window claims)
 * vs claimants' subsequent gameplay GGR — the wager-side minus payout-side
 * ledger rows that landed AFTER each claimant's FIRST in-window claim, bounded
 * to the lookback. Wager = pack_opening + battle_bet + battle_sponsorship +
 * upgrader_bet; payout = battle_refund + upgrader_payout (matches the PG twin).
 *
 * The forward grand-sums equal the PG twin's `SUM(per-user SUM(...))` (grouping
 * is associative), so the forward leg is one grand aggregate over the joined
 * set; the cost + claimant count come from the same in-window claim slice.
 *
 * Lookback bound (mirrors PG EXACTLY):
 *   • finite window → `lt.created_at <= first_claim_at + effectiveLookback days`
 *     (effectiveLookback collapses to the period itself for windows ≤ 3d).
 *   • lifetime      → forward scan bounded to the last 365 days
 *     (`lt.created_at >= now − 365d`), reported as `lookbackDays = 365`.
 *
 * SCOPE (mirrors PG EXACTLY): wholesale customer scope
 * `role NOT IN ('admin','support','creator')` + blacklist — `customerScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on both joined tables,
 * `uniqExact` for the claimant count, money Decimal (`toString(sum(...))`,
 * scale-matched `toDecimal128(0, 2)` zero-branch), `toNumber` in TS.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors LIFETIME_PAIRING_LOOKBACK_DAYS in deposit-bonus/_shared (the PG twin's
// lifetime forward-scan bound). Inlined so this CH module never imports a
// Postgres/Prisma client (CQRS boundary).
const LIFETIME_LOOKBACK_DAYS = 365;

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";
const PAYOUT_TYPES = "('battle_refund','upgrader_payout')";
const ALL_TYPES =
  "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet','battle_refund','upgrader_payout')";

type CostRow = { cost: string; claimants: string };
type ForwardRow = { wager: string; payouts: string };

export async function getRakebackRoiFromClickHouse(
  period: InsightsRewardsPeriod,
  lookbackDays: RakebackRoiLookback,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackRoi> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const effectiveLookback =
    days !== null && days <= 3 ? Math.max(days, 1) : lookbackDays;

  const baseParams: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    baseParams.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  // Cost + distinct claimants over the in-window claim slice.
  const costSql = `
    WITH ${scope}
    SELECT
      toString(sum(rc.rakeback_amount_usd)) AS cost,
      toString(uniqExact(rc.user_id))       AS claimants
    FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
    WHERE rc._peerdb_is_deleted = 0
      AND rc.claimed_at IS NOT NULL
      AND rc.user_id IN (SELECT id FROM real_users)
      ${dateClause}`;

  // Forward play. first_claim = per-user MIN(claimed_at) within the window;
  // the forward grand-sum joins ledger rows that landed at/after that floor,
  // bounded by the lookback.
  const forwardParams: Record<string, unknown> = { ...baseParams };
  let lookbackClause: string;
  if (days !== null) {
    lookbackClause = `AND lt.created_at <= addDays(fc.first_claim_at, ${effectiveLookback})`;
  } else {
    forwardParams.cutoff365 = chDateTime(
      new Date(now.getTime() - LIFETIME_LOOKBACK_DAYS * DAY_MS),
    );
    lookbackClause = "AND lt.created_at >= {cutoff365:DateTime64(6)}";
  }

  const forwardSql = `
    WITH
      ${scope},
      first_claim AS (
        SELECT rc.user_id AS user_id, min(rc.claimed_at) AS first_claim_at
        FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.claimed_at IS NOT NULL
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}
        GROUP BY rc.user_id
      )
    SELECT
      toString(sum(if(lt.type IN ${WAGER_TYPES}, abs(lt.amount), toDecimal128(0, 2))))  AS wager,
      toString(sum(if(lt.type IN ${PAYOUT_TYPES}, abs(lt.amount), toDecimal128(0, 2)))) AS payouts
    FROM first_claim AS fc
    INNER JOIN ${CH_DB}.public_ledger_transactions AS lt FINAL
      ON lt.user_id = fc.user_id
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ${ALL_TYPES}
      AND lt.created_at >= fc.first_claim_at
      ${lookbackClause}`;

  const [costRows, forwardRows] = await Promise.all([
    clickhouseRead.query<CostRow>({
      queryName: "insights.rewards.rakeback.roi.cost",
      sql: costSql,
      params: baseParams,
    }),
    clickhouseRead.query<ForwardRow>({
      queryName: "insights.rewards.rakeback.roi.forward",
      sql: forwardSql,
      params: forwardParams,
    }),
  ]);

  const cost = toNumber(costRows[0]?.cost);
  const claimants = Number(costRows[0]?.claimants ?? 0);
  const wager = toNumber(forwardRows[0]?.wager);
  const payouts = toNumber(forwardRows[0]?.payouts);
  const subsequentGgr = wager - payouts;
  const roiRatio = cost > 0 ? subsequentGgr / cost : null;
  const netReturn = subsequentGgr - cost;

  return {
    cost,
    subsequentGgr,
    roiRatio,
    netReturn,
    claimants,
    lookbackDays: days === null ? LIFETIME_LOOKBACK_DAYS : effectiveLookback,
  };
}
