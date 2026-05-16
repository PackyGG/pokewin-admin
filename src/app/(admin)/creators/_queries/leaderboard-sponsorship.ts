import "server-only";

import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Admin-side "sponsored %" per creator (affiliate) leaderboard, read
 * from the admin DB's `admin_leaderboard_sponsorship` table.
 *
 * Returns a Map keyed by the backend leaderboard id → percentage
 * (0–100). Leaderboards with no row are simply absent from the map;
 * callers default them to 100% (full cost counted) — the
 * Leaderboard Cost tile must not silently drop a leaderboard just
 * because nobody has annotated it yet.
 *
 * Used by both the /creators/leaderboards table (to show + edit each
 * row's %) and getLeaderboardCostTotal (to weight the cost sum).
 */
export async function getLeaderboardSponsorshipMap(
  leaderboardIds: string[],
): Promise<Map<string, number>> {
  if (leaderboardIds.length === 0) return new Map();
  const rows = await adminDb.admin_leaderboard_sponsorship.findMany({
    where: { leaderboard_id: { in: leaderboardIds } },
    select: { leaderboard_id: true, sponsored_percentage: true },
  });
  return new Map(
    rows.map((r) => [r.leaderboard_id, toNumber(r.sponsored_percentage)]),
  );
}
