import "server-only";

import { adminDb } from "@/lib/admin-db";

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
 * Thin admin-DB read of just the columns the creator-header social chips
 * render — the SAME trimmed select `getCreatorDetail` uses for its
 * `socials` field, lifted out so the hero can stream the chips in their own
 * Suspense boundary without waiting on the full 12-round-trip analytics
 * aggregate. Admin DB only (creator_socials), no game/user data.
 *
 * Best-effort by the caller (wrapped so a failure renders "No socials
 * linked" rather than crashing the hero).
 */
export async function getCreatorHeaderSocials(
  userId: string,
): Promise<HeaderSocial[]> {
  const socials = await adminDb.creator_socials.findMany({
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
  });

  return socials.map((s) => ({
    id: s.id,
    platform: s.platform,
    username: s.username,
    followerCount: s.follower_count,
    subscriberCount: s.subscriber_count,
    lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
  }));
}
