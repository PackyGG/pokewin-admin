import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  AnalyticsData,
  BattleModeStats,
  PackPopularityStats,
} from "@/lib/queries/analytics";

import {
  getAnalyticsDataFromClickHouse,
  type OverviewPeriod,
} from "../queries/analytics/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics OVERVIEW tab
 * (`getAnalyticsData`). Gates on the `analytics_overview` surface flag (no-op
 * unless `comparison` mode, forced `off` while ClickHouse is dormant). Diffs the
 * full headline + breakdown + battle/pack aggregates + the daily series rolled
 * up to engine-comparable scalars: counts must match exactly, money fields
 * within half a cent.
 *
 * EXCLUDED from the drift record (documented non-cent-exact legs):
 *   • daily `avgDeposit` / `avgBet` — PG `PERCENTILE_CONT(0.5)` and CH
 *     `quantileExactIf(0.5)` interpolate even-sized samples differently, so the
 *     per-day median is intentionally never asserted (see overview.ts note).
 *   • the exact per-row top-N set/order for the battle/pack leaderboards (a
 *     top-N over a tied-boundary population is the lone §5c caveat); row count
 *     + the summed/total fields ARE diffed.
 *
 * Every error is swallowed so the served Postgres payload is never affected.
 */

const SURFACE = "analytics_overview";

export function flattenBattleStats(
  s: BattleModeStats,
  prefix = "battle_",
): Record<string, number> {
  return {
    [`${prefix}totalBattles`]: s.totalBattles,
    [`${prefix}borrowCount`]: s.borrowCount,
    [`${prefix}sponsoredCount`]: s.sponsoredCount,
    [`${prefix}privateCount`]: s.privateCount,
    [`${prefix}byModeRows`]: s.byMode.length,
    [`${prefix}byModeCountSum`]: s.byMode.reduce((a, r) => a + r.count, 0),
    [`${prefix}bySettingRows`]: s.bySetting.length,
    [`${prefix}bySettingCountSum`]: s.bySetting.reduce((a, r) => a + r.count, 0),
    [`${prefix}byFormatRows`]: s.byFormat.length,
    [`${prefix}byFormatCountSum`]: s.byFormat.reduce((a, r) => a + r.count, 0),
    [`${prefix}topBattlePacksRows`]: s.topBattlePacks.length,
    [`${prefix}topBattlePacksCountSum`]: s.topBattlePacks.reduce(
      (a, r) => a + r.count,
      0,
    ),
  };
}

export function flattenPackStats(
  s: PackPopularityStats,
  prefix = "pack_",
): Record<string, number> {
  return {
    [`${prefix}topPacksRows`]: s.topPacks.length,
    [`${prefix}topPacksOpensTotalSum`]: s.topPacks.reduce(
      (a, r) => a + r.opensTotal,
      0,
    ),
    [`${prefix}topPacksOpensBorrowedSum`]: s.topPacks.reduce(
      (a, r) => a + r.opensBorrowed,
      0,
    ),
    [`${prefix}topBorrowedRows`]: s.topBorrowedPacks.length,
    [`${prefix}topBorrowedOpensBorrowedSum`]: s.topBorrowedPacks.reduce(
      (a, r) => a + r.opensBorrowed,
      0,
    ),
  };
}

function flatten(d: AnalyticsData): Record<string, number> {
  const daily = d.daily;
  const sum = (sel: (p: AnalyticsData["daily"][number]) => number): number =>
    daily.reduce((a, p) => a + sel(p), 0);
  return {
    ggr: d.ggr,
    ngr: d.ngr,
    realizedProfit: d.realizedProfit,
    rpDeposits: d.realizedProfitBreakdown.totalDeposits,
    rpWithdrawals: d.realizedProfitBreakdown.totalWithdrawals,
    rpUserBalance: d.realizedProfitBreakdown.userBalance,
    rpInventory: d.realizedProfitBreakdown.inventory,
    rpVouchers: d.realizedProfitBreakdown.vouchers,
    rpUnclaimedRakeback: d.realizedProfitBreakdown.unclaimedRakeback,
    uniqueVisitors: d.uniqueVisitors,
    newSignups: d.newSignups,
    packWager: d.packWager,
    battleWager: d.battleWager,
    upgraderWager: d.upgraderWager,
    packWagerBorrowed: d.packWagerBorrowed,
    battleWagerBorrowed: d.battleWagerBorrowed,
    ...flattenBattleStats(d.battleStats),
    ...flattenPackStats(d.packStats),
    dailyRows: daily.length,
    dailyPackWagerSum: sum((p) => p.packWager),
    dailyBattleWagerSum: sum((p) => p.battleWager),
    dailyUniqueVisitorsSum: sum((p) => p.uniqueVisitors),
    dailyNewSignupsSum: sum((p) => p.newSignups),
    dailyTotalDepositSum: sum((p) => p.totalDeposit),
    dailyTotalBetSum: sum((p) => p.totalBet),
    dailyMinDepositSum: sum((p) => p.minDeposit),
    dailyMaxDepositSum: sum((p) => p.maxDeposit),
    dailyMinBetSum: sum((p) => p.minBet),
    dailyMaxBetSum: sum((p) => p.maxBet),
    dailyRewardRakebackSum: sum((p) => p.rewardRakeback),
    dailyRewardSignupPacksSum: sum((p) => p.rewardSignupPacks),
    dailyRewardLeaderboardSum: sum((p) => p.rewardLeaderboard),
    dailyRewardRainSum: sum((p) => p.rewardRain),
    dailyRewardPromoSum: sum((p) => p.rewardPromo),
    dailyRewardAffiliateSum: sum((p) => p.rewardAffiliate),
    dailyGgrSum: sum((p) => p.ggr),
    dailyNgrSum: sum((p) => p.ngr),
  };
}

const MONEY_FIELDS = [
  "ggr",
  "ngr",
  "realizedProfit",
  "rpDeposits",
  "rpWithdrawals",
  "rpUserBalance",
  "rpInventory",
  "rpVouchers",
  "rpUnclaimedRakeback",
  "packWager",
  "battleWager",
  "upgraderWager",
  "packWagerBorrowed",
  "battleWagerBorrowed",
  "dailyPackWagerSum",
  "dailyBattleWagerSum",
  "dailyTotalDepositSum",
  "dailyTotalBetSum",
  "dailyMinDepositSum",
  "dailyMaxDepositSum",
  "dailyMinBetSum",
  "dailyMaxBetSum",
  "dailyRewardRakebackSum",
  "dailyRewardSignupPacksSum",
  "dailyRewardLeaderboardSum",
  "dailyRewardRainSum",
  "dailyRewardPromoSum",
  "dailyRewardAffiliateSum",
  "dailyGgrSum",
  "dailyNgrSum",
] as const;

export async function compareAnalyticsOverview(
  period: OverviewPeriod,
  pgData: AnalyticsData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode(SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAnalyticsDataFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(flatten(pgData), flatten(ch), MONEY_FIELDS);
    logComparison(`analytics_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      `clickhouse.compare.${SURFACE}`,
      "comparison failed (ignored)",
      err,
    );
  }
}
