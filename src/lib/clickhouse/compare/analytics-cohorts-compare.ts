import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  CohortData,
  CohortGranularity,
} from "@/lib/queries/analytics-cohorts";

import { getCohortRetentionFromClickHouse } from "../queries/analytics/cohorts";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics COHORTS tab. No-op unless the
 * `analytics_cohorts` surface is in `comparison` mode. Diffs the grid's
 * aggregate signals (cohort count, total cohort size, total retained-cell sum,
 * total revenue-cell sum) — per-cohort/per-period exactness is proven by the
 * parity harness. The revenue field passes within half a cent; counts exact.
 */
function signals(d: CohortData): Record<string, number> {
  let totalSize = 0;
  let totalRetained = 0;
  let totalRevenue = 0;
  for (const row of d.rows) {
    totalSize += row.size;
    totalRetained += row.retained.reduce((a, b) => a + b, 0);
    totalRevenue += row.revenue.reduce((a, b) => a + b, 0);
  }
  return {
    cohortCount: d.rows.length,
    totalSize,
    totalRetained,
    totalRevenue,
  };
}

export async function compareAnalyticsCohorts(
  granularity: CohortGranularity,
  pg: CohortData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_cohorts");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getCohortRetentionFromClickHouse(granularity, blacklist);
    });

    const drift = computeDrift(signals(pg), signals(ch), ["totalRevenue"]);
    logComparison(`analytics.cohorts[${granularity}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_cohorts",
      "comparison failed (ignored)",
      err,
    );
  }
}
