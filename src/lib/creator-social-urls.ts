import "server-only";

import { and, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { creator_socials } from "@/lib/db-schema/admin/schema";

/**
 * Trimmed URL fields read from `creator_socials` rows for one creator.
 *
 * The hand-typed Discord channel URL that used to live here is GONE: the
 * creator↔Discord link now comes from the Discord creator-setup bot
 * (`discord_creator_setups`, see `src/lib/creator-discord-links.ts`), and the
 * `discord_channel_url` column has been dropped from the admin DB.
 */
export type CreatorSocialUrls = {
  rewardPageUrl: string | null;
};

/**
 * Read the reward-page URL for a creator. Scans all `creator_socials` rows —
 * the value is stored on the (now display-retired) discord row in practice,
 * but any non-null column wins so reads stay resilient.
 */
export async function getCreatorSocialUrls(
  targetUserId: string,
): Promise<CreatorSocialUrls> {
  const rows = await adminDrizzle.select({
    platform: creator_socials.platform,
    reward_page_url: creator_socials.reward_page_url,
  }).from(creator_socials).where(eq(creator_socials.target_user_id, targetUserId));

  const rewardPageUrl =
    rows.find((r) => r.reward_page_url?.trim())?.reward_page_url?.trim() || null;

  return { rewardPageUrl };
}

function normalizeUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.length > 2048) throw new Error(`${label} is too long`);
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`${label} must use http or https`);
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof Error && err.message.includes("must use")) throw err;
    throw new Error(`${label} must be a valid URL`);
  }
}

/**
 * Persist a reward-page URL. The `discord` row is the historical carrier for
 * this value — it is no longer rendered as a social anywhere (see
 * `isRetiredSocialPlatform`), it just holds the reward-page column.
 */
export async function persistRewardPageUrl(
  targetUserId: string,
  rewardUrl: string,
  existingDiscordUsername?: string | null,
): Promise<void> {
  const normalized = normalizeUrl(rewardUrl, "Reward page URL");

  await adminDrizzle.insert(creator_socials).values({
      target_user_id: targetUserId,
      platform: "discord",
      username: existingDiscordUsername?.trim() || "pending",
      reward_page_url: normalized,
    }).onConflictDoUpdate({
      target: [creator_socials.target_user_id, creator_socials.platform],
      set: {
      reward_page_url: normalized,
      updated_at: new Date().toISOString(),
      },
  });
}

/** Clear the reward-page URL for a creator (no-op when unset). */
export async function clearRewardPageUrl(targetUserId: string): Promise<void> {
  await adminDrizzle.update(creator_socials)
    .set({ reward_page_url: null, updated_at: new Date().toISOString() })
    .where(and(eq(creator_socials.target_user_id, targetUserId),
      eq(creator_socials.platform, "discord")));
}
