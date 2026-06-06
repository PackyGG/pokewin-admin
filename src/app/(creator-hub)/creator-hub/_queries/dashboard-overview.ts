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
import { getCodeAndWagerByUser } from "../../../(admin)/creators/_queries/code-and-wager-by-user";
import {
  getHubCreatorCostBreakdown,
  type HubCreatorCostBreakdown,
} from "./hub-dashboard-creator-cost";
import type { CohortGgrLegs } from "../../../(admin)/creators/_queries/all-creators-net-pnl";
import { getHubCohortWindowed } from "./hub-dashboard-cohort";
import { getWindowedSignupsByCreatorIds } from "./hub-top-creator-meta";
import {
  type HubDepositChartRow,
  type HubWagerChartRow,
} from "./hub-types";

export type { HubDepositChartRow, HubWagerChartRow };

/**
 * Creator Hub dashboard — overview data for the active window.
 *
 * REAL, windowed:
 *   • affiliateWagerUsd / netGgrUsd / topCreators — cohort GGR pass.
 *   • creatorCostUsd — deal payouts + tips + leaderboard (period-scoped).
 *   • signups / ftds / depositsUsd — code-cohort funnel metrics.
 *   • dailyWagers / dailyDeposits — bucketed bar-chart data (main dashboard shape).
 *
 * REAL, lifetime/now:
 *   • totalCreators / liveCount — backend roster walk.
 */

/** A single ranked Top-Creator row for the dashboard list. */
export type HubTopCreator = {
  creatorUserId: string;
  username: string | null;
  image: string | null;
  /** Primary affiliate code (oldest-first). */
  code: string | null;
  /** Referred sign-ups in the active window. */
  signups: number;
  wagerUsd: number;
  ggrUsd: number;
};

const EMPTY_COHORT = {
  signups: null as number | null,
  ftds: null as number | null,
  depositsUsd: null as number | null,
  dailyWagers: [] as HubWagerChartRow[],
  dailyDeposits: [] as HubDepositChartRow[],
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
  topCreators: HubTopCreator[];
  rosterUnavailable: boolean;
  /** True when the cohort funnel/chart query failed (KPIs may show "—"). */
  cohortUnavailable: boolean;
};

const TOP_CREATORS_LIMIT = 6;
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
    getCreatorsGlobalStats().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
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

  const stats =
    statsResult.status === "fulfilled" ? statsResult.value : null;
  const ggr = netGgrResult.error == null ? netGgrResult.data : null;

  if (statsResult.status === "rejected") {
    console.error(
      "[creator-hub] global stats failed (totals render '—'):",
      statsResult.reason,
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

  const ranked: CreatorNetGgrRow[] = [...(ggr?.byCreator ?? [])]
    .filter((r) => r.wager > 0)
    .sort((a, b) => b.wager - a.wager || b.ggr - a.ggr)
    .slice(0, TOP_CREATORS_LIMIT);

  const topIds = ranked.map((r) => r.creatorUserId);
  const [codeMeta, signupsMeta] = await Promise.all([
    getCodeAndWagerByUser(topIds).catch((err) => {
      console.error("[creator-hub] top-creator code meta failed:", err);
      return new Map();
    }),
    getWindowedSignupsByCreatorIds(topIds, period).catch((err) => {
      console.error("[creator-hub] top-creator signups meta failed:", err);
      return new Map();
    }),
  ]);

  const topCreators: HubTopCreator[] = ranked.map((r) => ({
    creatorUserId: r.creatorUserId,
    username: r.username,
    image: r.image,
    code: codeMeta.get(r.creatorUserId)?.code ?? null,
    signups: signupsMeta.get(r.creatorUserId) ?? 0,
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
    topCreators,
    rosterUnavailable: statsResult.status === "rejected",
    cohortUnavailable: cohortResult.error != null,
  };
}
