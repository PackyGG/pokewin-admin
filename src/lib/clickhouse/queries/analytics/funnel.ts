import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "../_shared";

/**
 * ClickHouse twin of `@/lib/queries/analytics-funnel` `getFunnelData` — the
 * acquisition funnel (clicks → signups → first-deposit → first-wager →
 * repeat-depositor → monthly-active-wagerer), read from the `packy_prod` CDC
 * mirror. Comparison-mode only; the served value is always the Postgres value.
 *
 * SCOPE mirrored EXACTLY from the PG twin:
 *   • clicks = COUNT of affiliate_clicks in the period window — NO user scope.
 *   • cohort = users with role NOT IN ('admin','support') (creators KEPT) +
 *     excluded-users blacklist, signup within the period window.
 *   • later steps are computed from that signup cohort (first-deposit from the
 *     balances.total_deposited > 0 flag; first-wager / repeat-depositor / MAW
 *     from the completed ledger rows of the 4-type wager set including
 *     `upgrader_bet`; MAW uses a fixed NOW()-30d window).
 *
 * The 4-type wager set (incl. `upgrader_bet`) and `deposit` literals are inlined
 * (CQRS boundary: no Postgres/Prisma import, direct or transitive).
 */

export type FunnelPeriod = "7d" | "30d" | "90d" | "all";

export type FunnelStepCh = {
  key: string;
  label: string;
  description: string;
  count: number;
  dropoffFromPrev: number | null;
  conversionFromTop: number;
};

export type FunnelDataCh = {
  period: FunnelPeriod;
  steps: FunnelStepCh[];
};

function daysForPeriod(period: FunnelPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

const MAW_CUTOFF_DAYS = 30;
// Funnel wager set is the 4-type set (incl. upgrader_bet) — matches the PG twin.
const WAGER_FUNNEL_TYPES =
  "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

export async function getFunnelDataFromClickHouse(
  period: FunnelPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<FunnelDataCh> {
  const days = daysForPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  let cohortDateFilter = "";
  let clicksDateFilter = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * 86_400_000));
    cohortDateFilter = "AND created_at >= {cutoff:DateTime64(6)}";
    clicksDateFilter = "AND created_at >= {cutoff:DateTime64(6)}";
  }
  // MAW cutoff is a fixed NOW()-30d window, independent of the period.
  params.mawCutoff = chDateTime(
    new Date(now.getTime() - MAW_CUTOFF_DAYS * 86_400_000),
  );

  const blacklistClause = hasBlacklist
    ? "AND id NOT IN {blacklist:Array(String)}"
    : "";

  const cohortCte = `cohort AS (
      SELECT id, created_at
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${blacklistClause}
        ${cohortDateFilter}
    )`;

  const clicksSql = `
    SELECT toString(count()) AS count
    FROM ${CH_DB}.public_affiliate_clicks FINAL
    WHERE _peerdb_is_deleted = 0
      ${clicksDateFilter}`;

  const signupsSql = `
    WITH ${cohortCte}
    SELECT toString(count()) AS count FROM cohort`;

  // first-deposit step = cohort users whose balances row has total_deposited > 0
  // (BOOL_OR(total_deposited > 0) in the PG twin). balances is 1 row/user (FINAL).
  const firstDepositSql = `
    WITH ${cohortCte}
    SELECT toString(uniqExact(b.user_id)) AS count
    FROM ${CH_DB}.public_balances AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.total_deposited > 0
      AND b.user_id IN (SELECT id FROM cohort)`;

  // first-wager / repeat-depositor / MAW from completed ledger rows of the
  // cohort. status='completed' in WHERE is equivalent to the PG per-FILTER
  // status check (non-completed rows contribute 0 to every count).
  const ledgerSql = `
    WITH
      ${cohortCte},
      agg AS (
        SELECT
          lt.user_id AS user_id,
          countIf(lt.type = 'deposit') AS deposit_count,
          countIf(lt.type IN ${WAGER_FUNNEL_TYPES}) AS wager_count,
          countIf(
            lt.type IN ${WAGER_FUNNEL_TYPES}
            AND lt.created_at >= {mawCutoff:DateTime64(6)}
          ) AS wager_count_30d
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.user_id IN (SELECT id FROM cohort)
        GROUP BY lt.user_id
      )
    SELECT
      toString(countIf(wager_count > 0))     AS first_wager,
      toString(countIf(deposit_count >= 2))  AS repeat_deposit,
      toString(countIf(wager_count_30d > 0)) AS maw
    FROM agg`;

  const [clicksRows, signupRows, fdRows, ledgerRows] = await Promise.all([
    clickhouseRead.query<{ count: string }>({
      queryName: "analytics.funnel.clicks",
      sql: clicksSql,
      params,
    }),
    clickhouseRead.query<{ count: string }>({
      queryName: "analytics.funnel.signups",
      sql: signupsSql,
      params,
    }),
    clickhouseRead.query<{ count: string }>({
      queryName: "analytics.funnel.first_deposit",
      sql: firstDepositSql,
      params,
    }),
    clickhouseRead.query<{
      first_wager: string;
      repeat_deposit: string;
      maw: string;
    }>({
      queryName: "analytics.funnel.ledger",
      sql: ledgerSql,
      params,
    }),
  ]);

  const clicks = Number(clicksRows[0]?.count ?? 0);
  const signups = Number(signupRows[0]?.count ?? 0);
  const firstDeposit = Number(fdRows[0]?.count ?? 0);
  const lg = ledgerRows[0];
  const firstWager = Number(lg?.first_wager ?? 0);
  const repeatDeposit = Number(lg?.repeat_deposit ?? 0);
  const maw = Number(lg?.maw ?? 0);

  const raw = [
    {
      key: "clicks",
      label: "Unique Visitors",
      description: "Distinct affiliate-link clicks",
      count: clicks,
    },
    {
      key: "signups",
      label: "Signups",
      description: "User rows created in period",
      count: signups,
    },
    {
      key: "first_deposit",
      label: "First Deposit",
      description: "At least one completed deposit",
      count: firstDeposit,
    },
    {
      key: "first_wager",
      label: "First Wager",
      description: "At least one pack/battle bet",
      count: firstWager,
    },
    {
      key: "repeat_depositor",
      label: "Repeat Depositor",
      description: "Two or more completed deposits",
      count: repeatDeposit,
    },
    {
      key: "maw",
      label: "Monthly Active Wagerer",
      description: "Wagered in the last 30 days",
      count: maw,
    },
  ];

  const top = raw[0]?.count ?? 0;
  const steps: FunnelStepCh[] = raw.map((r, i) => {
    const prev = i === 0 ? null : raw[i - 1].count;
    const dropoff = prev == null || prev === 0 ? null : 1 - r.count / prev;
    const conversionFromTop = top === 0 ? 0 : r.count / top;
    return { ...r, dropoffFromPrev: dropoff, conversionFromTop };
  });

  return { period, steps };
}
