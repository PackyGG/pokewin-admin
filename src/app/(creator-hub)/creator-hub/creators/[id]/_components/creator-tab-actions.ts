"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { and, eq } from "drizzle-orm";

import { adminDrizzle } from "@/lib/drizzle";
import { creator_socials } from "@/lib/db-schema/admin/schema";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { CREATOR_LINKED_SOCIALS_CACHE_TAG } from "../../../../../(admin)/creators/_queries/socials-by-user";
import {
  clearDiscordChannelUrl,
  clearRewardPageUrl,
  persistDiscordChannelUrl,
  persistRewardPageUrl,
} from "@/lib/creator-social-urls";
import { fetchPublicStats } from "@/lib/socials-public";

/**
 * Manager-side editing of a creator's social links, for the `creators/[id]`
 * **Creator** tab.
 *
 * Writes the SAME admin-DB table the rest of the app uses (`creator_socials`,
 * keyed `@@unique([target_user_id, platform])`) — the difference from the
 * creator-self-service `my-profile/actions.ts` path is purely the gate: there
 * the actor must BE the creator; here a Creator-Hub **manager**
 * (admin / creator_manager) edits ANY creator. Admin-DB writes are allowed;
 * MAIN/prod is never touched.
 *
 * Every mutation:
 *   • is gated with `requireCreatorHubAccess` (the Hub's own access rule);
 *   • validates input server-side (no trust in the client);
 *   • refreshes the public follower stat via the existing `fetchPublicStats`
 *     helper (best-effort — a scraper miss never blocks the save);
 *   • leaves an `admin_audit_event` so the social edit is traceable;
 *   • revalidates the creator detail route so the tab re-reads.
 */

// The platforms a manager can edit from the Creator tab. These are the four
// the owner spec calls out (Twitter / Kick / Discord ID / Reward page) minus
// "Reward page" — there is NO `social_platform` enum value or column for a
// reward URL today, so it is intentionally NOT writable here (the tab renders
// it as a clearly-labelled "not storable yet" field rather than guessing a
// home for it). All four allowed values below are real `social_platform`
// members.
const EDITABLE_PLATFORMS = ["twitter", "kick", "discord"] as const;
type EditablePlatform = (typeof EDITABLE_PLATFORMS)[number];

function assertEditablePlatform(p: string): asserts p is EditablePlatform {
  if (!EDITABLE_PLATFORMS.includes(p as EditablePlatform)) {
    throw new Error("Unsupported social platform");
  }
}

function revalidateCreator(userId: string) {
  // The Hub detail route (this tab) + the legacy admin detail route both read
  // creator_socials, so refresh both so the change is consistent across
  // surfaces during the cut-over period.
  revalidatePath(`/creator-hub/creators/${userId}`);
  revalidatePath(`/creators/${userId}`);
  // The banner / metadata socials read through an `unstable_cache` entry
  // (`getCreatorLinkedSocialsCached`) which `revalidatePath` does NOT bust
  // — flush its tag so the edit is visible immediately, not after the TTL.
  revalidateTag(CREATOR_LINKED_SOCIALS_CACHE_TAG);
}

/**
 * Create or update a creator's handle for one platform. `username` is the
 * raw handle (for Discord this is the Discord ID / username — Discord has no
 * public profile URL, so it's stored as-is for reference). An empty username
 * is rejected; use {@link removeCreatorSocial} to clear a platform.
 */
export async function upsertCreatorSocial(
  targetUserId: string,
  platform: string,
  username: string,
  options?: { discordChannelUrl?: string | null },
): Promise<{ followerCount: number | null }> {
  const session = await requireCreatorHubAccess();

  if (!targetUserId) throw new Error("Missing creator id");
  assertEditablePlatform(platform);

  const trimmed = username.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Handle is required");
  if (trimmed.length > 100) throw new Error("Handle is too long");

  // Best-effort public-stat refresh. Discord has no public follower API in
  // `fetchPublicStats` (returns null), and any scraper miss degrades to null
  // rather than failing the save — the handle is what matters.
  const stats = await fetchPublicStats(platform, trimmed).catch(() => ({
    followerCount: null as number | null,
    platformUserId: null as string | null,
  }));

  const now = new Date().toISOString();
  await adminDrizzle
    .insert(creator_socials)
    .values({
      target_user_id: targetUserId,
      platform,
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? null,
      last_fetched_at: now,
    })
    .onConflictDoUpdate({
      target: [creator_socials.target_user_id, creator_socials.platform],
      set: {
        username: trimmed,
        platform_user_id: stats.platformUserId ?? null,
        follower_count: stats.followerCount ?? null,
        last_fetched_at: now,
        updated_at: now,
      },
    })
    // Only the id is consumed — explicit select avoids a RETURNING * crash if
    // the generated client knows a column prod hasn't migrated yet.
    .returning({ id: creator_socials.id });

  if (platform === "discord" && options?.discordChannelUrl?.trim()) {
    await persistDiscordChannelUrl(
      targetUserId,
      options.discordChannelUrl,
      trimmed,
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_edited",
    targetUserId,
    metadata: { platform, username: trimmed, via: "creator_hub_tab" },
  });

  revalidateCreator(targetUserId);
  return { followerCount: stats.followerCount ?? null };
}

