import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaceRoiResult } from "@/lib/queries/insights-rewards/race/roi";

import { getRaceInsightsROIFromClickHouse } from "../queries/insights-rewards/race/roi";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights ROI tab. No-op unless the
 * `insights_race_roi` surface is in `comparison` mode. Diffs the race-prize cost
 * + forward wager/payout/GGR within half a cent and the claimant count +
 * effective lookback exactly. The forward window is rebuilt with the SAME
 * (already-resolved, idempotent) lookback the PG result used. Swallows every
 * error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "cost",
  "subsequentWager",
  "subsequentPayout",
  "subsequentGgr",
] as const;

function flatten(o: RaceRoiResult): Record<string, number> {
  return {
    cost: o.cost,
    claimantCount: o.claimantCount,
    subsequentWager: o.subsequentWager,
    subsequentPayout: o.subsequentPayout,
    subsequentGgr: o.subsequentGgr,
    lookbackDays: o.lookbackDays,
  };
}

export async function compareRaceRoi(
  period: InsightsRewardsPeriod,
  pgValues: RaceRoiResult,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_roi");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsROIFromClickHouse(
        period,
        pgValues.lookbackDays,
        blacklist,
        now,
      );
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_roi[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_roi",
      "comparison failed (ignored)",
      err,
    );
  }
}
