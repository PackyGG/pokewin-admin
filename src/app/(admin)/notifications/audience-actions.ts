"use server";


import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { getUserIdsMatchingFilters } from "@/lib/queries/users-list";

/**
 * Who a reward campaign goes to, resolved server-side.
 *
 * Recipients used to be a textarea you pasted ids into. Nobody has 16,000
 * user ids to paste, so this replaces it with the two ways an operator
 * actually thinks: "these specific people" or "everyone who matches X".
 *
 * The filter path delegates to `getUserIdsMatchingFilters` — the SAME
 * predicate builder the /users table renders from. That reuse is the point:
 * the count shown here and the population that gets paid can't drift apart,
 * and it already excludes banned users and staff, which is exactly right for
 * a payout too (don't reward a banned account, don't pay ourselves).
 *
 * Gated identically to the send itself, since knowing how many users match a
 * filter is the same information the /users page would give you.
 */

const PAGE_KEY = "/notifications";
const CAPABILITY = "__can_send_user_notifications";

/** Ceiling on one campaign. `getUserIdsMatchingFilters` fetches one row past
 * its own cap so an over-large audience is detectable rather than silently
 * truncated — surfaced as `truncated` and blocked in the UI. */
export const REWARD_AUDIENCE_MAX = 25_000;

export type AudienceFilters = {
  /** "yes" | "no" | undefined — has ever deposited. */
  deposited?: string;
  /** "active" | "locked" — `banned` is excluded unconditionally upstream. */
  status?: string;
  /** Restrict to users on one affiliate code. */
  affiliateCode?: string;
};

export type ResolvedAudience = {
  count: number;
  /** Capped sample for the UI; the send re-resolves server-side. */
  sample: string[];
  truncated: boolean;
};

export async function resolveRewardAudienceAction(
  filters: AudienceFilters,
): Promise<
  { success: true; audience: ResolvedAudience } | { success: false; error: string }
> {
  const session = await requirePageAccess(PAGE_KEY);
  await requireCapability(session, CAPABILITY, "resolve a reward audience");

  try {
    const ids = await getUserIdsMatchingFilters({
      deposited: filters.deposited,
      status: filters.status,
      affiliateCode: filters.affiliateCode?.trim() || undefined,
    });
    const truncated = ids.length > REWARD_AUDIENCE_MAX;
    return {
      success: true,
      audience: {
        count: truncated ? REWARD_AUDIENCE_MAX : ids.length,
        sample: ids.slice(0, REWARD_AUDIENCE_MAX),
        truncated,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Couldn't resolve the audience",
    };
  }
}

/** One hand-picked recipient, as the picker returns them. */
export type PickedUser = {
  id: string;
  username: string | null;
  email: string | null;
};
