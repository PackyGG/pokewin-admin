import "server-only";

import { adminDb } from "@/lib/admin-db";

/**
 * Admin-side "creator paid his part" flag per creator (affiliate)
 * leaderboard, read from the admin DB's
 * `admin_leaderboard_creator_paid` table.
 *
 * Returns a Map keyed by the backend leaderboard id → boolean (true =
 * the creator has paid their part). Leaderboards with no row are simply
 * absent from the map; callers default them to `false` (not paid yet) —
 * the toggle starts unticked until an admin flips it.
 *
 * This is PURELY an internal tracking flag — "so we know if he paid or
 * not." It does NOT participate in any money math (PnL / GGR /
 * Leaderboard Cost). Used by the creator-detail LeaderboardsCard to seed
 * each board's "Creator paid" toggle.
 */
export async function getLeaderboardCreatorPaidMap(
  leaderboardIds: string[],
): Promise<Map<string, boolean>> {
  if (leaderboardIds.length === 0) return new Map();
  const rows = await adminDb.admin_leaderboard_creator_paid.findMany({
    where: { leaderboard_id: { in: leaderboardIds } },
    select: { leaderboard_id: true, paid: true },
  });
  return new Map(rows.map((r) => [r.leaderboard_id, r.paid]));
}
