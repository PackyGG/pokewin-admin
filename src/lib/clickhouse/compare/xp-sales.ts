import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { XpSalesPeriod } from "@/lib/queries/insights-xp-sales";

import { getXpSalesFromClickHouse } from "../queries/xp-sales/xp-sales";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /xp-sales window aggregate. No-op unless
 * the `xp_sales` surface is in `comparison` mode (which is itself forced off
 * whenever ClickHouse is dormant). Swallows every error — the served Postgres
 * payload is never affected.
 *
 * Diffs the KPI-strip scalars: revenue + avg/sale within half a cent; the
 * counts (sales, buyers, XP granted) must match exactly.
 */
export async function compareXpSales(
  period: XpSalesPeriod,
  pgValues: {
    saleCount: number;
    revenue: number;
    buyers: number;
    avgPerSale: number;
    xpGranted: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("xp_sales");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getXpSalesFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(
      {
        revenue: pgValues.revenue,
        avgPerSale: pgValues.avgPerSale,
        saleCount: pgValues.saleCount,
        buyers: pgValues.buyers,
        xpGranted: pgValues.xpGranted,
      },
      {
        revenue: ch.revenue,
        avgPerSale: ch.avgPerSale,
        saleCount: ch.saleCount,
        buyers: ch.buyers,
        xpGranted: ch.xpGranted,
      },
      ["revenue", "avgPerSale"],
    );
    logComparison(`xp_sales[${period}]`, drift, durationMs);
  } catch (err) {
    logError("clickhouse.compare.xp_sales", "comparison failed (ignored)", err);
  }
}
