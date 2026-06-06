"use server";

import { revalidatePath } from "next/cache";

import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import {
  refetchTwitterProfile,
  refetchLatestTweets,
  scanBrandMentions,
} from "@/lib/creator-hub";

/**
 * Manual **Refetch** for the `creators/[id]` Twitter tab.
 *
 * Forces a fresh pull of the linked handle's X profile + latest tweets + 7-day
 * mention scan through the integration, then revalidates the creator detail
 * route so the tab re-reads from the refreshed ADMIN-DB cache.
 *
 * NO-SPAM: `force` does NOT bypass the integration's hard min-interval floor —
 * a manager mashing the button is still served from the DB until the floor
 * elapses (anti-mash). This action makes at most three throttle-gated calls;
 * there is no loop/poll. The `scanBrandMentions` call reuses the same tweets
 * cache the `refetchLatestTweets` call just warmed, so it adds no extra API hit.
 *
 * SECURITY: gated with `requireCreatorHubAccess` (the Hub's access rule). The RapidAPI key is read
 * server-only inside the integration and never returned. MAIN/prod DB is never
 * touched (the handle + cache are ADMIN-DB only).
 *
 * @param userId  the creator's MAIN-DB user id (for the revalidate path).
 * @param handle  the linked Twitter handle to refresh.
 */
export async function refetchTwitterTab(
  userId: string,
  handle: string,
): Promise<void> {
  await requireCreatorHubAccess();

  const trimmed = handle?.trim();
  if (!userId) throw new Error("Missing creator id");
  if (!trimmed) throw new Error("No Twitter handle linked");

  // Profile + tweets first (the heavy refreshes), then the mention scan, which
  // reuses the just-warmed tweets cache. Each is independently throttle-gated.
  await Promise.all([
    refetchTwitterProfile(trimmed),
    refetchLatestTweets(trimmed),
  ]);
  await scanBrandMentions(trimmed, { force: true });

  revalidatePath(`/creator-hub/creators/${userId}`);
}
