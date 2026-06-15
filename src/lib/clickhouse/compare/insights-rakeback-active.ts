import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackActiveSubscribers } from "@/lib/queries/insights-rewards/rakeback/active-subscribers";

import { getRakebackActiveSubscribersFromClickHouse } from "../queries/insights-rewards/rakeback/active-subscribers";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback Active-subscribers tab. No-op
 * unless the `insights_rakeback_active` surface is in `comparison` mode. All
 * compared fields are counts (distinct claimants, weekly-active series totals,
 * cohort sizes + retention activity) so they must match exactly. Swallows every
 * error so the served Postgres payload is never affected.
 */
function flatten(d: RakebackActiveSubscribers): Record<string, number> {
  return {
    distinctClaimants: d.distinctClaimants,
    weeklyWeeks: d.weeklyActive.length,
    weeklyActiveSum: d.weeklyActive.reduce((a, w) => a + w.activeUsers, 0),
    cohortCount: d.cohorts.length,
    cohortSizeSum: d.cohorts.reduce((a, c) => a + c.cohortSize, 0),
    retentionActiveSum: d.cohorts.reduce(
      (a, c) => a + c.retention.reduce((b, r) => b + r.activeCount, 0),
      0,
    ),
  };
}

export async function compareRakebackActive(
  period: InsightsRewardsPeriod,
  pgValues: RakebackActiveSubscribers,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_active");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackActiveSubscribersFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch));
    logComparison(`insights_rakeback_active[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_active",
      "comparison failed (ignored)",
      err,
    );
  }
}
