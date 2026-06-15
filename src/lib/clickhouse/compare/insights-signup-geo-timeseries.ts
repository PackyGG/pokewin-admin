import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { GeoTimeSeriesCountry } from "@/lib/queries/insights-rewards/signup/geo-timeseries";

import { getSignupGeoTimeSeriesFromClickHouse } from "../queries/insights-rewards/signup/geo-timeseries";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup geo time-series tab (top-5 countries
 * by signup count, daily signups/claimers). No-op unless the
 * `insights_signup_geo_timeseries` surface is in `comparison` mode. Diffs the
 * per-country window totals the daily series sums to — country count + Σ signups
 * + Σ claimers across the returned top-5 — all exact counts. (See the twin's
 * top-N tie note; the parity harness pins the tie-break on both sides.) Swallows
 * every error so the served Postgres payload is never affected.
 */
export async function compareSignupGeoTimeSeries(
  period: InsightsRewardsPeriod,
  pgValues: GeoTimeSeriesCountry[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_geo_timeseries");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupGeoTimeSeriesFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        countryCount: pgValues.length,
        signupSum: pgValues.reduce((a, r) => a + r.signups, 0),
        claimerSum: pgValues.reduce((a, r) => a + r.claimers, 0),
      },
      {
        countryCount: ch.countryCount,
        signupSum: ch.signupSum,
        claimerSum: ch.claimerSum,
      },
    );
    logComparison(`insights_signup_geo_timeseries[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_geo_timeseries",
      "comparison failed (ignored)",
      err,
    );
  }
}
