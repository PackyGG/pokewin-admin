"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getInventoryTopHolders,
  type InventoryHolderRow,
} from "@/lib/queries/dashboard-today-pnl";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";

/**
 * Server action backing the lazy "show more" expander on the Inventory Δ
 * line of the "P&L Today" popover (today-pnl-stat-card.tsx).
 *
 * The popover face loads with the tile (cheap scalar deltas), but the
 * per-user "where the held inventory value comes from" breakdown is a
 * heavier GROUP BY over `user_inventory`, so it lives behind a click —
 * this action runs only when the admin opens the expander, mirroring the
 * GGR card's `fetchGgrTopContributors` lazy pattern.
 *
 * Resilience: the query is wrapped in `safeQuery` with the heavy
 * drill-down timeout so a slow / failing sweep degrades to a generic
 * error instead of crashing the tile. Per the safeQuery security note we
 * do NOT forward the raw DB `err.message` to the client — on failure we
 * throw a fixed, safe message that the client's try/catch surfaces.
 *
 * `limit` is advisory — it's clamped to [1, 50] inside the query helper.
 */
export async function fetchInventoryTopHolders(
  limit = 10,
): Promise<InventoryHolderRow[]> {
  await requirePageAccess("/dashboard");
  const { data, error } = await safeQuery(
    () => getInventoryTopHolders(limit),
    [] as InventoryHolderRow[],
    "dashboard.today-pnl.inventoryHolders",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error) {
    // Generic, non-leaky message — the real cause is already logged
    // server-side by safeQuery.
    throw new Error("Failed to load inventory breakdown");
  }
  return data;
}
