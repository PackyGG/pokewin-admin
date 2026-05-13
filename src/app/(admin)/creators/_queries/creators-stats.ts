import "server-only";

import { creatorsApi } from "@/lib/backend-api";

export type CreatorsGlobalStats = {
  /** Total creator accounts on the platform. */
  totalCreators: number;
  /**
   * Count of creators whose `current_deal` is either ACTIVE (running
   * right now) or SCHEDULED (signed off and queued to start). Matches
   * the highlighted "Active" badge admins already see on each card —
   * the badge fires for both statuses, so the KPI count needs to too
   * or the numbers will read inconsistent.
   */
  activeDealCount: number;
  /**
   * Count of creators currently live — backend signal is
   * `active_session_id !== null`. Updates as creators go live on
   * kick / start their stream session for the deal.
   */
  liveCount: number;
};

/**
 * Global counts for the /creators KPI strip. Independent from the
 * paginated list query so the stats don't change when the user types
 * in the search box.
 *
 * Fetches all creators in one backend call with a defensive limit
 * cap; the platform's creator pool is bounded (well under 1k today),
 * so a single round-trip is fine. Bump the cap if we ever cross it.
 */
const STATS_LIMIT_CAP = 1000;

export async function getCreatorsGlobalStats(): Promise<CreatorsGlobalStats> {
  const { data, total } = await creatorsApi.list({
    // No search filter — these are global counts. If the user types
    // in the search box, the KPI tiles should stay stable.
    offset: 0,
    limit: STATS_LIMIT_CAP,
  });

  let activeDealCount = 0;
  let liveCount = 0;
  for (const c of data) {
    if (
      c.current_deal?.status === "active" ||
      c.current_deal?.status === "scheduled"
    ) {
      activeDealCount += 1;
    }
    if (c.active_session_id !== null) {
      liveCount += 1;
    }
  }

  return {
    // `total` from the backend is the absolute count (not affected
    // by the limit). Use it directly so the tile stays accurate
    // even if the creator pool grows past STATS_LIMIT_CAP.
    totalCreators: total,
    activeDealCount,
    liveCount,
  };
}
