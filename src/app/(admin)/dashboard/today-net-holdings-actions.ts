"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getTodayNetHoldingsTopHolders,
  type TodayNetHoldingsTopHolders,
} from "@/lib/queries/dashboard-today-net-holdings-movers";
import { compareDashboardNetHoldingsMovers } from "@/lib/clickhouse/compare/dashboard-net-holdings-movers";

/**
 * Server action for the P&L Today card's "Net holdings Δ" drilldown.
 * Loads lazily on first chevron expand — not on dashboard initial render.
 */
export async function fetchTodayNetHoldingsTopHolders(): Promise<TodayNetHoldingsTopHolders> {
  await requirePageAccess("/dashboard");
  const result = await getTodayNetHoldingsTopHolders();
  // CQRS rollout: comparison-mode ClickHouse twin (fire-and-forget, never
  // throws). No-op unless `dashboard_net_holdings_movers` is `comparison`.
  void compareDashboardNetHoldingsMovers({
    holders: result.holders.map((h) => ({
      userId: h.userId,
      netHoldingsChange: h.netHoldingsChange,
    })),
    dayStartIso: result.dayStartIso,
  });
  return result;
}
