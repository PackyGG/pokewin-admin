"use server";

import { verifySession } from "@/lib/dal";
import {
  getLiveUserCount,
  type LiveUserCount,
} from "@/lib/queries/dashboard-live";

/**
 * Poll endpoint for the global <LiveIndicator /> in the admin top bar.
 *
 * Only gated on `verifySession()` — any signed-in admin should see the
 * indicator regardless of their page permissions, because the header is
 * rendered on every admin route (including pages a creator/support user
 * can reach). The underlying query respects EXCL_STAFF_FRAG so numbers
 * match the dashboard analytics.
 */
export async function fetchLiveUserCount(): Promise<LiveUserCount> {
  await verifySession();
  return getLiveUserCount();
}
