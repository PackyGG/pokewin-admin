"use server";

import { revalidatePath } from "next/cache";

import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { logWarn } from "@/lib/errors/logger";
import {
  isNoKeyConfigured,
  refetchKickProfile,
  refetchKickStreams,
} from "@/lib/creator-hub";
import { getMergedLinkedHandle } from "../../../../../(admin)/creators/_queries/socials-by-user";

/**
 * Manual Refetch for the `creators/[id]` **Kick** tab.
 *
 * This is the ONLY forced-refresh path for a creator's Kick data — there is no
 * loop / poll / per-render fetch (owner's strict no-spam rule). It is driven
 * by the Refetch button (a manager click), and even then the underlying
 * service enforces a hard anti-mash min-interval, so a manager mashing the
 * button can't spam RapidAPI.
 *
 * Gate: `requireCreatorHubAccess` (the Hub's access rule). Admin-DB writes are
 * allowed (the service caches into the ADMIN DB); MAIN/prod is never touched.
 */
export async function refetchCreatorKick(
  userId: string,
): Promise<
  | {
      ok: true;
      noKeyConfigured: boolean;
      profileFound: boolean;
      streamCount: number;
      staleError: string | null;
    }
  | { ok: false; reason: string }
> {
  const session = await requireCreatorHubAccess();
  if (!userId) throw new Error("Missing creator id");

  // Resolve the linked Kick handle (merged admin + backend). No handle → nothing to refetch.
  let handle: string | null = null;
  try {
    handle = await getMergedLinkedHandle(userId, "kick");
  } catch (err) {
    logWarn("creator-hub.kick-tab", "refetch: linked Kick handle read failed", err);
  }

  if (!handle) {
    return { ok: false, reason: "no_handle" };
  }

  // Force-refresh profile + streams (each anti-mash throttled in the service).
  const [profileResult, streamsResult] = await Promise.all([
    refetchKickProfile(handle),
    refetchKickStreams(handle, 20),
  ]);

  const noKeyConfigured =
    isNoKeyConfigured(profileResult) || isNoKeyConfigured(streamsResult);

  const profileFound =
    !isNoKeyConfigured(profileResult) && profileResult.profile != null;
  const streamCount = isNoKeyConfigured(streamsResult)
    ? 0
    : streamsResult.streams.length;
  const staleError =
    (!isNoKeyConfigured(profileResult) ? profileResult.staleError : null) ??
    (!isNoKeyConfigured(streamsResult) ? streamsResult.staleError : null) ??
    null;

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_kick_refetched",
    targetUserId: userId,
    metadata: { handle, via: "creator_hub_kick_tab", noKeyConfigured },
  });

  // Re-read the tab from the freshly-cached rows.
  revalidatePath(`/creator-hub/creators/${userId}`);

  return {
    ok: true,
    noKeyConfigured,
    profileFound,
    streamCount,
    staleError,
  };
}
