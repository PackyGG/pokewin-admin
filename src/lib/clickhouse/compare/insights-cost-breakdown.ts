import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { CostBreakdown } from "@/lib/queries/insights-analytics/cost-breakdown";
import type { InsightsPeriod } from "@/lib/queries/insights-analytics/period";

import { getCostBreakdownComparableFromClickHouse } from "../queries/insights-analytics/cost-breakdown";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /insights/cost-breakdown waterfall's
 * headline scalar money figures (Phase 2B). No-op unless the
 * `insights_cost_breakdown` surface is in `comparison` mode (which is itself
 * forced off whenever ClickHouse is dormant). The ClickHouse twin is fed the
 * SAME canonical cutoff the Postgres path computed (carried in
 * `CostBreakdown.cutoffIso`) and the SAME excluded-users blacklist, so logged
 * drift reflects engine / CDC-lag only, never a window or scope change.
 *
 * Every compared field is money (no count fields exist in the waterfall's
 * scalar headline — the contributor table is a lifetime list, not part of this
 * comparison), so the half-cent tolerance applies to all of them. Swallows
 * every error via `logError` so the served Postgres payload is never affected.
 */
export async function compareCostBreakdown(
  period: InsightsPeriod,
  pgValues: CostBreakdown,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_cost_breakdown");
    if (mode !== "comparison") return;

    // The canonical cutoff the Postgres assembly used — reused verbatim so the
    // bridge + windowed-pnl legs scan the byte-identical window (no render-time
    // `now` skew).
    const cutoff = new Date(pgValues.cutoffIso);

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getCostBreakdownComparableFromClickHouse(period, cutoff, blacklist);
    });

    const moneyFields = [
      "totalWager",
      "gamingPayouts",
      "ggr",
      "ngr",
      "rewardPayouts",
      "cardWithdrawals",
      "inventoryDelta",
      "voucherDelta",
      "pnl",
      "totalCost",
    ] as const;

    const drift = computeDrift(
      {
        totalWager: pgValues.totalWager,
        gamingPayouts: pgValues.gamingPayouts,
        ggr: pgValues.ggr,
        ngr: pgValues.ngr,
        rewardPayouts: pgValues.rewardPayouts,
        cardWithdrawals: pgValues.cardWithdrawals,
        inventoryDelta: pgValues.inventoryDelta,
        voucherDelta: pgValues.voucherDelta,
        pnl: pgValues.pnl,
        totalCost: pgValues.totalCost,
      },
      {
        totalWager: ch.totalWager,
        gamingPayouts: ch.gamingPayouts,
        ggr: ch.ggr,
        ngr: ch.ngr,
        rewardPayouts: ch.rewardPayouts,
        cardWithdrawals: ch.cardWithdrawals,
        inventoryDelta: ch.inventoryDelta,
        voucherDelta: ch.voucherDelta,
        pnl: ch.pnl,
        totalCost: ch.totalCost,
      },
      moneyFields,
    );

    logComparison(`insights_cost_breakdown[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_cost_breakdown",
      "comparison failed (ignored)",
      err,
    );
  }
}
