import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { CreatorLtvData, LtvPeriod } from "@/lib/queries/analytics-ltv";

import { getCreatorLtvFromClickHouse } from "../queries/analytics/ltv";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Phase 2B per-surface compare module — /analytics?tab=ltv "Creator true LTV"
 * ranking.
 *
 * Fire-and-forget comparison for `getCreatorLtv`. No-op unless the
 * `analytics_ltv` surface is in `comparison` mode (forced `off` whenever
 * ClickHouse is dormant). Runs the dedicated ClickHouse twin for the SAME
 * period with the SAME excluded-users blacklist (replicating the EXACT
 * creators / 2-role-referred + blacklist scope the Postgres twin uses), then
 * diffs the ranking aggregates:
 *   • rowCount            — number of creators (COUNT — must match EXACTLY).
 *   • grossPlatformPnl    — Σ gross platform P&L (money, half-cent).
 *   • creatorCost         — Σ creator cost (money, half-cent).
 *   • netRoi              — Σ net ROI (money, half-cent).
 *   • profitableCreators  — creators with netRoi > 0 (COUNT — exact).
 *   • losingCreators      — creators with netRoi < 0 (COUNT — exact).
 *
 * The per-creator `roiMultiple` is a derived ratio (gross / cost) and is not
 * diffed separately. Swallows every error via `logError` so the served
 * Postgres payload is NEVER affected.
 */
const MONEY_FIELDS = ["grossPlatformPnl", "creatorCost", "netRoi"] as const;

type LtvLike = {
  rows: unknown[];
  totals: {
    grossPlatformPnl: number;
    creatorCost: number;
    netRoi: number;
    profitableCreators: number;
    losingCreators: number;
  };
};

export async function compareCreatorLtv(
  period: LtvPeriod,
  pg: CreatorLtvData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_ltv");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getCreatorLtvFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(toRecord(pg), toRecord(ch), MONEY_FIELDS);
    logComparison(`analytics.ltv[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_ltv",
      "comparison failed (ignored)",
      err,
    );
  }
}

/** Flatten an LTV ranking into the scalar record the drift primitive diffs. */
function toRecord(d: LtvLike): Record<string, number> {
  return {
    rowCount: d.rows.length,
    grossPlatformPnl: d.totals.grossPlatformPnl,
    creatorCost: d.totals.creatorCost,
    netRoi: d.totals.netRoi,
    profitableCreators: d.totals.profitableCreators,
    losingCreators: d.totals.losingCreators,
  };
}
