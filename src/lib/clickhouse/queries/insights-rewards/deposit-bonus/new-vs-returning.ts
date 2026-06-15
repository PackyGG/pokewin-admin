import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusNewVsReturning } from "@/lib/queries/insights-rewards/deposit-bonus/behavior";

import { CH_DB, toNumber } from "../../_shared";
import {
  cutoffClause,
  depositBonusCutoff,
  depositBonusScopeCte,
} from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus new-vs-returning cohort
 * (`getDepositBonusNewVsReturning` → `computeNewVsReturning` in
 * `src/lib/queries/insights-rewards/deposit-bonus/behavior.ts`).
 *
 * Classifies in-window claimants as "new" (no deposit_bonus before the window
 * start) vs "returning". Per cohort: users, Σ bonus volume (window), 7d
 * retention count, second-deposit-within-30d count are count/cent-exact and
 * gated; `retain7d` / `secondDeposit30dRate` are derived in TS. The
 * `avgFirstDepositUsd` (latest deposit at-or-before the first claim, via
 * `argMax`) is returned for shape parity but NOT gated — its source is a
 * tie-ambiguous "latest deposit" pick fed into a `numeric` AVG that CH's
 * Float64 AVG cannot reproduce bit-exactly.
 *
 * Retention / second-deposit use `arrayExists` over per-user wager / deposit
 * timestamp arrays (>= window start) to reproduce PG's `EXISTS` booleans
 * without a row-exploding cross join. 2-role customer scope + blacklist.
 */

const WAGER_TYPES = "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

export async function getDepositBonusNewVsReturningFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusNewVsReturning> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCutoff(period, now);
  const windowStart = cutoff; // window-start lower bound (null on lifetime → all "new")
  const params: Record<string, unknown> = { blacklist, cutoff };

  // "Prior" claimant set: deposit_bonus rows BEFORE the window start. On
  // lifetime (windowStart null) this set is empty → every claimant is "new",
  // mirroring PG's `created_at < -infinity` → false. The empty branch selects
  // the real (String) user_id column with `1=0` so the `IN` type matches.
  const priorCte =
    windowStart !== null
      ? `prior_claimants AS (
          SELECT DISTINCT lt.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit_bonus'
            AND lt.created_at < {cutoff:DateTime64(6)}
        )`
      : `prior_claimants AS (
          SELECT lt.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt
          WHERE 1 = 0
        )`;

  const sql = `
    WITH ${scope},
    first_claim AS (
      SELECT lt.user_id AS user_id, min(lt.created_at) AS first_claim_at
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    ),
    ${priorCte},
    classified AS (
      SELECT
        fc.user_id AS user_id,
        fc.first_claim_at AS first_claim_at,
        if(fc.user_id IN (SELECT user_id FROM prior_claimants), 'returning', 'new') AS cohort
      FROM first_claim AS fc
    ),
    bonus_total AS (
      SELECT lt.user_id AS user_id, sum(abs(lt.amount)) AS bonus
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM classified)
        ${cutoffClause(cutoff, "lt")}
      GROUP BY lt.user_id
    ),
    first_deposit AS (
      SELECT c.user_id AS user_id, argMax(abs(d.amount), d.created_at) AS first_dep_usd
      FROM classified AS c
      INNER JOIN ${CH_DB}.public_ledger_transactions AS d FINAL
        ON d.user_id = c.user_id
      WHERE d._peerdb_is_deleted = 0
        AND d.status = 'completed'
        AND d.type = 'deposit'
        AND d.created_at <= c.first_claim_at
      GROUP BY c.user_id
    ),
    wager_by_user AS (
      SELECT w.user_id AS user_id, groupArray(w.created_at) AS ts
      FROM ${CH_DB}.public_ledger_transactions AS w FINAL
      INNER JOIN classified AS c ON c.user_id = w.user_id
      WHERE w._peerdb_is_deleted = 0
        AND w.status = 'completed'
        AND w.type IN ${WAGER_TYPES}
        AND w.created_at > c.first_claim_at
      GROUP BY w.user_id
    ),
    deposit_by_user AS (
      SELECT d.user_id AS user_id, groupArray(d.created_at) AS ts
      FROM ${CH_DB}.public_ledger_transactions AS d FINAL
      INNER JOIN classified AS c ON c.user_id = d.user_id
      WHERE d._peerdb_is_deleted = 0
        AND d.status = 'completed'
        AND d.type = 'deposit'
        AND d.created_at > c.first_claim_at
      GROUP BY d.user_id
    ),
    per_user AS (
      SELECT
        c.cohort AS cohort,
        coalesce(bt.bonus, toDecimal128(0, 2)) AS bonus,
        fd.first_dep_usd AS first_dep_usd,
        arrayExists(t -> t > c.first_claim_at + INTERVAL 1 HOUR AND t <= c.first_claim_at + INTERVAL 7 DAY, coalesce(wbu.ts, [])) AS r7,
        arrayExists(t -> t > c.first_claim_at + INTERVAL 1 HOUR AND t <= c.first_claim_at + INTERVAL 30 DAY, coalesce(dbu.ts, [])) AS second_dep
      FROM classified AS c
      LEFT JOIN bonus_total AS bt ON bt.user_id = c.user_id
      LEFT JOIN first_deposit AS fd ON fd.user_id = c.user_id
      LEFT JOIN wager_by_user AS wbu ON wbu.user_id = c.user_id
      LEFT JOIN deposit_by_user AS dbu ON dbu.user_id = c.user_id
    )
    SELECT
      cohort                                       AS cohort,
      toString(count())                            AS users,
      toString(sum(bonus))                         AS bonus_total,
      toString(avg(first_dep_usd))                 AS avg_first_deposit,
      toString(countIf(r7))                        AS retain7d_users,
      toString(countIf(second_dep))                AS second_dep_users
    FROM per_user
    GROUP BY cohort`;

  const rows = await clickhouseRead.query<{
    cohort: "new" | "returning";
    users: string;
    bonus_total: string;
    avg_first_deposit: string | null;
    retain7d_users: string;
    second_dep_users: string;
  }>({
    queryName: "insights.deposit_bonus.new_vs_returning",
    sql,
    params,
    timeoutMs: 30_000,
  });

  const parseSide = (cohort: "new" | "returning") => {
    const row = rows.find((r) => r.cohort === cohort);
    const users = Number(row?.users ?? 0);
    const totalBonus = toNumber(row?.bonus_total);
    return {
      users,
      totalBonus,
      avgBonusPerUser: users > 0 ? totalBonus / users : 0,
      avgFirstDepositUsd:
        row?.avg_first_deposit != null && row.avg_first_deposit !== ""
          ? toNumber(row.avg_first_deposit)
          : 0,
      retain7d: users > 0 ? Number(row?.retain7d_users ?? 0) / users : 0,
      secondDeposit30dRate:
        users > 0 ? Number(row?.second_dep_users ?? 0) / users : 0,
    };
  };

  return {
    newClaimants: parseSide("new"),
    returningClaimants: parseSide("returning"),
  };
}
