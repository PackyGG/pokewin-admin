import "server-only";

import { unstable_cache } from "next/cache";

// Reuse the EXISTING backend deal read from the (admin) creators group —
// same cross-group reuse the rest of this folder does.
import {
  getCreatorDealData,
  type CreatorDealData,
} from "../../../../../(admin)/creators/[userId]/_queries/get-creator-deal-data";

/**
 * Cached backend deal read for the hub Overview **Deal card** only.
 *
 * The card needs a FIXED slice (first 25 deals; sessions/pending are not
 * rendered by the card), yet the uncached `getCreatorDealData` fired its 3
 * backend GETs on EVERY Overview re-render — including each
 * `?activityPeriod=` switch, which only re-keys the activity chart.
 * 60s TTL absorbs those re-renders; `revalidateTag("creator-deal")` in
 * `createCreatorDeal` (admin backend-actions) flushes it so a
 * freshly-created deal appears immediately (`revalidatePath` alone does
 * NOT bust `unstable_cache`).
 *
 * The admin `/creators/[userId]` page keeps the UNCACHED path — its
 * slices are URL-param-driven (deal/session/pending paging) and must stay
 * live. Backend API only inside (no request cookie reads) → env-safe to
 * cache. The userId argument is folded into the cache key.
 */
const DEAL_CARD_PARAMS = {
  dealsPage: 1,
  dealsPerPage: 25,
  sessionsPage: 1,
  sessionsPerPage: 1,
  pendingStatus: "pending",
} as const;

const cachedDealCardData = unstable_cache(
  (userId: string): Promise<CreatorDealData | null> =>
    getCreatorDealData(userId, DEAL_CARD_PARAMS),
  ["creator-hub-deal-card-v1"],
  { revalidate: 60, tags: ["creator-deal"] },
);

export async function getDealCardDataCached(
  userId: string,
): Promise<CreatorDealData | null> {
  return cachedDealCardData(userId);
}
