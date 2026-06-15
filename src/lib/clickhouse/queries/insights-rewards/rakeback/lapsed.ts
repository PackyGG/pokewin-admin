import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackLapsed,
  RakebackLapsedReason,
  RakebackLapsedRow,
} from "@/lib/queries/insights-rewards/rakeback/lapsed";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackLapsed`
 * (`src/lib/queries/insights-rewards/rakeback/lapsed.ts`).
 *
 * PARITY: users who claimed in the PRIOR-equal window `[now-2d, now-d)` (Σ
 * rakeback > 0) but NOT in the current window `[now-d, now]`. Each lapsed user
 * carries current/prior deposit + wager signal columns (LEFT-JOINed completed
 * ledger over the trailing 2d window) so the row set + aggregates match. The
 * classification, totals, reason split, and top-25 sample are computed in TS
 * with the BYTE-IDENTICAL logic the PG twin uses. Lifetime (`all`) → null (no
 * prior frame), exactly like PG.
 *
 * SCOPE (mirrors PG EXACTLY — NOT the wholesale customer scope): the lapsed leg
 * uses the admin/support-only scope `role NOT IN ('admin','support')` (creators
 * are KEPT) + the dynamic blacklist. Written inline (NOT `customerScopeCte`,
 * which would also drop creators — that would be a scope change).
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table, money
 * Decimal (`toString(sum(...))`, scale-matched `toDecimal128(0, 2)` zero-branch),
 * `toNumber` in TS.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 25;
const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

type Row = {
  user_id: string;
  username: string | null;
  prior_rakeback: string;
  prior_claims: string;
  current_deposit: string;
  prior_deposit: string;
  current_wager: string;
  prior_wager: string;
};

function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

export async function getRakebackLapsedFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackLapsed | null> {
  const days = daysForInsightsPeriod(period);
  if (days === null) return null;

  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    blacklist,
    cutoffCurrent: chDateTime(new Date(now.getTime() - days * DAY_MS)),
    cutoffPriorStart: chDateTime(new Date(now.getTime() - days * 2 * DAY_MS)),
  };

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.rewards.rakeback.lapsed",
    sql: `
      WITH
        ${realUsersCte(hasBlacklist)},
        current_users AS (
          SELECT DISTINCT rc.user_id AS user_id
          FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
          WHERE rc._peerdb_is_deleted = 0
            AND rc.claimed_at IS NOT NULL
            AND rc.user_id IN (SELECT id FROM real_users)
            AND rc.claimed_at >= {cutoffCurrent:DateTime64(6)}
        ),
        prior_lapsed AS (
          SELECT
            rc.user_id AS user_id,
            sum(rc.rakeback_amount_usd) AS prior_rakeback,
            count() AS prior_claims
          FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
          WHERE rc._peerdb_is_deleted = 0
            AND rc.claimed_at IS NOT NULL
            AND rc.user_id IN (SELECT id FROM real_users)
            AND rc.claimed_at >= {cutoffPriorStart:DateTime64(6)}
            AND rc.claimed_at <  {cutoffCurrent:DateTime64(6)}
          GROUP BY rc.user_id
          HAVING sum(rc.rakeback_amount_usd) > 0
        ),
        lapsed AS (
          SELECT user_id, prior_rakeback, prior_claims
          FROM prior_lapsed
          WHERE user_id NOT IN (SELECT user_id FROM current_users)
        ),
        ledger AS (
          SELECT lt.user_id AS user_id, lt.type AS type, lt.amount AS amount, lt.created_at AS created_at
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.created_at >= {cutoffPriorStart:DateTime64(6)}
            AND lt.user_id IN (SELECT user_id FROM lapsed)
        ),
        activity AS (
          SELECT
            l.user_id AS user_id,
            sum(if(lt.type = 'deposit' AND lt.created_at >= {cutoffCurrent:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2))) AS current_deposit,
            sum(if(lt.type = 'deposit' AND lt.created_at >= {cutoffPriorStart:DateTime64(6)} AND lt.created_at < {cutoffCurrent:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2))) AS prior_deposit,
            sum(if(lt.type IN ${WAGER_TYPES} AND lt.created_at >= {cutoffCurrent:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2))) AS current_wager,
            sum(if(lt.type IN ${WAGER_TYPES} AND lt.created_at >= {cutoffPriorStart:DateTime64(6)} AND lt.created_at < {cutoffCurrent:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2))) AS prior_wager
          FROM lapsed AS l
          LEFT JOIN ledger AS lt ON lt.user_id = l.user_id
          GROUP BY l.user_id
        )
      SELECT
        l.user_id                   AS user_id,
        u.username                  AS username,
        toString(l.prior_rakeback)  AS prior_rakeback,
        toString(l.prior_claims)    AS prior_claims,
        toString(a.current_deposit) AS current_deposit,
        toString(a.prior_deposit)   AS prior_deposit,
        toString(a.current_wager)   AS current_wager,
        toString(a.prior_wager)     AS prior_wager
      FROM lapsed AS l
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = l.user_id
      INNER JOIN activity AS a ON a.user_id = l.user_id
      WHERE u._peerdb_is_deleted = 0
      ORDER BY l.prior_rakeback DESC`,
    params,
  });

  // Identical post-processing to the PG twin's computeLapsed.
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
