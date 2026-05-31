"use server";

import { verifySession } from "@/lib/dal";
import { getActivityCounts24h } from "@/lib/queries/dashboard";
import { getLiveActivity, type LiveActivityItem } from "@/lib/queries/dashboard-live";

/**
 * Server actions for the docked Recent Activity widget. Mirrors the
 * `live-actions.ts` module used by the dashboard's in-page feeds, except
 * the auth gate is `verifySession` (any logged-in admin user) instead of
 * `requirePageAccess("/dashboard")` — the widget docks on every admin
 * page, so a support / marketing / creator user whose role doesn't
 * include `/dashboard` should still see the live activity dock.
 */

/**
 * Rolling-24h counts strip for the docked widget: signups + packs opened
 * + battles played. Backed by the same caches the dashboard hits
 * (`cachedUserCounts`, `cached24hPackOpens`, `cached24hBattles`) so this
 * call piggy-backs on the dashboard's 60s / 5min cache windows and adds
 * zero DB pressure once warm.
 */
export async function fetchRecentActivityCounts24h(): Promise<{
  signups24h: number;
  packsOpened24h: number;
  battlesPlayed24h: number;
}> {
  await verifySession();
  return getActivityCounts24h();
}

/**
 * Polling fallback for the live event stream — only used when SSE is
 * unavailable (the docked widget uses `useSseStream` against
 * `/api/live/activity` by default, and falls back to this on giveup).
 * Same cursor contract as `fetchRecentActivityLive` in the dashboard
 * actions module: `null` cursor → newest snapshot; non-null → strict-gt
 * filter for rows after the cursor.
 */
export async function fetchDockedActivityLive(
  sinceCreatedAt: string | null,
): Promise<LiveActivityItem[]> {
  await verifySession();
  return getLiveActivity({ sinceCreatedAt, limit: 30 });
}
