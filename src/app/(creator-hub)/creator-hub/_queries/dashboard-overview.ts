import "server-only";

import { getCreatorsGlobalStats } from "../../../(admin)/creators/_queries/creators-stats";
import {
  getAllCreatorsNetGgr,
  type CreatorNetGgrRow,
} from "../../../(admin)/creators/_queries/all-creators-net-pnl";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  safeQuery,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { getHubCreatorCostUsd } from "./hub-dashboard-creator-cost";
import { getHubCohortWindowed } from "./hub-dashboard-cohort";
import { type HubChartPoint } from "./hub-types";

export type { HubChartPoint };

/**
 * Creator Hub dashboard — overview data for the active window.
 *
 * REAL, windowed:
 *   • affiliateWagerUsd / netGgrUsd / topCreators — cohort GGR pass.
 *   • creatorCostUsd — deal payouts + tips + leaderboard (period-scoped).
 *   • signups / ftds / depositsUsd — code-cohort funnel metrics.
 *   • wagerSeries / depositSeries — bucketed chart data (hourly for 24h).
 *
 * REAL, lifetime/now:
 *   • totalCreators / liveCount — backend roster walk.
 */

/** A single ranked Top-Creator row for the dashboard list. */
export type HubTopCreator = {
  creatorUserId: string;
  username: string | null;
  image: string | null;
  wagerUsd: number;
  ggrUsd: number;
};

const EMPTY_COHORT = {
  signups: null as number | null,
  ftds: null as number | null,
  depositsUsd: null as number | null,
  wagerSeries: [] as HubChartPoint[],
  depositSeries: [] as HubChartPoint[],
};

export type HubDashboardOverview = {
  period: DashboardPeriod;
  totalCreators: number | null;
  liveCount: number | null;
  affiliateWagerUsd: number | null;
  netGgrUsd: number | null;
  creatorCostUsd: number | null;
  signups: number | null;
  ftds: number | null;
  depositsUsd: number | null;
  wagerSeries: HubChartPoint[];
  depositSeries: HubChartPoint[];
  topCreators: HubTopCreator[];
  rosterUnavailable: boolean;
};

const TOP_CREATORS_LIMIT = 6;

export async function getHubDashboardOverview(
  period: DashboardPeriod,
): Promise<HubDashboardOverview> {
  const [
    statsResult,
    netGgr,
    cohortResult,
    costResult,
  ] = await Promise.all([
    getCreatorsGlobalStats().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    ),
    getAllCreatorsNetGgr(period).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    ),
    safeQuery(
      () => getHubCohortWindowed(period),
      {
        period,
        signups: 0,
        ftds: 0,
        depositsUsd: 0,
        wagerSeries: [],
        depositSeries: [],
      },
      "creator-hub.cohort",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getHubCreatorCostUsd(period),
      0,
      "creator-hub.creatorCost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const stats =
    statsResult.status === "fulfilled" ? statsResult.value : null;
  const ggr = netGgr.status === "fulfilled" ? netGgr.value : null;

  if (statsResult.status === "rejected") {
    console.error(
      "[creator-hub] global stats failed (totals render '—'):",
      statsResult.reason,
    );
  }
  if (netGgr.status === "rejected") {
    console.error(
      "[creator-hub] windowed net GGR failed (wager/GGR/top render '—'):",
      netGgr.reason,
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

  const topCreators: HubTopCreator[] = (ggr?.byCreator ?? [])
    .slice(0, TOP_CREATORS_LIMIT)
    .map((r: CreatorNetGgrRow) => ({
      creatorUserId: r.creatorUserId,
      username: r.username,
      image: r.image,
      wagerUsd: r.wager,
      ggrUsd: r.ggr,
    }));

  const cohort = cohortOk ? cohortResult.data : null;

  return {
    period,
    totalCreators: stats ? stats.totalCreators : null,
    liveCount: stats ? stats.liveCount : null,
    affiliateWagerUsd: ggr ? ggr.legs.wagersTotal : null,
    netGgrUsd: ggr ? ggr.totalGgr : null,
    creatorCostUsd: costOk ? costResult.data : null,
    signups: cohort ? cohort.signups : EMPTY_COHORT.signups,
    ftds: cohort ? cohort.ftds : EMPTY_COHORT.ftds,
    depositsUsd: cohort ? cohort.depositsUsd : EMPTY_COHORT.depositsUsd,
    wagerSeries: cohort ? cohort.wagerSeries : EMPTY_COHORT.wagerSeries,
    depositSeries: cohort ? cohort.depositSeries : EMPTY_COHORT.depositSeries,
    topCreators,
    rosterUnavailable: statsResult.status === "rejected",
  };
}