/**
 * Remove a creator's linked handle for one platform (clears the field). No-op
 * if no row exists for that platform.
 */
export async function removeCreatorSocial(
  targetUserId: string,
  platform: string,
): Promise<void> {
  const session = await requireCreatorHubAccess();

  if (!targetUserId) throw new Error("Missing creator id");
  assertEditablePlatform(platform);

  const deleted = await adminDrizzle
    .delete(creator_socials)
    .where(
      and(
        eq(creator_socials.target_user_id, targetUserId),
        eq(creator_socials.platform, platform),
      ),
    )
    .returning({ id: creator_socials.id });
  if (deleted.length === 0) {
    // Nothing to delete — keep idempotent so a double-click doesn't error.
    revalidateCreator(targetUserId);
    return;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_removed",
    targetUserId,
    metadata: { platform, via: "creator_hub_tab" },
  });

  revalidateCreator(targetUserId);
}

/** Save the per-creator Discord channel deep-link (admin DB only). */
export async function upsertCreatorDiscordChannel(
  targetUserId: string,
  channelUrl: string,
): Promise<void> {
  const session = await requireCreatorHubAccess();
  if (!targetUserId) throw new Error("Missing creator id");

  const existing = (
    await adminDrizzle
      .select({ username: creator_socials.username })
      .from(creator_socials)
      .where(
        and(
          eq(creator_socials.target_user_id, targetUserId),
          eq(creator_socials.platform, "discord"),
        ),
      )
      .limit(1)
  )[0];

  await persistDiscordChannelUrl(
    targetUserId,
    channelUrl,
    existing?.username,
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_edited",
    targetUserId,
    metadata: {
      field: "discord_channel_url",
      via: "creator_hub_tab",
    },
  });

  revalidateCreator(targetUserId);
}

export async function removeCreatorDiscordChannel(
  targetUserId: string,
): Promise<void> {
  const session = await requireCreatorHubAccess();
  if (!targetUserId) throw new Error("Missing creator id");

  await clearDiscordChannelUrl(targetUserId);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_removed",
    targetUserId,
    metadata: { field: "discord_channel_url", via: "creator_hub_tab" },
  });

  revalidateCreator(targetUserId);
}

/** Save or clear the creator reward-page URL (admin DB only). */
export async function upsertCreatorRewardPage(
  targetUserId: string,
  rewardUrl: string,
): Promise<void> {
  const session = await requireCreatorHubAccess();
  if (!targetUserId) throw new Error("Missing creator id");

  const existing = (
    await adminDrizzle
      .select({ username: creator_socials.username })
      .from(creator_socials)
      .where(
        and(
          eq(creator_socials.target_user_id, targetUserId),
          eq(creator_socials.platform, "discord"),
        ),
      )
      .limit(1)
  )[0];

  await persistRewardPageUrl(targetUserId, rewardUrl, existing?.username);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_edited",
    targetUserId,
    metadata: { field: "reward_page_url", via: "creator_hub_tab" },
  });

  revalidateCreator(targetUserId);
}

export async function removeCreatorRewardPage(
  targetUserId: string,
): Promise<void> {
  const session = await requireCreatorHubAccess();
  if (!targetUserId) throw new Error("Missing creator id");

  await clearRewardPageUrl(targetUserId);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_removed",
    targetUserId,
    metadata: { field: "reward_page_url", via: "creator_hub_tab" },
  });

  revalidateCreator(targetUserId);
}
