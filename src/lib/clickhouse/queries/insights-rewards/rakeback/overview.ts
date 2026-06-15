import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RakebackOverview } from "@/lib/queries/insights-rewards/rakeback/overview";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackOverview`
 * (`src/lib/queries/insights-rewards/rakeback/overview.ts`).
 *
 * PARITY: source is `public_rakeback_claims` (claimed_at non-null), summing
 * `rakeback_amount_usd` + `wagered_amount_usd` and counting rows / distinct
 * claimants in the active window, plus the prior-equal window for the
 * period-over-period deltas (null for lifetime). Returns the SAME
 * `RakebackOverview` shape — the per-claim average + the three deltas are
 * derived in TS with the IDENTICAL arithmetic the PG twin uses.
 *
 * SCOPE (mirrors PG EXACTLY): wholesale customer scope
 * `role NOT IN ('admin','support','creator')` (creators dropped) + the dynamic
 * `excluded_users` blacklist — `customerScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for the exact
 * distinct-claimant count (never the approximate `uniq`), money kept Decimal
 * (`toString(sum(...))` → `toNumber`, never Float). The window cutoff is derived
 * from a single caller-supplied `now` via `daysForInsightsPeriod`, matching the
 * PG `NOW() - INTERVAL 'N days'` arithmetic (prod runs UTC).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type AggRow = {
  total_rakeback: string;
  cnt: string;
  distinct_users: string;
  total_wager: string;
  largest: string;
};

function buildAggSql(scope: string, dateClause: string): string {
  return `
    WITH ${scope}
    SELECT
      toString(sum(rc.rakeback_amount_usd)) AS total_rakeback,
      toString(count())                     AS cnt,
      toString(uniqExact(rc.user_id))       AS distinct_users,
      toString(sum(rc.wagered_amount_usd))  AS total_wager,
      toString(max(rc.rakeback_amount_usd)) AS largest
    FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
    WHERE rc._peerdb_is_deleted = 0
      AND rc.claimed_at IS NOT NULL
      AND rc.user_id IN (SELECT id FROM real_users)
      ${dateClause}`;
}

export async function getRakebackOverviewFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackOverview> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let currentDateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    currentDateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const currentRows = await clickhouseRead.query<AggRow>({
    queryName: "insights.rewards.rakeback.overview.current",
    sql: buildAggSql(scope, currentDateClause),
    params,
  });
  const cur = currentRows[0];
  const totalRakeback = toNumber(cur?.total_rakeback);
  const count = Number(cur?.cnt ?? 0);
  const distinctClaimants = Number(cur?.distinct_users ?? 0);
  const totalWager = toNumber(cur?.total_wager);
  const largestClaim = toNumber(cur?.largest);
  const avgPerClaim = count > 0 ? totalRakeback / count : 0;

  let priorWindow: RakebackOverview["priorWindow"] = null;
  if (days !== null) {
    const priorParams: Record<string, unknown> = {
      blacklist,
      cutoffPriorStart: chDateTime(new Date(now.getTime() - days * 2 * DAY_MS)),
      cutoffCurrent: chDateTime(new Date(now.getTime() - days * DAY_MS)),
    };
    const priorRows = await clickhouseRead.query<AggRow>({
      queryName: "insights.rewards.rakeback.overview.prior",
      sql: buildAggSql(
        scope,
        "AND rc.claimed_at >= {cutoffPriorStart:DateTime64(6)} AND rc.claimed_at < {cutoffCurrent:DateTime64(6)}",
      ),
      params: priorParams,
    });
    const prev = priorRows[0];
    const prevRakeback = toNumber(prev?.total_rakeback);
    const prevCount = Number(prev?.cnt ?? 0);
    const prevClaimants = Number(prev?.distinct_users ?? 0);
    const delta = (nowVal: number, prevVal: number): number | null =>
      prevVal > 0 ? (nowVal - prevVal) / prevVal : null;
    priorWindow = {
      totalRakeback: prevRakeback,
      count: prevCount,
      distinctClaimants: prevClaimants,
      rakebackDelta: delta(totalRakeback, prevRakeback),
      countDelta: delta(count, prevCount),
      claimantDelta: delta(distinctClaimants, prevClaimants),
    };
  }

  return {
    totalRakeback,
    count,
    distinctClaimants,
    totalWager,
    avgPerClaim,
    largestClaim,
    priorWindow,
  };
}
