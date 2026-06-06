import "server-only";

import { adminDb } from "@/lib/admin-db";
import type { CreatorSocialPlatform } from "@/lib/backend-api";
import {
  getCreatorLinkedSocials,
  isLinkedSocialUsername,
} from "../../_queries/socials-by-user";

/** Shape consumed by the `HeaderSocials` chip row. */
export type HeaderSocial = {
  id: string;
  platform: string;
  username: string;
  followerCount: number | null;
  subscriberCount: number | null;
  lastFetchedAt: string | null;
};

/**
 * Linked social chips for the creator header — same merged source as roster
 * cards ({@link getCreatorLinkedSocials}: admin DB wins per platform,
 * backend approved queue is the fallback). Admin-DB rows enrich follower
 * counts when present; backend-only links render with null stats.
 *
 * Best-effort by the caller (wrapped so a failure renders "No socials
 * linked" rather than crashing the hero).
 */
export async function getCreatorHeaderSocials(
  userId: string,
): Promise<HeaderSocial[]> {
  const [adminSocials, merged] = await Promise.all([
    adminDb.creator_socials.findMany({
      where: { target_user_id: userId },
      orderBy: { platform: "asc" },
      select: {
        id: true,
        platform: true,
        username: true,
        follower_count: true,
        subscriber_count: true,
        last_fetched_at: true,
      },
    }),
    getCreatorLinkedSocials(userId),
  ]);

  const adminByChip = new Map<
    CreatorSocialPlatform,
    (typeof adminSocials)[number]
  >();
  for (const row of adminSocials) {
    const chip: CreatorSocialPlatform =
      row.platform === "twitter" ? "x" : (row.platform as CreatorSocialPlatform);
    adminByChip.set(chip, row);
  }

  return merged
    .filter((s) => isLinkedSocialUsername(s.username))
    .map((s) => {
      const admin = adminByChip.get(s.platform);
      return {
        id: admin?.id ?? s.id,
        platform: s.platform === "x" ? "twitter" : s.platform,
        username: s.username,
        followerCount: admin?.follower_count ?? null,
        subscriberCount: admin?.subscriber_count ?? null,
        lastFetchedAt: admin?.last_fetched_at?.toISOString() ?? null,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
}
