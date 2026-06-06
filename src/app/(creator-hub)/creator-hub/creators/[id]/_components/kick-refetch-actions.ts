"use server";

import { revalidatePath } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { logWarn } from "@/lib/errors/logger";
import {
  isNoKeyConfigured,
  normalizeHandle,
  refetchKickProfile,
  refetchKickStreams,
} from "@/lib/creator-hub";

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
): Promise<{ ok: true; noKeyConfigured: boolean } | { ok: false; reason: string }> {
  const session = await requireCreatorHubAccess();
  if (!userId) throw new Error("Missing creator id");

  // Resolve the linked Kick handle (admin DB). No handle → nothing to refetch.
  let handle: string | null = null;
  try {
    const row = await adminDb.creator_socials.findUnique({
      where: {
        target_user_id_platform: { target_user_id: userId, platform: "kick" },
      },
      select: { username: true },
    });
    handle = normalizeHandle(row?.username ?? null);
  } catch (err) {
    logWarn("creator-hub.kick-tab", "refetch: creator_socials read failed", err);
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

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_kick_refetched",
    targetUserId: userId,
    metadata: { handle, via: "creator_hub_kick_tab", noKeyConfigured },
  });

  // Re-read the tab from the freshly-cached rows.
  revalidatePath(`/creator-hub/creators/${userId}`);

  return { ok: true, noKeyConfigured };
}
