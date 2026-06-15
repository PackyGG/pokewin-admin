import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { SignupCountryBreakdown } from "@/lib/queries/insights-rewards/signup/country";

import { getSignupCountryFromClickHouse } from "../queries/insights-rewards/signup/country";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup country tab. No-op unless the
 * `insights_signup_country` surface is in `comparison` mode. The country
 * breakdown (top-15 + an "Other" tail, never dropped) sums back to the cohort
 * totals — diffed against the CH cohort aggregate: claim volume within half a
 * cent; signups + claimants exactly. (Per-country / per-continent rows + the
 * derived retention share are out of scope.) Swallows every error so the served
 * Postgres payload is never affected.
 */
const MONEY_FIELDS = ["totalCost"] as const;

export async function compareSignupCountry(
  period: InsightsRewardsPeriod,
  pgValues: SignupCountryBreakdown,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_country");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupCountryFromClickHouse(period, blacklist, now);
    });

    const countryClaimants = pgValues.countries.reduce(
      (a, r) => a + r.claimants,
      0,
    );
    const countryVolume = pgValues.countries.reduce(
      (a, r) => a + r.claimVolume,
      0,
    );

    const drift = computeDrift(
      {
        signups: pgValues.totalSignups,
        claimants: countryClaimants,
        totalCost: countryVolume,
      },
      {
        signups: ch.signups,
        claimants: ch.claimants,
        totalCost: ch.totalCost,
      },
      MONEY_FIELDS,
    );
    logComparison(`insights_signup_country[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_country",
      "comparison failed (ignored)",
      err,
    );
  }
}
