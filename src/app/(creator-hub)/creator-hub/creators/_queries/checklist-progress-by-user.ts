import "server-only";

import { unstable_cache } from "next/cache";
import { and, inArray, isNull } from "drizzle-orm";

import { adminDrizzle } from "@/lib/drizzle";
import { creator_onboarding_checklist } from "@/lib/db-schema/admin/schema";
import { logWarn } from "@/lib/errors/logger";

import {
  getCreatorChecklistProgress,
  isChecklistTableMissing,
} from "../[id]/_queries/onboarding-checklist-data";

/**
 * Batched onboarding-checklist progress for the roster — kills the roster's
 * checklist N+1.
 *
 * Previously every RosterCard mounted its own `CreatorChecklistProgress`
 * Suspense island, and EACH island ran the full eligibility read + auto-item
 * derivation (admin-DB row + socials + backend deal/LB/API-key/header
 * lookups) — one uncached fan-out per creator per render.
 *
 * Now the roster runs ONE admin-DB `IN` query over
 * `creator_onboarding_checklist` (the same source of truth the detail page's
 * `onboarding-checklist-shared.ts` contract is built on) to find the creators
 * that are actually ENROLLED and still in progress (`completed_at IS NULL` —
 * only Add-Creator-v2 enrollees ever have a row, so this set is small). Only
 * for those few does it derive the real progress counts via the canonical
 * `getCreatorChecklistProgress` (identical badge semantics: same items, same
 * auto-hide, same partial handling). Everyone else costs zero extra reads.
 *
 * The whole pass is wrapped in `unstable_cache` (120s, tagged) so repeated
 * roster renders within the window reuse one result. NOTE: the checklist
 * mutation actions under `[id]/_components` revalidate paths, not this tag —
 * a just-toggled manual item can read stale on the roster for up to the TTL.
 */

const ROSTER_CHECKLIST_CACHE_TAG = "creator-hub-roster-checklist";
const ROSTER_CHECKLIST_REVALIDATE_S = 120;

/** Serializable per-creator progress for the roster pill. */
export type RosterChecklistProgress = {
  doneCount: number;
  totalCount: number;
};

async function computeChecklistProgressByUser(
  userIds: string[],
): Promise<Record<string, RosterChecklistProgress>> {
  // 1) One IN query — who is enrolled and still in progress?
  let eligibleIds: string[];
  try {
    const rows = await adminDrizzle
      .select({ target_user_id: creator_onboarding_checklist.target_user_id })
      .from(creator_onboarding_checklist)
      .where(
        and(
          inArray(creator_onboarding_checklist.target_user_id, userIds),
          isNull(creator_onboarding_checklist.completed_at),
        ),
      );
    eligibleIds = rows.map((r) => r.target_user_id);
  } catch (err) {
    if (isChecklistTableMissing(err)) {
      logWarn(
        "creator-hub.roster-checklist",
        "creator_onboarding_checklist table missing — no roster badges",
      );
      return {};
    }
    throw err;
  }

  if (eligibleIds.length === 0) return {};

  // 2) Derive real progress only for the (small) eligible set, in parallel.
  //    Each derivation is already best-effort + timeout-guarded internally.
  const results = await Promise.all(
    eligibleIds.map(async (id) => {
      try {
        const progress = await getCreatorChecklistProgress(id);
        if (!progress || progress.complete) return null;
        return [
          id,
          {
            doneCount: progress.doneCount,
            totalCount: progress.totalCount,
          } satisfies RosterChecklistProgress,
        ] as const;
      } catch (err) {
        logWarn(
          "creator-hub.roster-checklist",
          `progress derivation failed for ${id} (badge hidden)`,
          err,
        );
        return null;
      }
    }),
  );

  return Object.fromEntries(results.filter((r) => r !== null));
}

/**
 * Batched, cached roster checklist progress keyed by creator user id.
 * Creators that are not enrolled, already complete, or whose derivation
 * failed are simply absent (the pill auto-hides).
 */
export async function getChecklistProgressByUser(
  userIds: string[],
): Promise<Record<string, RosterChecklistProgress>> {
  if (userIds.length === 0) return {};
  const sorted = [...userIds].sort();
  const cached = unstable_cache(
    () => computeChecklistProgressByUser(sorted),
    ["creator-hub-roster-checklist", sorted.join(",")],
    {
      revalidate: ROSTER_CHECKLIST_REVALIDATE_S,
      tags: [ROSTER_CHECKLIST_CACHE_TAG],
    },
  );
  return cached();
}
