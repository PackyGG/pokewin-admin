"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getLeaderboardOnSiteClaimants,
  type LeaderboardOnSiteBreakdown,
} from "@/lib/queries/dashboard-reward-costs-today";

/**
 * Server action backing the click-to-reveal drilldown on the Reward Costs
 * Today card's "Leaderboard prizes (on-site)" line.
 *
 * The card face + breakdown popover render up-front from the cached
 * today-windowed aggregate, but the per-claimant leaderboard breakdown is
 * heavier (a GROUP BY (leaderboard, user) sweep + a bulk title resolve), so
 * it lives behind a click — this action runs ONLY when an admin expands the
 * line. The dashboard's initial render never calls it, so the tile streams
 * without loading any claimant data (CLAUDE.md active-timeframe / lazy rule).
 *
 * Read-only (no mutation, no audit). Auth-gated with the SAME
 * `requirePageAccess("/dashboard")` DAL guard the sibling dashboard
 * drilldowns (`fetchGgrTopContributors`, `fetchDailyPnlBreakdown`) use, so
 * only admins permitted on the dashboard can drill the line. No client input
 * is taken — the window (today 00:00 UTC → now) is derived from trusted
 * server time inside the query, so nothing tampered can widen the scan. The
 * returned per-claimant on-site amounts reconcile to the card's line by
 * construction (the same per-board sponsored-% carve-out is applied per row).
 */
export async function fetchLeaderboardOnSiteClaimants(): Promise<LeaderboardOnSiteBreakdown> {
  await requirePageAccess("/dashboard");
  return getLeaderboardOnSiteClaimants();
}
