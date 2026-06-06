"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import {
  persistDiscordChannelUrl,
  persistRewardPageUrl,
} from "@/lib/creator-social-urls";
import { fetchPublicStats } from "@/lib/socials-public";

import { promoteUserToCreator } from "../../../../(admin)/creators/backend-actions";
import { enrollCreatorOnboardingChecklist } from "../[id]/_queries/onboarding-checklist-data";

const SetupSchema = z.object({
  userId: z.string().min(1),
  discordId: z.string().trim().min(1).max(100),
  discordChannelUrl: z.string().trim().url().max(2048),
  twitter: z.string().trim().max(100).optional(),
  kick: z.string().trim().max(100).optional(),
  rewardPageUrl: z.string().trim().url().max(2048).optional().or(z.literal("")),
});

export type CandidateSetupProfile = {
  userId: string;
  username: string | null;
  email: string | null;
  image: string | null;
  codes: { id: string; code: string }[];
};

/** Load identity + owned codes for the profile-setup step (main DB read-only). */
export async function getCandidateSetupProfile(
  userId: string,
): Promise<CandidateSetupProfile | null> {
  await requireCreatorHubAccess("Not authorized to add creators in Creator Hub.");
  const db = await getDb();

  const [user, codes] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, image: true, role: true },
    }),
    db.affiliate_codes.findMany({
      where: { user_id: userId },
      select: { id: true, code: true },
      orderBy: { created_at: "asc" },
    }),
  ]);

  if (!user || user.role === "creator") return null;

  return {
    userId: user.id,
    username: user.username,
    email: user.email,
    image: user.image,
    codes,
  };
}

async function saveOptionalSocial(
  userId: string,
  platform: "twitter" | "kick",
  handle: string | undefined,
): Promise<void> {
  const trimmed = handle?.trim().replace(/^@/, "");
  if (!trimmed) return;

  const stats = await fetchPublicStats(platform, trimmed).catch(() => ({
    followerCount: null as number | null,
    platformUserId: null as string | null,
  }));

  await adminDb.creator_socials.upsert({
    where: {
      target_user_id_platform: { target_user_id: userId, platform },
    },
    create: {
      target_user_id: userId,
      platform,
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? null,
      last_fetched_at: new Date(),
    },
    update: {
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? null,
      last_fetched_at: new Date(),
      updated_at: new Date(),
    },
    select: { id: true },
  });
}

/**
 * Step 3: persist social profile (admin DB) then promote via the existing
 * backend API. Redirect target is `/creator-hub/creators/[id]`.
 */
export async function completeCreatorOnboarding(
  input: z.infer<typeof SetupSchema>,
): Promise<{ userId: string }> {
  await requireCreatorHubAccess("Not authorized to add creators in Creator Hub.");
  const parsed = SetupSchema.parse(input);
  const discordId = parsed.discordId.replace(/^@/, "");

  const discordStats = await fetchPublicStats("discord", discordId).catch(
    () => ({
      followerCount: null as number | null,
      platformUserId: null as string | null,
    }),
  );

  await adminDb.creator_socials.upsert({
    where: {
      target_user_id_platform: {
        target_user_id: parsed.userId,
        platform: "discord",
      },
    },
    create: {
      target_user_id: parsed.userId,
      platform: "discord",
      username: discordId,
      platform_user_id: discordStats.platformUserId ?? null,
      follower_count: discordStats.followerCount ?? null,
      last_fetched_at: new Date(),
    },
    update: {
      username: discordId,
      platform_user_id: discordStats.platformUserId ?? null,
      follower_count: discordStats.followerCount ?? null,
      last_fetched_at: new Date(),
      updated_at: new Date(),
    },
    select: { id: true },
  });

  await persistDiscordChannelUrl(
    parsed.userId,
    parsed.discordChannelUrl,
    discordId,
  );

  await saveOptionalSocial(parsed.userId, "twitter", parsed.twitter);
  await saveOptionalSocial(parsed.userId, "kick", parsed.kick);

  if (parsed.rewardPageUrl?.trim()) {
    await persistRewardPageUrl(
      parsed.userId,
      parsed.rewardPageUrl,
      discordId,
    );
  }

  await promoteUserToCreator(parsed.userId);
  await enrollCreatorOnboardingChecklist(parsed.userId);

  revalidatePath("/creator-hub/creators");
  revalidatePath(`/creator-hub/creators/${parsed.userId}`);

  return { userId: parsed.userId };
}
