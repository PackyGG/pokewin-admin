import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { SignupOverview } from "@/lib/queries/insights-rewards/signup/overview";

import { getSignupOverviewFromClickHouse } from "../queries/insights-rewards/signup/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /insights/rewards/signup Overview headline.
 * No-op unless the `insights_signup_overview` surface is in `comparison` mode
 * (forced off whenever ClickHouse is dormant). Diffs the cohort headline —
 * total signup-bonus cost within half a cent; signups / claimants / first
 * depositors exactly. Swallows every error so the served Postgres payload is
 * never affected.
 */
export async function compareSignupOverview(
  period: InsightsRewardsPeriod,
  pgValues: SignupOverview,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_overview");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupOverviewFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        signups: pgValues.signups,
        claimants: pgValues.claimants,
        totalCost: pgValues.totalCost,
        firstDepositors: pgValues.firstDepositors,
      },
      {
        signups: ch.signups,
        claimants: ch.claimants,
        totalCost: ch.totalCost,
        firstDepositors: ch.firstDepositors,
      },
      ["totalCost"],
    );
    logComparison(`insights_signup_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
