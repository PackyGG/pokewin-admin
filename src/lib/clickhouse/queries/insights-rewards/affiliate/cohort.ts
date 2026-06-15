import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { AffiliateCohortRow } from "@/lib/queries/insights-rewards/affiliate/cohort";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateCohort`
 * (`src/lib/queries/insights-rewards/affiliate/cohort.ts`).
 *
 * PARITY: top 15 affiliates by in-window downstream wager, each with their
 * referred-cohort conversion — active referred users, cohort wager, first-/
 * repeat-deposit conversion (LIFETIME deposits per referred user), and the avg
 * "first deposit" proxy (`MIN(ABS(amount))` over completed deposits). Derived
 * ratios computed in TS, identical to PG.
 *
 * SCOPE (mirrors PG EXACTLY): the top-affiliate selection scopes the affiliate
 * `user` to admin/support only `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist on `user.id`. The cohort + deposit aggregates are unscoped by role
 * (PG only scopes the top-affiliate pick), so they are left unscoped here too.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table,
 * `uniqExact`/`uniqExactIf` for distinct cohort counts, money Decimal. The
 * deposit pairing aggregates deposits per referred user FIRST, then LEFT JOINs
 * the cohort pairs under `join_use_nulls = 1` so a no-deposit pair resolves to a
 * proper zero count + NULL first-deposit proxy (avoiding the LEFT-JOIN default
 * trap that would otherwise count phantom deposits).
 *
 * NOTE: top-15 by wager has no tiebreaker on either engine; the compare hook
 * diffs the row-set AGGREGATE (Σ referred, Σ wager, Σ depositors, …), stable
 * whenever the top-15 wager sums are distinct.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_AFFILIATES_LIMIT = 15;

type Row = {
  affiliate_user_id: string;
  username: string | null;
  referred_active: string;
  cohort_wager: string;
  depositors: string;
  repeat_depositors: string;
  avg_first_deposit: string;
};

export async function getAffiliateCohortFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<AffiliateCohortRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let acuDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    acuDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.cohort",
    sql: `
      WITH
        top_affiliates AS (
          SELECT acu.affiliate_user_id AS affiliate_user_id
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = acu.affiliate_user_id
          WHERE acu._peerdb_is_deleted = 0
            AND u._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            AND u.role NOT IN ('admin','support')
            ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
            ${acuDate}
          GROUP BY acu.affiliate_user_id
          HAVING sum(acu.wager_amount_usd) > 0
          ORDER BY sum(acu.wager_amount_usd) DESC
          LIMIT ${TOP_AFFILIATES_LIMIT}
        ),
        cohort AS (
          SELECT DISTINCT
            acu.affiliate_user_id AS affiliate_user_id,
            acu.referred_user_id  AS referred_user_id
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            AND acu.affiliate_user_id IN (SELECT affiliate_user_id FROM top_affiliates)
            ${acuDate}
        ),
        cohort_wager AS (
          SELECT
            acu.affiliate_user_id      AS affiliate_user_id,
            sum(acu.wager_amount_usd)  AS wager
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            AND acu.affiliate_user_id IN (SELECT affiliate_user_id FROM top_affiliates)
            ${acuDate}
          GROUP BY acu.affiliate_user_id
        ),
        deposits AS (
          SELECT
            lt.user_id              AS referred_user_id,
            count()                 AS deposit_count,
            min(abs(lt.amount))     AS first_deposit_proxy
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit'
            AND lt.user_id IN (SELECT referred_user_id FROM cohort)
          GROUP BY lt.user_id
        ),
        deposits_per_user AS (
          SELECT
            c.affiliate_user_id            AS affiliate_user_id,
            c.referred_user_id             AS referred_user_id,
            coalesce(d.deposit_count, 0)   AS deposit_count,
            d.first_deposit_proxy          AS first_deposit_proxy
          FROM cohort AS c
          LEFT JOIN deposits AS d ON d.referred_user_id = c.referred_user_id
        ),
        cohort_summary AS (
          SELECT
            affiliate_user_id,
            uniqExact(referred_user_id)                          AS referred_active,
            uniqExactIf(referred_user_id, deposit_count >= 1)    AS depositors,
            uniqExactIf(referred_user_id, deposit_count >= 2)    AS repeat_depositors,
            avgIf(first_deposit_proxy, deposit_count >= 1)       AS avg_first_deposit
          FROM deposits_per_user
          GROUP BY affiliate_user_id
        )
      SELECT
        cs.affiliate_user_id                                   AS affiliate_user_id,
        u.username                                             AS username,
        toString(cs.referred_active)                           AS referred_active,
        toString(coalesce(cw.wager, toDecimal128(0, 2)))       AS cohort_wager,
        toString(cs.depositors)                                AS depositors,
        toString(cs.repeat_depositors)                         AS repeat_depositors,
        toString(coalesce(cs.avg_first_deposit, 0))            AS avg_first_deposit
      FROM cohort_summary AS cs
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = cs.affiliate_user_id
      LEFT JOIN cohort_wager AS cw ON cw.affiliate_user_id = cs.affiliate_user_id
      WHERE u._peerdb_is_deleted = 0
      ORDER BY coalesce(cw.wager, toDecimal128(0, 2)) DESC
      SETTINGS join_use_nulls = 1`,
    params,
  });

  return rows.map((r) => {
    const referredActive = Number(r.referred_active);
    const depositors = Number(r.depositors);
    const repeatDepositors = Number(r.repeat_depositors);
    const cohortWager = toNumber(r.cohort_wager);
    return {
      affiliateUserId: r.affiliate_user_id,
      username: r.username,
      referredActive,
      cohortWager,
      avgWagerPerReferred: referredActive > 0 ? cohortWager / referredActive : 0,
      depositors,
      repeatDepositors,
      depositConversion: referredActive > 0 ? depositors / referredActive : 0,
      repeatConversion: referredActive > 0 ? repeatDepositors / referredActive : 0,
      avgFirstDepositUsd: toNumber(r.avg_first_deposit),
    };
  });
}
