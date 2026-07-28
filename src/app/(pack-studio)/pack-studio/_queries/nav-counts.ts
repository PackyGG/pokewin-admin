import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { countPendingDrafts } from "@/lib/queries/pack-retune-drafts";

/**
 * Cheap, cached nav-badge counts for the Pack Studio sidebar — how many
 * pack-creation requests await owner review and how many retune drafts await
 * a push. Both are ADMIN-DB `count(*)` reads over tiny tables, cached for 60s
 * so the layout (which renders on every Studio navigation) never adds a
 * per-nav round-trip.
 *
 * Freshness: builder submissions revalidate the `pack-build-drafts` tag (so
 * the queue badge busts immediately on a new request); approve/decline only
 * `revalidatePath` the queue page, so the badge can lag those by up to the
 * 60s TTL — acceptable for a nav hint, and the page itself is always fresh.
 */
const getCachedPendingRequestCount = unstable_cache(
  async (): Promise<number> => {
    const result = await adminDrizzle.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM pack_creation_requests
      WHERE status = 'pending'
    `);
    return result.rows[0]?.n ?? 0;
  },
  ["pack-studio-nav-pending-requests"],
  { revalidate: 60, tags: ["pack-build-drafts"] },
);

export type PackStudioNavCounts = {
  /** Pending pack-creation requests (owner Approval Queue badge). */
  pendingRequests: number;
  /** Retune drafts awaiting push (operator Drafts badge). */
  pendingDrafts: number;
};

/**
 * Resolve the badge counts the viewer can actually see — the queue badge only
 * for owners, the drafts badge only for retune operators — and degrade to
 * zeros on any read fault so a transient ADMIN blip never breaks the shell.
 */
export async function getPackStudioNavCounts(input: {
  includeQueue: boolean;
  includeDrafts: boolean;
}): Promise<PackStudioNavCounts> {
  try {
    const [pendingRequests, pendingDrafts] = await Promise.all([
      input.includeQueue ? getCachedPendingRequestCount() : Promise.resolve(0),
      input.includeDrafts ? countPendingDrafts() : Promise.resolve(0),
    ]);
    return { pendingRequests, pendingDrafts };
  } catch (err) {
    console.error("[pack-studio] getPackStudioNavCounts failed:", err);
    return { pendingRequests: 0, pendingDrafts: 0 };
  }
}
