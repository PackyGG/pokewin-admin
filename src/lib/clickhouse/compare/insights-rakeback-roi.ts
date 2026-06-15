import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackRoi,
  RakebackRoiLookback,
} from "@/lib/queries/insights-rewards/rakeback/roi";

import { getRakebackRoiFromClickHouse } from "../queries/insights-rewards/rakeback/roi";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback ROI tab. No-op unless the
 * `insights_rakeback_roi` surface is in `comparison` mode. Diffs cost +
 * subsequent GGR + net return within half a cent and the claimant count
 * exactly; `roiRatio` is derived from cost/GGR so it is not compared directly.
 * The SAME lookback the PG path used is forwarded so drift reflects engine /
 * CDC-lag only. Swallows every error so the served Postgres payload is never
 * affected.
 */
const MONEY_FIELDS = ["cost", "subsequentGgr", "netReturn"] as const;

function flatten(r: RakebackRoi): Record<string, number> {
  return {
    cost: r.cost,
    subsequentGgr: r.subsequentGgr,
    netReturn: r.netReturn,
    claimants: r.claimants,
  };
}

export async function compareRakebackRoi(
  period: InsightsRewardsPeriod,
  lookback: RakebackRoiLookback,
  pgValues: RakebackRoi,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_roi");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackRoiFromClickHouse(period, lookback, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(
      `insights_rakeback_roi[${period}:${lookback}d]`,
      drift,
      durationMs,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_roi",
      "comparison failed (ignored)",
      err,
    );
  }
}
