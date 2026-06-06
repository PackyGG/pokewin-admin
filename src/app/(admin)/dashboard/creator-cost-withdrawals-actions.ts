"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getCreatorWithdrawalsBreakdown,
  type CreatorWithdrawalsBreakdown,
} from "@/lib/queries/dashboard-creator-costs-today";

/**
 * Server action backing the click-to-reveal drilldown on the Creators Costs
 * Today card's "Creator withdrawals" line.
 *
 * The card face + breakdown popover render up-front from the cached
 * today-windowed aggregate, but the per-creator / per-request withdrawal
 * breakdown is heavier (a GROUP BY over the deal-payout CTE + user join),
 * so it lives behind a click — this action runs ONLY when an admin expands
 * the line. The dashboard's initial render never calls it, so the tile
 * streams without loading any withdrawal detail (CLAUDE.md active-timeframe
 * / lazy rule).
 *
 * Read-only (no mutation, no audit). Auth-gated with the SAME
 * `requirePageAccess("/dashboard")` DAL guard the sibling dashboard
 * drilldowns use. No client input is taken — the window (today 00:00 UTC
 * → now) is derived from trusted server time inside the query. The returned
 * per-creator amounts reconcile to the card's creator-withdrawals line by
 * construction (same CTE, same DISTINCT (request, voucher) dedupe).
 */
export async function fetchCreatorWithdrawalsBreakdown(): Promise<CreatorWithdrawalsBreakdown> {
  await requirePageAccess("/dashboard");
  return getCreatorWithdrawalsBreakdown();
}
