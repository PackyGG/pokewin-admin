"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getLiveActivity,
  getLiveDeposits,
  type LiveActivityItem,
  type LiveDepositsResult,
} from "@/lib/queries/dashboard-live";

/**
 * Poll endpoint for the live deposits panel on /dashboard.
 *
 * Cursor semantics:
 *   - `sinceCreatedAt == null` → initial fetch (returns up to `limit` newest).
 *   - Otherwise → strict-gt filter; returns only rows created AFTER the cursor.
 *
 * The 24h total is returned on every call so the hero number stays fresh
 * without a second round-trip.
 */
export async function fetchRecentDepositsLive(
  sinceCreatedAt: string | null,
): Promise<LiveDepositsResult> {
  await requirePageAccess("/dashboard");
  return getLiveDeposits({ sinceCreatedAt, limit: 30 });
}

/**
 * Poll endpoint for the mixed live-activity feed on /dashboard.
 * Same cursor contract as the deposits feed.
 */
export async function fetchRecentActivityLive(
  sinceCreatedAt: string | null,
): Promise<LiveActivityItem[]> {
  await requirePageAccess("/dashboard");
  return getLiveActivity({ sinceCreatedAt, limit: 30 });
}
