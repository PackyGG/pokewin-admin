import "server-only";

import { asc, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { creator_socials } from "@/lib/db-schema/admin/schema";
import type { CreatorSocialPlatform } from "@/lib/backend-api";
import {
  getCreatorLinkedSocialsCached,
  isLinkedSocialUsername,
  isRetiredSocialPlatform,
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
 * cards (admin DB wins per platform, backend approved queue is the
 * fallback). Admin-DB rows enrich follower counts when present;
 * backend-only links render with null stats.
 *
 * Uses {@link getCreatorLinkedSocialsCached} (180s TTL, tag-flushed on
 * social edits) — the uncached helper re-walked the ENTIRE backend
 * approval roster on every banner render to extract this one user.
 *
 * Best-effort by the caller (wrapped so a failure renders "No socials
 * linked" rather than crashing the hero).
 */
export async function getCreatorHeaderSocials(
  userId: string,
): Promise<HeaderSocial[]> {
  const [adminSocials, merged] = await Promise.all([
    adminDrizzle
      .select({
        id: creator_socials.id,
        platform: creator_socials.platform,
        username: creator_socials.username,
        follower_count: creator_socials.follower_count,
        subscriber_count: creator_socials.subscriber_count,
        last_fetched_at: creator_socials.last_fetched_at,
      })
      .from(creator_socials)
      .where(eq(creator_socials.target_user_id, userId))
      .orderBy(asc(creator_socials.platform)),
    getCreatorLinkedSocialsCached(userId),
  ]);

  const adminByChip = new Map<
    CreatorSocialPlatform,
    (typeof adminSocials)[number]
  >();
  for (const row of adminSocials) {
    if (isRetiredSocialPlatform(row.platform)) continue;
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
        lastFetchedAt: admin?.last_fetched_at
          ? new Date(admin.last_fetched_at).toISOString()
          : null,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
}
