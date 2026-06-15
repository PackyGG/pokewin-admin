import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackOverview } from "@/lib/queries/insights-rewards/rakeback/overview";

import { getRakebackOverviewFromClickHouse } from "../queries/insights-rewards/rakeback/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback Overview KPI strip
 * (`/insights/rewards/rakeback`). No-op unless the `insights_rakeback_overview`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Diffs the headline money within half a cent + the counts exactly, plus the
 * prior-window leg when the period defines one. Swallows every error so the
 * served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "totalRakeback",
  "totalWager",
  "largestClaim",
  "avgPerClaim",
  "priorRakeback",
] as const;

function flatten(o: RakebackOverview): Record<string, number> {
  const rec: Record<string, number> = {
    totalRakeback: o.totalRakeback,
    count: o.count,
    distinctClaimants: o.distinctClaimants,
    totalWager: o.totalWager,
    largestClaim: o.largestClaim,
    avgPerClaim: o.avgPerClaim,
  };
  if (o.priorWindow) {
    rec.priorRakeback = o.priorWindow.totalRakeback;
    rec.priorCount = o.priorWindow.count;
    rec.priorClaimants = o.priorWindow.distinctClaimants;
  }
  return rec;
}

export async function compareRakebackOverview(
  period: InsightsRewardsPeriod,
  pgValues: RakebackOverview,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_overview");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackOverviewFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_rakeback_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
