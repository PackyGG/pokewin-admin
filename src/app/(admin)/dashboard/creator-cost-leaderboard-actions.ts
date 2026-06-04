"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getLeaderboardGrossClaimants,
  type LeaderboardGrossBreakdown,
} from "@/lib/queries/dashboard-creator-costs-today";

/**
 * Server action backing the click-to-reveal drilldown on the Creators Costs
 * Today card's "Leaderboard prizes" line.
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
 * returned per-claimant gross amounts reconcile to the card's leaderboard
 * line by construction (the line counts every prize at full gross, so each
 * claimant's gross sums straight back to it).
 */
export async function fetchLeaderboardGrossClaimants(): Promise<LeaderboardGrossBreakdown> {
  await requirePageAccess("/dashboard");
  return getLeaderboardGrossClaimants();
}
