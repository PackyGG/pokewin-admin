import "server-only";

import { getCreatorsGlobalStats } from "../../../(admin)/creators/_queries/creators-stats";
import { getAllCreatorsNetGgr } from "../../../(admin)/creators/_queries/all-creators-net-pnl";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  safeQuery,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import {
  getHubCreatorCostBreakdown,
  type HubCreatorCostBreakdown,
} from "./hub-dashboard-creator-cost";
import type { CohortGgrLegs } from "../../../(admin)/creators/_queries/all-creators-net-pnl";
import { getHubCohortWindowed } from "./hub-dashboard-cohort";
import {
  type HubDepositChartRow,
  type HubSignupsFtdsChartRow,
  type HubWagerChartRow,
} from "./hub-types";

export type { HubDepositChartRow, HubSignupsFtdsChartRow, HubWagerChartRow };

/**
 * Creator Hub dashboard — overview data for the active window.
 *
 * REAL, windowed:
 *   • affiliateWagerUsd / netGgrUsd — cohort GGR pass.
 *   • creatorCostUsd — deal payouts + tips + leaderboard (period-scoped).
 *   • signups / ftds / depositsUsd — code-cohort funnel metrics.
 *   • dailyWagers / dailyDeposits / dailySignupsFtds — bucketed chart data.
 *
 * REAL, lifetime/now:
 *   • totalCreators / liveCount — backend roster walk.
 */

const EMPTY_COHORT = {
  signups: null as number | null,
  ftds: null as number | null,
  depositsUsd: null as number | null,
  dailyWagers: [] as HubWagerChartRow[],
  dailyDeposits: [] as HubDepositChartRow[],
  dailySignupsFtds: [] as HubSignupsFtdsChartRow[],
};

export type HubDashboardOverview = {
  period: DashboardPeriod;
  totalCreators: number | null;
  liveCount: number | null;
  affiliateWagerUsd: number | null;
  netGgrUsd: number | null;
  creatorCostUsd: number | null;
  creatorCostBreakdown: HubCreatorCostBreakdown | null;
  ggrLegs: CohortGgrLegs | null;
  creatorsStats: {
    fillCreatorCount: number;
    activeDealCount: number;
  } | null;
  signups: number | null;
  ftds: number | null;
  depositsUsd: number | null;
  dailyWagers: HubWagerChartRow[];
  dailyDeposits: HubDepositChartRow[];
  dailySignupsFtds: HubSignupsFtdsChartRow[];
  rosterUnavailable: boolean;
  /** True when the cohort funnel/chart query failed (KPIs may show "—"). */
  cohortUnavailable: boolean;
};

const HUB_OVERVIEW_QUERY_TIMEOUT_MS = REWARD_QUERY_TIMEOUT_MS * 2;

export async function getHubDashboardOverview(
  period: DashboardPeriod,
): Promise<HubDashboardOverview> {
  const [
    statsResult,
    netGgrResult,
    cohortResult,
    costResult,
  ] = await Promise.all([
    safeQuery(
      () => getCreatorsGlobalStats(),
      null,
      "creator-hub.globalStats",
      HUB_OVERVIEW_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAllCreatorsNetGgr(period),
      null,
      "creator-hub.netGgr",
      HUB_OVERVIEW_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getHubCohortWindowed(period),
      {
        period,
        signups: 0,
        ftds: 0,
        depositsUsd: 0,
        dailyWagers: [],
        dailyDeposits: [],
        dailySignupsFtds: [],
      },
      "creator-hub.cohort",
      HUB_OVERVIEW_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getHubCreatorCostBreakdown(period),
      { total: 0, lines: [] },
      "creator-hub.creatorCost",
      HUB_OVERVIEW_QUERY_TIMEOUT_MS,
    ),
  ]);

  const stats = statsResult.error == null ? statsResult.data : null;
  const ggr = netGgrResult.error == null ? netGgrResult.data : null;

  if (statsResult.error) {
    console.error(
      "[creator-hub] global stats failed (totals render '—'):",
      statsResult.error,
    );
  }
  if (netGgrResult.error) {
    console.error(
      "[creator-hub] windowed net GGR failed (wager/GGR/top render '—'):",
      netGgrResult.error,
    );
  }
  if (cohortResult.error) {
    console.error("[creator-hub] cohort metrics failed:", cohortResult.error);
  }
  if (costResult.error) {
    console.error("[creator-hub] creator cost failed:", costResult.error);
  }

  const cohortOk = cohortResult.error == null;
  const costOk = costResult.error == null;

  const cohort = cohortOk ? cohortResult.data : null;

  return {
    period,
    totalCreators: stats ? stats.totalCreators : null,
    liveCount: stats ? stats.liveCount : null,
    affiliateWagerUsd: ggr ? ggr.legs.wagersTotal : null,
    netGgrUsd: ggr ? ggr.totalGgr : null,
    creatorCostUsd: costOk ? costResult.data.total : null,
    creatorCostBreakdown: costOk ? costResult.data : null,
    ggrLegs: ggr?.legs ?? null,
    creatorsStats: stats
      ? {
          fillCreatorCount: stats.fillCreatorCount,
          activeDealCount: stats.activeDealCount,
        }
      : null,
    signups: cohort ? cohort.signups : EMPTY_COHORT.signups,
    ftds: cohort ? cohort.ftds : EMPTY_COHORT.ftds,
    depositsUsd: cohort ? cohort.depositsUsd : EMPTY_COHORT.depositsUsd,
    dailyWagers: cohort ? cohort.dailyWagers : EMPTY_COHORT.dailyWagers,
    dailyDeposits: cohort ? cohort.dailyDeposits : EMPTY_COHORT.dailyDeposits,
    dailySignupsFtds: cohort
      ? cohort.dailySignupsFtds
      : EMPTY_COHORT.dailySignupsFtds,
    rosterUnavailable: statsResult.error != null,
    cohortUnavailable: cohortResult.error != null,
  };
}
