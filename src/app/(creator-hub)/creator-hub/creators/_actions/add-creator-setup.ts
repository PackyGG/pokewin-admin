"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { asc, eq } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { affiliate_codes, user } from "@/lib/db-schema/main/schema";
import { adminDrizzle } from "@/lib/drizzle";
import { creator_socials } from "@/lib/db-schema/admin/schema";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { persistRewardPageUrl } from "@/lib/creator-social-urls";
import { fetchPublicStats } from "@/lib/socials-public";

import { promoteUserToCreator } from "../../../../(admin)/creators/backend-actions";
import { enrollCreatorInOnboardingChecklist } from "../[id]/_queries/onboarding-checklist-data";

const SetupSchema = z.object({
  userId: z.string().min(1),
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
  const db = await getReadDrizzleDb();

  const [candidateRows, codes] = await Promise.all([
    db
      .select({
        id: user.id,
        username: user.username,
        email: user.email,
        image: user.image,
        role: user.role,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    db
      .select({ id: affiliate_codes.id, code: affiliate_codes.code })
      .from(affiliate_codes)
      .where(eq(affiliate_codes.user_id, userId))
      .orderBy(asc(affiliate_codes.created_at)),
  ]);
  const candidate = candidateRows[0];

  if (!candidate || candidate.role === "creator") return null;

  return {
    userId: candidate.id,
    username: candidate.username,
    email: candidate.email,
    image: candidate.image,
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

  const now = new Date().toISOString();
  await adminDrizzle
    .insert(creator_socials)
    .values({
      target_user_id: userId,
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

  await saveOptionalSocial(parsed.userId, "twitter", parsed.twitter);
  await saveOptionalSocial(parsed.userId, "kick", parsed.kick);

  if (parsed.rewardPageUrl?.trim()) {
    await persistRewardPageUrl(parsed.userId, parsed.rewardPageUrl);
  }

  await promoteUserToCreator(parsed.userId);

  await enrollCreatorInOnboardingChecklist(parsed.userId);

  revalidatePath("/creator-hub/creators");
  revalidatePath(`/creator-hub/creators/${parsed.userId}`);

  return { userId: parsed.userId };
}
