import "server-only";

import { unstable_cache } from "next/cache";

import { backendApi } from "@/lib/backend-api/client";

import type {
  LeaderboardApprovalStatus,
  LeaderboardPreviewRow,
  LeaderboardTimeStatus,
} from "./leaderboards-preview";

/**
 * Cached list of this creator's PREVIOUS (ended) affiliate leaderboards for
 * the Overview card's "Previous leaderboards" modal.
 *
 * The newest-6 preview (`getLeaderboardsPreviewCached`) is too small to be a
 * reliable "history" view, and the backend list endpoint has no `time_status`
 * filter (only approval `status` / `creator_user_id` / `include_cancelled`).
 * So this reuses the SAME backend list endpoint with a larger window and
 * filters `time_status === "ended"` in code — no new direct MAIN Postgres
 * scan, no new transport. Cached (120s TTL) + tag-flushed on leaderboard
 * mutations exactly like the preview, so the modal stays cheap on re-render.
 *
 * Backend API only inside (no request cookie reads) → env-safe to cache.
 * A THROWN fetch is NOT cached (Next only caches resolved values).
 */

export type PreviousLeaderboardRow = {
  id: string;
  title: string;
  total_prize_usd: string;
  is_sponsored: boolean;
  start_date: string;
  end_date: string;
  approval_status: LeaderboardApprovalStatus;
  time_status: LeaderboardTimeStatus;
};

type ListRow = LeaderboardPreviewRow;

type ListResponse = {
  success: boolean;
  data: { leaderboards: ListRow[]; total: number };
};

// Window of recent boards to scan for ended ones. Bounded so the read stays
// cheap; the card surfaces "view all" for the rare creator who exceeds it.
const PREVIOUS_LEADERBOARDS_WINDOW = 50;

const cachedPreviousLeaderboards = unstable_cache(
  async (userId: string): Promise<PreviousLeaderboardRow[]> => {
    const res = await backendApi.get<ListResponse>(
      "/admin/affiliate-leaderboards",
      {
        query: {
          creator_user_id: userId,
          limit: PREVIOUS_LEADERBOARDS_WINDOW,
          offset: 0,
        },
      },
    );
    return (res.data.leaderboards ?? [])
      .filter((r) => r.time_status === "ended")
      .map((r) => ({
        id: r.id,
        title: r.title,
        total_prize_usd: r.total_prize_usd,
        is_sponsored: r.is_sponsored,
        start_date: r.start_date,
        end_date: r.end_date,
        approval_status: r.approval_status,
        time_status: r.time_status,
      }));
  },
  ["creator-hub-previous-leaderboards-v1"],
  { revalidate: 120, tags: ["creator-leaderboards"] },
);

export async function getPreviousLeaderboardsCached(
  userId: string,
): Promise<PreviousLeaderboardRow[]> {
  return cachedPreviousLeaderboards(userId);
}
