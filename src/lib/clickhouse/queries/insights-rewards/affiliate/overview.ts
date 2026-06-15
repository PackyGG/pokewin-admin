import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { AffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateOverview`
 * (`src/lib/queries/insights-rewards/affiliate/overview.ts`).
 *
 * PARITY: four legs mirrored exactly —
 *   1. claim rollup over `ledger_transactions` (`affiliate_claim` +
 *      `affiliate_leaderboard_prize`, status='completed') in the active window;
 *   2. usage rollup over `affiliate_code_usages` (status='completed') in window;
 *   3. daily commission (`affiliate_claim`) capped at the 90-day chart horizon;
 *   4. daily downstream wager capped at the same horizon.
 * Every derived figure (avg, ROI, commission %, the zero-filled daily series) is
 * computed in TS with the IDENTICAL arithmetic the PG twin uses.
 *
 * SCOPE (mirrors PG EXACTLY — note the two scopes differ per leg, as in PG):
 *   - claim legs: WHOLESALE customer scope `role NOT IN ('admin','support',
 *     'creator')` (creators dropped) + blacklist on the affiliate `user.id`.
 *   - usage legs: NO role filter (the affiliate earns off referred wager
 *     regardless of who referred), only the blacklist on `affiliate_user_id`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table,
 * `uniqExact`/`uniqExactIf` for exact distinct counts, money kept Decimal
 * (`toString(sum(...))` / `sumIf` over `abs(amount)`), `toNumber` in TS. Window
 * cutoffs derived from one caller-supplied `now`, matching PG's
 * `NOW() - INTERVAL 'N days'`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHART_DAYS = 90;

type ClaimRow = {
  affiliates: string;
  total: string;
  cnt: string;
  lb_total: string;
  lb_cnt: string;
};
type UsageRow = { wager: string; referred: string };
type DailyClaimRow = { day: string; total: string; cnt: string };
type DailyWagerRow = { day: string; wager: string };

export async function getAffiliateOverviewFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<AffiliateOverview> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const chartDays = days === null ? MAX_CHART_DAYS : Math.min(days, MAX_CHART_DAYS);

  const realUsers = `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;

  const params: Record<string, unknown> = { blacklist };
  let claimDate = "";
  let usageDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    claimDate = "AND lt.created_at >= {cutoff:DateTime64(6)}";
    usageDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
  }
  params.chartCutoff = chDateTime(new Date(now.getTime() - chartDays * DAY_MS));

  const [claimRows, usageRows, dailyClaimRows, dailyWagerRows] = await Promise.all([
    clickhouseRead.query<ClaimRow>({
      queryName: "insights.affiliate.overview.claim",
      sql: `
        WITH ${realUsers}
        SELECT
          toString(uniqExactIf(lt.user_id, lt.type = 'affiliate_claim'))               AS affiliates,
          toString(sumIf(abs(lt.amount), lt.type = 'affiliate_claim'))                 AS total,
          toString(countIf(lt.type = 'affiliate_claim'))                               AS cnt,
          toString(sumIf(abs(lt.amount), lt.type = 'affiliate_leaderboard_prize'))     AS lb_total,
          toString(countIf(lt.type = 'affiliate_leaderboard_prize'))                   AS lb_cnt
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ('affiliate_claim','affiliate_leaderboard_prize')
          AND lt.user_id IN (SELECT id FROM real_users)
          ${claimDate}`,
      params,
    }),
    clickhouseRead.query<UsageRow>({
      queryName: "insights.affiliate.overview.usage",
      sql: `
        SELECT
          toString(sum(acu.wager_amount_usd))      AS wager,
          toString(uniqExact(acu.referred_user_id)) AS referred
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        WHERE acu._peerdb_is_deleted = 0
          AND acu.status = 'completed'
          ${usageDate}
          ${hasBlacklist ? "AND acu.affiliate_user_id NOT IN {blacklist:Array(String)}" : ""}`,
      params,
    }),
    clickhouseRead.query<DailyClaimRow>({
      queryName: "insights.affiliate.overview.daily-claim",
      sql: `
        WITH ${realUsers}
        SELECT
          toString(toDate(lt.created_at)) AS day,
          toString(sum(abs(lt.amount)))   AS total,
          toString(count())               AS cnt
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type = 'affiliate_claim'
          AND lt.created_at >= {chartCutoff:DateTime64(6)}
          AND lt.user_id IN (SELECT id FROM real_users)
        GROUP BY day
        ORDER BY day ASC`,
      params,
    }),
    clickhouseRead.query<DailyWagerRow>({
      queryName: "insights.affiliate.overview.daily-wager",
      sql: `
        SELECT
          toString(toDate(acu.created_at))    AS day,
          toString(sum(acu.wager_amount_usd)) AS wager
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        WHERE acu._peerdb_is_deleted = 0
          AND acu.status = 'completed'
          AND acu.created_at >= {chartCutoff:DateTime64(6)}
          ${hasBlacklist ? "AND acu.affiliate_user_id NOT IN {blacklist:Array(String)}" : ""}
        GROUP BY day
        ORDER BY day ASC`,
      params,
    }),
  ]);

  const claimRow = claimRows[0];
  const usageRow = usageRows[0];

  const activeAffiliates = Number(claimRow?.affiliates ?? 0);
  const totalCommissionPaid = toNumber(claimRow?.total);
  const claimCount = Number(claimRow?.cnt ?? 0);
  const leaderboardPrizePaid = toNumber(claimRow?.lb_total);
  const leaderboardPrizeCount = Number(claimRow?.lb_cnt ?? 0);
  const totalAffiliateRewardCost = totalCommissionPaid + leaderboardPrizePaid;
  const downstreamWager = toNumber(usageRow?.wager);
  const distinctReferredUsers = Number(usageRow?.referred ?? 0);

  const avgCommissionPerAffiliate =
    activeAffiliates > 0 ? totalCommissionPaid / activeAffiliates : 0;
  const roiUsd = downstreamWager - totalCommissionPaid;
  const commissionPctOfWager =
    downstreamWager > 0 ? (totalCommissionPaid / downstreamWager) * 100 : null;

  // Zero-fill the date axis — identical to the PG twin's TS post-processing.
  const axis: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().split("T")[0]);
  }
  const claimByDay = new Map<string, { commission: number; count: number }>();
  for (const r of dailyClaimRows) {
    claimByDay.set(r.day, { commission: toNumber(r.total), count: Number(r.cnt) });
  }
  const wagerByDay = new Map<string, number>();
  for (const r of dailyWagerRows) {
    wagerByDay.set(r.day, toNumber(r.wager));
  }
  const dailyCommission = axis.map((date) => ({
    date,
    commission: claimByDay.get(date)?.commission ?? 0,
    count: claimByDay.get(date)?.count ?? 0,
  }));
  const dailyWager = axis.map((date) => ({
    date,
    wager: wagerByDay.get(date) ?? 0,
  }));

  return {
    activeAffiliates,
    totalCommissionPaid,
    leaderboardPrizePaid,
    leaderboardPrizeCount,
    totalAffiliateRewardCost,
    downstreamWager,
    distinctReferredUsers,
    claimCount,
    avgCommissionPerAffiliate,
    roiUsd,
    commissionPctOfWager,
    dailyCommission,
    dailyWager,
  };
}
