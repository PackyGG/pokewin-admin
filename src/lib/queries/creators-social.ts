import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { creator_socials } from "@/lib/db-schema/admin/schema";
import { fetchPublicStats } from "@/lib/socials-public";

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Refresh social stats for a creator if stale (>1 hour since last fetch).
 * Called on page load — non-blocking, fires and forgets.
 */
export async function refreshStaleSocials(userId: string): Promise<void> {
  const socials = await adminDrizzle.select().from(creator_socials)
    .where(eq(creator_socials.target_user_id, userId));

  const now = Date.now();

  for (const social of socials) {
    const lastFetched = social.last_fetched_at
      ? new Date(social.last_fetched_at).getTime()
      : 0;
    if (now - lastFetched < STALE_THRESHOLD_MS) continue;

    try {
      const stats = await fetchPublicStats(social.platform, social.username);

      await adminDrizzle.update(creator_socials).set({
          follower_count: stats.followerCount ?? social.follower_count,
          platform_user_id: stats.platformUserId ?? social.platform_user_id,
          last_fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).where(eq(creator_socials.id, social.id));
    } catch (error) {
      console.error(`Failed to refresh ${social.platform} stats for ${userId}:`, error);
    }
  }
}
