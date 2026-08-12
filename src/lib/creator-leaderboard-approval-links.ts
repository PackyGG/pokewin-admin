import "server-only";

import { inArray } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { creator_deal_approval_requests } from "@/lib/db-schema/admin/schema";

/** Approval request that jointly provisioned each leaderboard and fill schedule. */
export async function getApprovalRequestIdsByLeaderboardIds(
  leaderboardIds: string[],
): Promise<Map<string, string>> {
  if (leaderboardIds.length === 0) return new Map();
  const rows = await adminDrizzle
    .select({
      requestId: creator_deal_approval_requests.id,
      leaderboardId: creator_deal_approval_requests.leaderboard_id,
    })
    .from(creator_deal_approval_requests)
    .where(inArray(creator_deal_approval_requests.leaderboard_id, leaderboardIds));
  return new Map(
    rows.flatMap((row) =>
      row.leaderboardId == null
        ? []
        : [[row.leaderboardId, row.requestId] as const],
    ),
  );
}
