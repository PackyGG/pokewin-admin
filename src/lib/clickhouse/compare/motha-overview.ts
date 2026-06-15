import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { MothaGiveawayOverview } from "@/lib/queries/insights-rewards/motha/overview";

import { getMothaGiveawayOverviewFromClickHouse } from "../queries/insights-rewards/motha/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the "Motha giveaways" baseline overview
 * (the founder giveaway account's outflow that anchors the
 * `/insights/forecast?reward=motha` tab — `getMothaGiveawayOverview`). No-op
 * unless the `insights_motha_overview` surface is in `comparison` mode (forced
 * off whenever ClickHouse is dormant). Diffs the headline + per-channel money
 * within half a cent and every count exactly. Swallows every error so the
 * served Postgres payload is never affected.
 *
 * SCOPE: motha-scoped, NO staff/creator/blacklist exclusion — so it does NOT
 * fetch the excluded-users blacklist (motha IS the subject, mirroring the PG
 * twin exactly).
 */
const MONEY_FIELDS = [
  "totalCost",
  "avg",
  "max",
  "tips",
  "rain",
  "sponsorship",
] as const;

function flatten(o: MothaGiveawayOverview): Record<string, number> {
  return {
    totalCost: o.totalCost,
    count: o.count,
    uniqueClaimants: o.uniqueClaimants,
    avg: o.avg,
    max: o.max,
    tips: o.byChannel.tips,
    rain: o.byChannel.rain,
    sponsorship: o.byChannel.sponsorship,
    tipsCount: o.countByChannel.tips,
    rainCount: o.countByChannel.rain,
    sponsorshipCount: o.countByChannel.sponsorship,
  };
}

export async function compareMothaOverview(
  period: InsightsRewardsPeriod,
  pgValues: MothaGiveawayOverview,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_motha_overview");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () =>
      getMothaGiveawayOverviewFromClickHouse(period, now),
    );

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_motha_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_motha_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
