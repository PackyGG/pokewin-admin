import "server-only";

import { unstable_cache } from "next/cache";

import { backendApi } from "@/lib/backend-api/client";

/**
 * Cached leaderboards preview for the hub Overview **Affiliate
 * Leaderboards card** (newest 6 boards for one creator).
 *
 * The card used to fire `backendApi.get("/admin/affiliate-leaderboards")`
 * inline on EVERY Overview re-render — including each `?activityPeriod=`
 * switch, which only re-keys the activity chart. 120s TTL absorbs those;
 * `revalidateTag("creator-leaderboards")` in the admin leaderboard
 * actions (create + the shared post-mutation revalidate) flushes it so a
 * new/approved/cancelled board shows immediately (`revalidatePath` does
 * NOT bust `unstable_cache`).
 *
 * Backend API only inside (no request cookie reads) → env-safe to cache.
 * A THROWN fetch is NOT cached (Next only caches resolved values), so a
 * backend outage never pins the failure for the TTL — the card's own
 * catch discriminates it per render.
 */

export type LeaderboardApprovalStatus = "pending" | "approved" | "rejected";
export type LeaderboardTimeStatus = "upcoming" | "active" | "ended";

export type LeaderboardPreviewRow = {
  id: string;
  title: string;
  total_prize_usd: string;
  is_sponsored: boolean;
  start_date: string;
  end_date: string;
  approval_status: LeaderboardApprovalStatus;
  cancelled_at: string | null;
  time_status: LeaderboardTimeStatus;
  affiliate_codes: string[];
  co_creator_user_ids: string[];
  creator_user_id: string;
};

type ListResponse = {
  success: boolean;
  data: { leaderboards: LeaderboardPreviewRow[]; total: number };
};

export type LeaderboardsPreview = {
  rows: LeaderboardPreviewRow[];
  total: number;
};

export const LEADERBOARDS_PREVIEW_LIMIT = 6;

const cachedLeaderboardsPreview = unstable_cache(
  async (userId: string): Promise<LeaderboardsPreview> => {
    const res = await backendApi.get<ListResponse>(
      "/admin/affiliate-leaderboards",
      {
        query: {
          creator_user_id: userId,
          limit: LEADERBOARDS_PREVIEW_LIMIT,
          offset: 0,
        },
      },
    );
    return {
      rows: res.data.leaderboards ?? [],
      total: res.data.total ?? 0,
    };
  },
  ["creator-hub-leaderboards-preview-v1"],
  { revalidate: 120, tags: ["creator-leaderboards"] },
);

export async function getLeaderboardsPreviewCached(
  userId: string,
): Promise<LeaderboardsPreview> {
  return cachedLeaderboardsPreview(userId);
}
