import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { TimeToClaim } from "@/lib/queries/insights-rewards/signup/time-to-claim";

import { getSignupTimeToClaimFromClickHouse } from "../queries/insights-rewards/signup/time-to-claim";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup time-to-claim tab. No-op unless the
 * `insights_signup_time_to_claim` surface is in `comparison` mode. Diffs the
 * claimant + cohort counts and the cumulative within-window claimant counts
 * exactly. (The interpolated percentiles + the 10-bucket histogram are out of
 * scope.) The within counts are reconstructed from PG's exposed shares via
 * `round(share × claimants)` — exact for integer ratios. Swallows every error so
 * the served Postgres payload is never affected.
 */
export async function compareSignupTimeToClaim(
  period: InsightsRewardsPeriod,
  pgValues: TimeToClaim,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_time_to_claim");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupTimeToClaimFromClickHouse(period, blacklist, now);
    });

    const c = pgValues.claimants;
    const drift = computeDrift(
      {
        claimants: c,
        cohortSignups: c + pgValues.neverClaimed,
        within1h: Math.round(pgValues.shareWithin1h * c),
        within1d: Math.round(pgValues.shareWithin1d * c),
        within7d: Math.round(pgValues.shareWithin7d * c),
        within30d: Math.round(pgValues.shareWithin30d * c),
      },
      {
        claimants: ch.claimants,
        cohortSignups: ch.cohortSignups,
        within1h: ch.within1h,
        within1d: ch.within1d,
        within7d: ch.within7d,
        within30d: ch.within30d,
      },
    );
    logComparison(`insights_signup_time_to_claim[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_time_to_claim",
      "comparison failed (ignored)",
      err,
    );
  }
}
