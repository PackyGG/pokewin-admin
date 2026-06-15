import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { CohortMatrixRow } from "@/lib/queries/insights-rewards/signup/cohort-matrix";

import { getSignupCohortMatrixFromClickHouse } from "../queries/insights-rewards/signup/cohort-matrix";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the weekly signup cohort-retention matrix.
 * No-op unless the `insights_signup_cohort_matrix` surface is in `comparison`
 * mode. Diffs the window aggregate the weekly rows sum to — signups / claimers /
 * 30d-retention splits — all exact counts. (The per-week bucketing + derived
 * shares are out of scope.) Swallows every error so the served Postgres payload
 * is never affected.
 */
export async function compareSignupCohortMatrix(
  period: InsightsRewardsPeriod,
  pgValues: CohortMatrixRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_cohort_matrix");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupCohortMatrixFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        signups: pgValues.reduce((a, r) => a + r.signups, 0),
        claimers: pgValues.reduce((a, r) => a + r.claimers, 0),
        retained30d: pgValues.reduce((a, r) => a + r.retained30d, 0),
        claimerRetained30d: pgValues.reduce(
          (a, r) => a + r.claimerRetained30d,
          0,
        ),
        nonClaimerRetained30d: pgValues.reduce(
          (a, r) => a + r.nonClaimerRetained30d,
          0,
        ),
      },
      {
        signups: ch.signups,
        claimers: ch.claimers,
        retained30d: ch.retained30d,
        claimerRetained30d: ch.claimerRetained30d,
        nonClaimerRetained30d: ch.nonClaimerRetained30d,
      },
    );
    logComparison(`insights_signup_cohort_matrix[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_cohort_matrix",
      "comparison failed (ignored)",
      err,
    );
  }
}
