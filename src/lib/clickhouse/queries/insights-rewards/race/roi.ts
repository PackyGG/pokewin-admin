import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RaceRoiResult } from "@/lib/queries/insights-rewards/race/roi";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsROI`
 * (`src/lib/queries/insights-rewards/race/roi.ts`).
 *
 * PARITY: cost = Σ ABS(amount) for completed `race_prize` ledger rows in window
 * (the cost claimants, with their first race_prize timestamp); forward GGR =
 * Σ wager − Σ payout over the SAME claimants in the forward window
 * (`>= claim_at AND < claim_at + lookbackDays` for finite windows; `>= claim_at`
 * unbounded for lifetime). Wager/payout type sets match `getGgrBreakdown`:
 * wagers = pack_opening + battle_bet + battle_sponsorship + upgrader_bet;
 * payouts = battle_refund + upgrader_payout. `subsequentGgr`, `roi`, and
 * `avgGgrPerWinner` are derived in TS identically to the PG twin.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist on the cost claimants — `raceScopeCte`. The forward legs join only
 * cost_claimants (already scoped), exactly like the PG twin.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, money Decimal
 * (`toString(sum(abs(...)))` → `toNumber`) with scale-matched `toDecimal128(0,2)`
 * zero-branch; lookback bound as a `{lookback:UInt32}` param.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

function resolveLookback(
  period: InsightsRewardsPeriod,
  rawLookback: number,
): number {
  if (period === "24h") return 1;
  if (period === "3d") return 3;
  return Math.max(1, Math.min(rawLookback, 180));
}

type Row = { cost: string; claimants: string; wager: string; payout: string };

export async function getRaceInsightsROIFromClickHouse(
  period: InsightsRewardsPeriod,
  rawLookbackDays: number,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaceRoiResult> {
  const days = daysForInsightsPeriod(period);
  const lookbackDays = resolveLookback(period, rawLookbackDays);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let costDateClause = "";
  let forwardWindowClause = "AND lt.created_at >= cc.claim_at";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    params.lookback = lookbackDays;
    costDateClause = "AND lt.created_at >= {cutoff:DateTime64(6)}";
    forwardWindowClause =
      "AND lt.created_at >= cc.claim_at AND lt.created_at < addDays(cc.claim_at, {lookback:UInt32})";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.rewards.race.roi",
    sql: `
      WITH
        ${scope},
        cost_claimants AS (
          SELECT
            lt.user_id           AS user_id,
            min(lt.created_at)   AS claim_at,
            sum(abs(lt.amount))  AS cost
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'race_prize'
            AND lt.user_id IN (SELECT id FROM real_users)
            ${costDateClause}
          GROUP BY lt.user_id
        ),
        forward_wagers AS (
          SELECT cc.user_id AS user_id, sum(abs(lt.amount)) AS wager
          FROM cost_claimants AS cc
          INNER JOIN ${CH_DB}.public_ledger_transactions AS lt FINAL
            ON lt.user_id = cc.user_id
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type IN ${WAGER_TYPES_SQL}
            ${forwardWindowClause}
          GROUP BY cc.user_id
        ),
        forward_payouts AS (
          SELECT cc.user_id AS user_id, sum(abs(lt.amount)) AS payout
          FROM cost_claimants AS cc
          INNER JOIN ${CH_DB}.public_ledger_transactions AS lt FINAL
            ON lt.user_id = cc.user_id
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type IN ${PAYOUT_TYPES_SQL}
            ${forwardWindowClause}
          GROUP BY cc.user_id
        )
      SELECT
        toString(sum(cc.cost))   AS cost,
        toString(count())        AS claimants,
        toString(sum(coalesce(fw.wager, toDecimal128(0, 2))))  AS wager,
        toString(sum(coalesce(fp.payout, toDecimal128(0, 2)))) AS payout
      FROM cost_claimants AS cc
      LEFT JOIN forward_wagers AS fw ON fw.user_id = cc.user_id
      LEFT JOIN forward_payouts AS fp ON fp.user_id = cc.user_id`,
    params,
  });

  const r = rows[0];
  const cost = toNumber(r?.cost);
  const claimantCount = Number(r?.claimants ?? 0);
  const subsequentWager = toNumber(r?.wager);
  const subsequentPayout = toNumber(r?.payout);
  const subsequentGgr = subsequentWager - subsequentPayout;
  const roi = cost > 0 ? subsequentGgr / cost : null;
  const avgGgrPerWinner =
    claimantCount > 0 ? subsequentGgr / claimantCount : 0;

  return {
    cost,
    claimantCount,
    subsequentWager,
    subsequentPayout,
    subsequentGgr,
    roi,
    avgGgrPerWinner,
    lookbackDays,
  };
}
