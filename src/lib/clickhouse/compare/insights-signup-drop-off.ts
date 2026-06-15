import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DropOffBreakdown } from "@/lib/queries/insights-rewards/signup/drop-off";

import { getSignupDropOffFromClickHouse } from "../queries/insights-rewards/signup/drop-off";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup drop-off cause breakdown. No-op
 * unless the `insights_signup_drop_off` surface is in `comparison` mode. Every
 * bucket is an exact count; the priority-ordered CASE predicates are replicated
 * verbatim in the twin, so all 7 fields are diffed exactly. Swallows every error
 * so the served Postgres payload is never affected.
 */
export async function compareSignupDropOff(
  period: InsightsRewardsPeriod,
  pgValues: DropOffBreakdown,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_drop_off");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupDropOffFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        cohortSize: pgValues.cohortSize,
        claimers: pgValues.claimers,
        dormant: pgValues.dormant,
        depositedNoClaim: pgValues.depositedNoClaim,
        wageredNoClaim: pgValues.wageredNoClaim,
        bannedOrLocked: pgValues.bannedOrLocked,
        other: pgValues.other,
      },
      {
        cohortSize: ch.cohortSize,
        claimers: ch.claimers,
        dormant: ch.dormant,
        depositedNoClaim: ch.depositedNoClaim,
        wageredNoClaim: ch.wageredNoClaim,
        bannedOrLocked: ch.bannedOrLocked,
        other: ch.other,
      },
    );
    logComparison(`insights_signup_drop_off[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_drop_off",
      "comparison failed (ignored)",
      err,
    );
  }
}
