import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { HourOfDay } from "@/lib/queries/insights-rewards/signup/hour-of-day";

import { getSignupHourOfDayFromClickHouse } from "../queries/insights-rewards/signup/hour-of-day";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup hour-of-day / day-of-week heatmap.
 * No-op unless the `insights_signup_hour_of_day` surface is in `comparison`
 * mode. Diffs the grand totals the heatmap cells sum to — total claim volume
 * within half a cent; total claim count exactly. (The per-cell DOW/HOUR split is
 * out of scope.) Swallows every error so the served Postgres payload is never
 * affected.
 */
const MONEY_FIELDS = ["totalVolume"] as const;

export async function compareSignupHourOfDay(
  period: InsightsRewardsPeriod,
  pgValues: HourOfDay,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_hour_of_day");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupHourOfDayFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        totalCount: pgValues.hourly.reduce((a, r) => a + r.count, 0),
        totalVolume: pgValues.hourly.reduce((a, r) => a + r.volume, 0),
      },
      {
        totalCount: ch.totalCount,
        totalVolume: ch.totalVolume,
      },
      MONEY_FIELDS,
    );
    logComparison(`insights_signup_hour_of_day[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_hour_of_day",
      "comparison failed (ignored)",
      err,
    );
  }
}
