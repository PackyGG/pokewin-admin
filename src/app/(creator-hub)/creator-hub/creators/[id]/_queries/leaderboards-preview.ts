import "server-only";

import { unstable_cache } from "next/cache";

import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";

/**
 * Cached leaderboards read for the hub Overview **Affiliate Leaderboards
 * card**: this creator's LIVE boards (upcoming + active) for the card body,
 * plus the ENDED ones for the "Previous leaderboards" modal.
 *
 * The card used to fire the backend endpoint directly
 * inline on EVERY Overview re-render — including each `?activityPeriod=`
 * switch, which only re-keys the activity chart. 120s TTL absorbs those;
 * `revalidateTag("creator-leaderboards")` in the admin leaderboard
 * actions (create + the shared post-mutation revalidate) flushes it so a
 * new/approved/cancelled board shows immediately (`revalidatePath` does
 * NOT bust `unstable_cache`).
 *
 * WHY ONE WINDOWED READ: the card body shows only live boards and ended ones
 * are modal-only, but the backend list endpoint has no `time_status` filter
 * (only approval `status` / `creator_user_id` / `include_cancelled`). A
 * "newest 6" page would therefore hide an active board behind six ended ones.
 * So we scan a bounded window ONCE and split it in code — one backend call
 * feeding both surfaces, replacing the two overlapping list reads the card
 * used to fire (this one + `previous-leaderboards.ts`).
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
  refund_amount_usd: string | null;
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

export type LeaderboardsPreview = {
  /** Live boards (upcoming + active) shown in the card, capped. */
  rows: LeaderboardPreviewRow[];
  /** Live boards found in the window — drives the "view all" affordance. */
  liveTotal: number;
  /** Ended boards from the same window — the "Previous leaderboards" modal. */
  previous: LeaderboardPreviewRow[];
};

export const LEADERBOARDS_PREVIEW_LIMIT = 6;

/**
 * Boards scanned per read. Bounded so the call stays cheap; a creator with
 * more boards than this still reaches the rest through "Manage leaderboards".
 */
const LEADERBOARDS_WINDOW = 50;

const cachedLeaderboardsPreview = unstable_cache(
  async (userId: string): Promise<LeaderboardsPreview> => {
    const res = await affiliateLeaderboardsApi.list({
      creator_user_id: userId,
      limit: LEADERBOARDS_WINDOW,
      offset: 0,
    });
    const all = res.leaderboards ?? [];
    const live = all.filter((r) => r.time_status !== "ended");
    return {
      rows: live.slice(0, LEADERBOARDS_PREVIEW_LIMIT),
      liveTotal: live.length,
      previous: all.filter((r) => r.time_status === "ended"),
    };
  },
  ["creator-hub-leaderboards-preview-v2"],
  { revalidate: 120, tags: ["creator-leaderboards"] },
);

export async function getLeaderboardsPreviewCached(
  userId: string,
): Promise<LeaderboardsPreview> {
  return cachedLeaderboardsPreview(userId);
}
