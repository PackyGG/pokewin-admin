import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { SignupDailyPoint } from "@/lib/queries/insights-rewards/signup/daily";

import { getSignupDailyFromClickHouse } from "../queries/insights-rewards/signup/daily";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup daily series (Overview chart). No-op
 * unless the `insights_signup_daily` surface is in `comparison` mode. Diffs the
 * window aggregate of the per-day rows — total cost within half a cent; day
 * count, total signups, total claims exactly. Swallows every error so the served
 * Postgres payload is never affected.
 */
const MONEY_FIELDS = ["totalCost"] as const;

function flatten(rows: SignupDailyPoint[]): Record<string, number> {
  return {
    dayCount: rows.length,
    totalSignups: rows.reduce((a, r) => a + r.signups, 0),
    totalClaims: rows.reduce((a, r) => a + r.claims, 0),
    totalCost: rows.reduce((a, r) => a + r.cost, 0),
  };
}

export async function compareSignupDaily(
  period: InsightsRewardsPeriod,
  pgValues: SignupDailyPoint[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_daily");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupDailyFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      flatten(pgValues),
      {
        dayCount: ch.dayCount,
        totalSignups: ch.totalSignups,
        totalClaims: ch.totalClaims,
        totalCost: ch.totalCost,
      },
      MONEY_FIELDS,
    );
    logComparison(`insights_signup_daily[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_daily",
      "comparison failed (ignored)",
      err,
    );
  }
}
