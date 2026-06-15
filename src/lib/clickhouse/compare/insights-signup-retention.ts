import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { Retention } from "@/lib/queries/insights-rewards/signup/retention";

import { getSignupRetentionFromClickHouse } from "../queries/insights-rewards/signup/retention";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup retention-lift tab (claimer vs
 * non-claimer retention at 24h / 7d / 30d). No-op unless the
 * `insights_signup_retention` surface is in `comparison` mode. Diffs the raw
 * retained / cohort counts exactly (the shares + lift % are derived from these).
 * Swallows every error so the served Postgres payload is never affected.
 */
export async function compareSignupRetention(
  period: InsightsRewardsPeriod,
  pgValues: Retention,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_retention");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupRetentionFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        claimerTotal: pgValues.retention24h.claimerCount,
        nonClaimerTotal: pgValues.retention24h.nonClaimerCount,
        claimer24h: pgValues.retention24h.claimerRetained,
        claimer7d: pgValues.retention7d.claimerRetained,
        claimer30d: pgValues.retention30d.claimerRetained,
        nonClaimer24h: pgValues.retention24h.nonClaimerRetained,
        nonClaimer7d: pgValues.retention7d.nonClaimerRetained,
        nonClaimer30d: pgValues.retention30d.nonClaimerRetained,
      },
      {
        claimerTotal: ch.claimerTotal,
        nonClaimerTotal: ch.nonClaimerTotal,
        claimer24h: ch.claimer24h,
        claimer7d: ch.claimer7d,
        claimer30d: ch.claimer30d,
        nonClaimer24h: ch.nonClaimer24h,
        nonClaimer7d: ch.nonClaimer7d,
        nonClaimer30d: ch.nonClaimer30d,
      },
    );
    logComparison(`insights_signup_retention[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_retention",
      "comparison failed (ignored)",
      err,
    );
  }
}
