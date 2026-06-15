import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaffleForecastBaseline } from "@/lib/queries/insights-rewards/raffle/overview";

import { getRaffleForecastBaselineFromClickHouse } from "../queries/insights-rewards/raffle/baseline";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the raffle forecast baseline
 * (`/insights/rewards/raffle?tab=forecast` + the unified forecast hub). No-op
 * unless the `insights_raffle_baseline` surface is in `comparison` mode (forced
 * off whenever ClickHouse is dormant).
 *
 * Diffs the reconstructed-prize money (totals / averages / max / daily-cost
 * sum, half-cent tolerance) and the derived ratios (claim probability, entries
 * per raffle, points per entry — same tolerance, they are computed floats), plus
 * the raw counts (raffle count, unique winners, participants, daily-bucket day /
 * count totals) which must match exactly. Swallows every error so the served
 * Postgres payload is never affected.
 *
 * Money note: `totalPrizeCost` / `maxRafflePrizeUsd` (and the averages derived
 * from them) are RECONSTRUCTED from each raffle's `prizes` JSON valued at LIVE
 * pack/card prices — a price change not yet replicated by CDC can transiently
 * move a historical raffle's value, which is replication lag (clears on re-run),
 * not a definition bug.
 */
const MONEY_FIELDS = [
  "totalPrizeCost",
  "avgPrizePerRaffle",
  "avgPrizePerWinner",
  "maxRafflePrizeUsd",
  "claimProbability",
  "avgEntriesPerRaffle",
  "avgPointsPerEntry",
  "dailyCostTotal",
] as const;

function flatten(o: RaffleForecastBaseline): Record<string, number> {
  return {
    totalPrizeCost: o.totalPrizeCost,
    raffleCount: o.raffleCount,
    uniqueWinners: o.uniqueWinners,
    participants: o.participants,
    // null (no participants) → sentinel so a real 0 probability can't alias it;
    // both engines emit null in the same empty case → both map to -1 → equal.
    claimProbability: o.claimProbability ?? -1,
    avgPrizePerRaffle: o.avgPrizePerRaffle,
    avgPrizePerWinner: o.avgPrizePerWinner,
    maxRafflePrizeUsd: o.maxRafflePrizeUsd,
    avgEntriesPerRaffle: o.avgEntriesPerRaffle,
    avgPointsPerEntry: o.avgPointsPerEntry,
    dailyDays: o.dailyPrizes.length,
    dailyCostTotal: o.dailyPrizes.reduce((a, d) => a + d.cost, 0),
    dailyCount: o.dailyPrizes.reduce((a, d) => a + d.count, 0),
  };
}

export async function compareRaffleForecastBaseline(
  period: InsightsRewardsPeriod,
  pgValues: RaffleForecastBaseline,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_raffle_baseline");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaffleForecastBaselineFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_raffle_baseline[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_raffle_baseline",
      "comparison failed (ignored)",
      err,
    );
  }
}
