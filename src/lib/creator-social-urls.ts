import "server-only";

import { adminDb } from "@/lib/admin-db";

/** Trimmed URL fields read from `creator_socials` rows for one creator. */
export type CreatorSocialUrls = {
  discordChannelUrl: string | null;
  rewardPageUrl: string | null;
};

const URL_SELECT = {
  platform: true,
  discord_channel_url: true,
  reward_page_url: true,
} as const;

/**
 * Read discord-channel + reward-page URLs for a creator. Scans all
 * `creator_socials` rows — values are stored on the discord row in practice
 * but any non-null column wins so reads stay resilient.
 */
export async function getCreatorSocialUrls(
  targetUserId: string,
): Promise<CreatorSocialUrls> {
  const rows = await adminDb.creator_socials.findMany({
    where: { target_user_id: targetUserId },
    select: URL_SELECT,
  });

  const discordRow = rows.find((r) => r.platform === "discord");
  const discordChannelUrl =
    discordRow?.discord_channel_url?.trim() ||
    rows.find((r) => r.discord_channel_url?.trim())?.discord_channel_url?.trim() ||
    null;
  const rewardPageUrl =
    rows.find((r) => r.reward_page_url?.trim())?.reward_page_url?.trim() || null;

  return { discordChannelUrl, rewardPageUrl };
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
 * Persist a Discord channel URL on the creator's discord `creator_socials` row.
 * Creates the discord row with a placeholder username when missing (reward-only
 * writes can land before the Discord ID is saved).
 */
export async function persistDiscordChannelUrl(
  targetUserId: string,
  channelUrl: string,
  existingDiscordUsername?: string | null,
): Promise<void> {
  const normalized = normalizeUrl(channelUrl, "Discord channel link");

  await adminDb.creator_socials.upsert({
    where: {
      target_user_id_platform: {
        target_user_id: targetUserId,
        platform: "discord",
      },
    },
    create: {
      target_user_id: targetUserId,
      platform: "discord",
      username: existingDiscordUsername?.trim() || "pending",
      discord_channel_url: normalized,
    },
    update: {
      discord_channel_url: normalized,
      updated_at: new Date(),
    },
    select: { id: true },
  });
}

/** Persist a reward-page URL (discord row carrier when present). */
export async function persistRewardPageUrl(
  targetUserId: string,
  rewardUrl: string,
  existingDiscordUsername?: string | null,
): Promise<void> {
  const normalized = normalizeUrl(rewardUrl, "Reward page URL");

  await adminDb.creator_socials.upsert({
    where: {
      target_user_id_platform: {
        target_user_id: targetUserId,
        platform: "discord",
      },
    },
    create: {
      target_user_id: targetUserId,
      platform: "discord",
      username: existingDiscordUsername?.trim() || "pending",
      reward_page_url: normalized,
    },
    update: {
      reward_page_url: normalized,
      updated_at: new Date(),
    },
    select: { id: true },
  });
}

/** Clear the Discord channel URL for a creator (no-op when unset). */
export async function clearDiscordChannelUrl(
  targetUserId: string,
): Promise<void> {
  const row = await adminDb.creator_socials.findUnique({
    where: {
      target_user_id_platform: {
        target_user_id: targetUserId,
        platform: "discord",
      },
    },
    select: { id: true },
  });
  if (!row) return;

  await adminDb.creator_socials.update({
    where: { id: row.id },
    data: { discord_channel_url: null, updated_at: new Date() },
    select: { id: true },
  });
}

/** Clear the reward-page URL for a creator (no-op when unset). */
export async function clearRewardPageUrl(targetUserId: string): Promise<void> {
  const row = await adminDb.creator_socials.findUnique({
    where: {
      target_user_id_platform: {
        target_user_id: targetUserId,
        platform: "discord",
      },
    },
    select: { id: true },
  });
  if (!row) return;

  await adminDb.creator_socials.update({
    where: { id: row.id },
    data: { reward_page_url: null, updated_at: new Date() },
    select: { id: true },
  });
}
