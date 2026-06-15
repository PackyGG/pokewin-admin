import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RaceBreakdownRow } from "@/lib/queries/insights-rewards/race/breakdown";

import { getRaceInsightsBreakdownFromClickHouse } from "../queries/insights-rewards/race/breakdown";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the race-insights Race-by-race (Breakdown) tab.
 * No-op unless the `insights_race_breakdown` surface is in `comparison` mode.
 * Diffs the order-independent aggregate over the per-race rows — Σ prize pool +
 * Σ top-prize + Σ configured budget within half a cent, row count + Σ
 * winner_count + Σ min/max position exactly. The per-race top-winner identity
 * (tie-perturbable on equal min positions) is deliberately NOT compared.
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "prizePoolSum",
  "topPrizeSum",
  "configuredBudgetSum",
] as const;

function flatten(rows: RaceBreakdownRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    prizePoolSum: rows.reduce((a, r) => a + r.prizePool, 0),
    winnerCountSum: rows.reduce((a, r) => a + r.winnerCount, 0),
    topPositionSum: rows.reduce((a, r) => a + r.topPosition, 0),
    maxPositionSum: rows.reduce(
      (a, r) => a + (r.positionSpread + r.topPosition - 1),
      0,
    ),
    topPrizeSum: rows.reduce((a, r) => a + r.topPrize, 0),
    configuredBudgetSum: rows.reduce((a, r) => a + (r.configuredBudget ?? 0), 0),
  };
}

export async function compareRaceBreakdown(
  period: InsightsRewardsPeriod,
  pgValues: RaceBreakdownRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_race_breakdown");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRaceInsightsBreakdownFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_race_breakdown[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_race_breakdown",
      "comparison failed (ignored)",
      err,
    );
  }
}
