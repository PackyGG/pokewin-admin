"use server";

import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { getUserIdsMatchingFilters } from "@/lib/queries/users-list";
import { queryMainRows } from "@/lib/drizzle-query";
import {
  roundUsd,
  tierMatchesDeposit,
  validateRewardTiers,
  type RewardTier,
} from "@/lib/reward-campaign-tiers";
// A "use server" module may only export async functions, so the cap lives in
// the shared client-importable contract module.
import { REWARD_AUDIENCE_MAX } from "@/lib/user-notification";

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

export type ResolvedRewardTier = {
  tier: RewardTier;
  userIds: string[];
  count: number;
  exposureUsd: number;
};

export type TieredRewardAudience = {
  count: number;
  truncated: boolean;
  unmatched: number;
  overlaps: number;
  tiers: ResolvedRewardTier[];
};

export async function resolveRewardAudienceAction(
  filters: AudienceFilters,
): Promise<
  | { success: true; audience: ResolvedAudience }
  | { success: false; error: string }
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
      error:
        err instanceof Error ? err.message : "Couldn't resolve the audience",
    };
  }
}

function windowSql(tier: RewardTier, values: unknown[], now: Date): string {
  if (tier.window.kind === "lifetime") return "TRUE";
  if (tier.window.kind === "rolling") {
    values.push(
      new Date(now.getTime() - tier.window.days * 86_400_000).toISOString(),
    );
    return `lt.created_at >= $${values.length}::timestamptz`;
  }
  values.push(`${tier.window.startDate}T00:00:00.000Z`);
  const startParam = values.length;
  values.push(
    new Date(`${tier.window.endDate}T00:00:00.000Z`).getTime() + 86_400_000,
  );
  const endParam = values.length;
  return `lt.created_at >= $${startParam}::timestamptz
          AND lt.created_at < to_timestamp($${endParam}::double precision / 1000.0)`;
}

/**
 * Resolve a tiered campaign in one deposit aggregate. Each tier can inspect a
 * different lifetime, rolling, or custom UTC window. When rules overlap, the
 * first matching tier wins; the overlap count is surfaced to the operator.
 */
export async function resolveTieredRewardAudienceAction(input: {
  filters: AudienceFilters;
  pickedUserIds?: string[];
  tiers: RewardTier[];
}): Promise<
  | { success: true; audience: TieredRewardAudience }
  | { success: false; error: string }
> {
  const session = await requirePageAccess(PAGE_KEY);
  await requireCapability(
    session,
    CAPABILITY,
    "resolve a tiered reward audience",
  );

  const tierError = validateRewardTiers(input.tiers);
  if (tierError) return { success: false, error: tierError };

  try {
    const eligibleIds = await getUserIdsMatchingFilters({
      deposited: input.filters.deposited,
      status: input.filters.status,
      affiliateCode: input.filters.affiliateCode?.trim() || undefined,
    });
    const picked = input.pickedUserIds
      ? new Set(input.pickedUserIds.map((id) => id.trim()).filter(Boolean))
      : null;
    const candidateIds = picked
      ? eligibleIds.filter((id) => picked.has(id))
      : eligibleIds;
    const truncated = candidateIds.length > REWARD_AUDIENCE_MAX;
    if (truncated) {
      return {
        success: true,
        audience: {
          count: candidateIds.length,
          truncated: true,
          unmatched: 0,
          overlaps: 0,
          tiers: input.tiers.map((tier) => ({
            tier,
            userIds: [],
            count: 0,
            exposureUsd: 0,
          })),
        },
      };
    }
    if (candidateIds.length === 0) {
      return {
        success: true,
        audience: {
          count: 0,
          truncated: false,
          unmatched: 0,
          overlaps: 0,
          tiers: input.tiers.map((tier) => ({
            tier,
            userIds: [],
            count: 0,
            exposureUsd: 0,
          })),
        },
      };
    }

    const values: unknown[] = [candidateIds];
    const now = new Date();
    const columns = input.tiers.map((tier, index) => {
      const predicate = windowSql(tier, values, now);
      return `COALESCE(SUM(ABS(lt.amount::numeric)) FILTER (WHERE ${predicate}), 0)::text AS deposit_${index}`;
    });
    const rows = await queryMainRows<Array<Record<string, string>>>(
      `SELECT requested.id, ${columns.join(", ")}
       FROM unnest($1::text[]) AS requested(id)
       LEFT JOIN ledger_transactions lt
         ON lt.user_id = requested.id
        AND lt.type::text = 'deposit'
        AND lt.status::text = 'completed'
       GROUP BY requested.id`,
      ...values,
    );

    const tierUserIds = input.tiers.map(() => [] as string[]);
    let unmatched = 0;
    let overlaps = 0;
    for (const row of rows) {
      const matches: number[] = [];
      for (let index = 0; index < input.tiers.length; index++) {
        const depositedUsd = Number(row[`deposit_${index}`] ?? 0);
        if (tierMatchesDeposit(input.tiers[index], depositedUsd)) {
          matches.push(index);
        }
      }
      if (matches.length === 0) unmatched++;
      else {
        tierUserIds[matches[0]].push(row.id);
        if (matches.length > 1) overlaps++;
      }
    }

    const tiers = input.tiers.map((tier, index) => ({
      tier,
      userIds: tierUserIds[index],
      count: tierUserIds[index].length,
      exposureUsd: roundUsd(tierUserIds[index].length * tier.rewardUsd),
    }));
    return {
      success: true,
      audience: {
        count: tiers.reduce((sum, tier) => sum + tier.count, 0),
        truncated: false,
        unmatched,
        overlaps,
        tiers,
      },
    };
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Couldn't resolve the tiered audience",
    };
  }
}

/** One hand-picked recipient, as the picker returns them. */
export type PickedUser = {
  id: string;
  username: string | null;
  email: string | null;
};
