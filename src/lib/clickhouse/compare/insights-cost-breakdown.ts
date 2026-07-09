import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { CostBreakdown } from "@/lib/queries/insights-analytics/cost-breakdown";
import type { InsightsPeriod } from "@/lib/queries/insights-analytics/period";

import { getCostBreakdownComparableFromClickHouse } from "../queries/insights-analytics/cost-breakdown";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the cost-breakdown waterfall's headline
 * scalar money figures (Phase 2B). No-op unless the given surface is in
 * `comparison` mode (which is itself forced off whenever ClickHouse is
 * dormant). The ClickHouse twin is fed the SAME canonical cutoff the Postgres
 * path computed (carried in `CostBreakdown.cutoffIso`) and the SAME
 * excluded-users blacklist, so logged drift reflects engine / CDC-lag only,
 * never a window or scope change.
 *
 * TWO surfaces share this hook (the twin mirrors the caller's window via
 * `cutoffIso`, so the same comparison covers both):
 *   • `insights_cost_breakdown` — the /insights/cost-breakdown page's
 *     per-period read (lifetime uncapped: cutoff = epoch ≡ unbounded).
 *   • `insights_cost_breakdown_lifetime` — the shared 365d-CAPPED lifetime
 *     read (`getCostBreakdownLifetimeCached`: topbar pills + /insights hub +
 *     /insights/real-numbers), fired from /insights/real-numbers.
 *
 * Every compared field is money (no count fields exist in the waterfall's
 * scalar headline — the contributor table is a lifetime list, not part of this
 * comparison), so the half-cent tolerance applies to all of them. Swallows
 * every error via `logError` so the served Postgres payload is never affected.
 */
export async function compareCostBreakdown(
  period: InsightsPeriod,
  pgValues: CostBreakdown,
  surfaceKey:
    | "insights_cost_breakdown"
    | "insights_cost_breakdown_lifetime" = "insights_cost_breakdown",
): Promise<void> {
  try {
    const mode = await getAdminReadMode(surfaceKey);
    if (mode !== "comparison") return;

    // The canonical cutoff the Postgres assembly used — reused verbatim so the
    // bridge + windowed-pnl legs scan the byte-identical window (no render-time
    // `now` skew).
    const cutoff = new Date(pgValues.cutoffIso);

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getCostBreakdownComparableFromClickHouse(cutoff, blacklist);
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

    logComparison(`${surfaceKey}[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_cost_breakdown",
      "comparison failed (ignored)",
      err,
    );
  }
}
