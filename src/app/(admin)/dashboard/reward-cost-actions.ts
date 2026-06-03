"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getLeaderboardPrizeClaimantsToday,
  type LeaderboardPrizeClaimantRow,
} from "@/lib/queries/dashboard-reward-cost-leaderboard-claimants";

/**
 * Server action backing the "Show claimants" drilldown on the
 * **Leaderboard prizes** line inside the "Reward costs today" breakdown
 * popover on /dashboard.
 *
 * The breakdown loads its per-line totals up-front (one cheap single-row
 * sweep) but the per-USER claimant list is heavier (GROUP BY user_id over
 * the same window), so it lives behind a click — this action runs ONLY
 * when the admin opens the drilldown, keeping the dashboard's initial
 * render unchanged (CLAUDE.md active-timeframe / lazy rule).
 *
 * Read-only (no mutation, no audit). Auth-gated with the same
 * `requirePageAccess("/dashboard")` DAL guard the sibling dashboard server
 * read (`fetchGgrTopContributors`) uses, so only admins permitted on the
 * dashboard can see who claimed prizes. `limit` is clamped inside the
 * query helper, so the value here is advisory.
 *
 * The returned rows mirror the breakdown's "Leaderboard prizes" line
 * definition exactly (`affiliate_leaderboard_prize`, status='completed',
 * the canonical real-customer scope, since 00:00 UTC today) so their
 * amounts sum to the line total the operator sees.
 */
export async function fetchLeaderboardPrizeClaimantsToday(
  limit = 100,
): Promise<LeaderboardPrizeClaimantRow[]> {
  await requirePageAccess("/dashboard");
  return getLeaderboardPrizeClaimantsToday(limit);
}
