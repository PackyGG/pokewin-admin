import "server-only";

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
import { getHubCohortKpis } from "./hub-dashboard-cohort";

/**
 * Creator Hub dashboard — overview data for the active window.
 *
 * REAL, windowed:
 *   • affiliateWagerUsd / netGgrUsd — cohort GGR pass.
 *   • creatorCostUsd — deal payouts + tips + leaderboard (period-scoped).
 *   • signups / ftds / depositsUsd — code-cohort funnel scalars
 *     (`getHubCohortKpis` — the fixed-30d chart scans live in the Trends
 *     band's own `getHubCohortCharts` cache and are NOT paid here).
 *
 * Roster counts (total / live) belong to the page's StatusByline, which
 * fetches `getCreatorsGlobalStats` itself — not duplicated here.
 */

export type HubDashboardOverview = {
  period: DashboardPeriod;
  affiliateWagerUsd: number | null;
  netGgrUsd: number | null;
  creatorCostUsd: number | null;
  creatorCostBreakdown: HubCreatorCostBreakdown | null;
  ggrLegs: CohortGgrLegs | null;
  signups: number | null;
  ftds: number | null;
  depositsUsd: number | null;
  /** True when the cohort funnel query failed (KPIs may show "—"). */
  cohortUnavailable: boolean;
};

const HUB_OVERVIEW_QUERY_TIMEOUT_MS = REWARD_QUERY_TIMEOUT_MS * 2;

export async function getHubDashboardOverview(
  period: DashboardPeriod,
): Promise<HubDashboardOverview> {
  const [netGgrResult, cohortResult, costResult] = await Promise.all([
    safeQuery(
      () => getAllCreatorsNetGgr(period),
      null,
      "creator-hub.netGgr",
      HUB_OVERVIEW_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getHubCohortKpis(period),
      {
        period,
        signups: 0,
        ftds: 0,
        depositsUsd: 0,
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

  const ggr = netGgrResult.error == null ? netGgrResult.data : null;

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
    affiliateWagerUsd: ggr ? ggr.legs.wagersTotal : null,
    netGgrUsd: ggr ? ggr.totalGgr : null,
    creatorCostUsd: costOk ? costResult.data.total : null,
    creatorCostBreakdown: costOk ? costResult.data : null,
    ggrLegs: ggr?.legs ?? null,
    signups: cohort ? cohort.signups : null,
    ftds: cohort ? cohort.ftds : null,
    depositsUsd: cohort ? cohort.depositsUsd : null,
    cohortUnavailable: cohortResult.error != null,
  };
}
