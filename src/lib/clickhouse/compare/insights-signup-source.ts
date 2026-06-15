import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { SignupSourceBreakdown } from "@/lib/queries/insights-rewards/signup/source";

import { getSignupSourceFromClickHouse } from "../queries/insights-rewards/signup/source";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup source-attribution tab. No-op unless
 * the `insights_signup_source` surface is in `comparison` mode. The provider
 * breakdown is unbounded (every cohort user → one provider), so its sums equal
 * the cohort totals — diffed against the CH cohort aggregate: signup-bonus cost
 * within half a cent; signups + claimants exactly. (Per-provider / per-affiliate
 * buckets — the affiliate cut being a truncated top-N — are out of scope.)
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["totalCost"] as const;

export async function compareSignupSource(
  period: InsightsRewardsPeriod,
  pgValues: SignupSourceBreakdown,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_source");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupSourceFromClickHouse(period, blacklist, now);
    });

    const providerClaimants = pgValues.providers.reduce(
      (a, r) => a + r.claimants,
      0,
    );
    const providerCost = pgValues.providers.reduce(
      (a, r) => a + r.totalCost,
      0,
    );

    const drift = computeDrift(
      {
        signups: pgValues.totalSignups,
        claimants: providerClaimants,
        totalCost: providerCost,
      },
      {
        signups: ch.signups,
        claimants: ch.claimants,
        totalCost: ch.totalCost,
      },
      MONEY_FIELDS,
    );
    logComparison(`insights_signup_source[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_source",
      "comparison failed (ignored)",
      err,
    );
  }
}
