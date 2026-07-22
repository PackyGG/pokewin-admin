import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getProdDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

import {
  BASIS_HOLDING_STATUSES,
  type CreatorRewardEntitlement,
} from "./types";

/**
 * The ONE eligibility engine for creator VIP wager rewards.
 *
 * Both the admin review UI and the Discord-bot claim endpoint call THIS —
 * never their own arithmetic. The bot supplies a Discord id and nothing else;
 * the amount it renders and the amount we would pay are the same number by
 * construction, so a tampered bot payload can't inflate a payout.
 *
 * ── THE MODEL ─────────────────────────────────────────────────────────────
 * Qualifying wager is READ from prod and never mutated. "Spending" it is
 * modelled as admin-side CONSUMPTION:
 *
 *     available = Σ(qualifying wager)  −  Σ(basis held by pending+approved claims)
 *     units     = floor(available / threshold)
 *
 * so the prod side stays a pure, replayable source of truth and rejection
 * releases basis for free (a rejected row simply stops matching the filter).
 *
 * ── WHY `accrual_start_at` MATTERS ────────────────────────────────────────
 * There is ~$3.0M of already-attributed wager in `affiliate_code_usages`. A
 * program that counted it would owe thousands of dollars the instant it was
 * switched on. Every read here is therefore bounded to wager booked at or
 * after the program's accrual start.
 *
 * ── COST ──────────────────────────────────────────────────────────────────
 * The prod read is index-served: `idx_acu_upper_code` ∧
 * `idx_acu_referred_user_created_at` resolve as a BitmapAnd (verified by
 * EXPLAIN ANALYZE against prod 2026-07-22: 0.18 ms, 2 shared buffers). It is
 * read-only and uses `getProdDb()` rather than `getDb()` so a machine caller
 * can never be served the admin's dev/prod cookie toggle.
 *
 * `usage_type` is compared as `::text` for the same 22P02 hardening every
 * other acu query in this codebase uses — prod's enum has historically lagged
 * the generated client, and a bare comparison against an unknown label throws
 * at parse time instead of simply matching nothing.
 */

/** Money in whole cents — all unit math is integer to avoid float drift. */
const toCents = (usd: number): number => Math.round(usd * 100);
const fromCents = (cents: number): number => cents / 100;

export type ProgramForCompute = {
  id: string;
  name: string;
  creator_user_id: string;
  codes: string[];
  threshold_usd: unknown;
  reward_usd: unknown;
  is_active: boolean;
  accrual_start_at: Date;
  max_reward_per_user_usd: unknown;
};

/**
 * Σ qualifying wager this user has booked under `codes` since `since`.
 *
 * Codes are matched case-insensitively: `affiliate_codes` casing is MIXED for
 * rows the 0068 migration backfilled, and `affiliate_code_usages` mirrors
 * whatever casing the caller resolved — so an exact match would silently miss
 * a legacy creator's entire history.
 */
async function qualifyingWagerUsd(
  userId: string,
  codes: readonly string[],
  since: Date,
): Promise<number> {
  if (codes.length === 0) return 0;
  const db = getProdDb();
  const upper = codes.map((c) => c.toUpperCase());

  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS total
      FROM affiliate_code_usages
     WHERE referred_user_id = ${userId}
       AND usage_type::text = 'wager'
       AND UPPER(code) = ANY(${upper}::text[])
       AND created_at >= ${since}
  `;
  return toNumber(rows[0]?.total ?? 0);
}

/**
 * Basis already held, and reward already approved, for this user on this
 * program. One grouped read over the admin-side claims.
 */
async function priorHoldings(
  programId: string,
  userId: string,
): Promise<{ consumedUsd: number; approvedRewardUsd: number }> {
  const [held, approved] = await Promise.all([
    adminDb.creator_reward_claims.aggregate({
      where: {
        program_id: programId,
        user_id: userId,
        status: { in: [...BASIS_HOLDING_STATUSES] },
      },
      _sum: { consumed_wager_usd: true },
    }),
    adminDb.creator_reward_claims.aggregate({
      where: { program_id: programId, user_id: userId, status: "approved" },
      _sum: { amount_usd: true },
    }),
  ]);

  return {
    consumedUsd: toNumber(held._sum.consumed_wager_usd ?? 0),
    approvedRewardUsd: toNumber(approved._sum.amount_usd ?? 0),
  };
}

/**
 * What can this user claim on this program right now?
 *
 * Returns a fully-populated entitlement even when nothing is claimable —
 * `units: 0` plus `wagerToNextUnitUsd` is what lets the bot say "you're $340
 * away" instead of an unhelpful "nothing available".
 */
export async function computeEntitlement(
  program: ProgramForCompute,
  userId: string,
): Promise<CreatorRewardEntitlement> {
  const thresholdCents = toCents(toNumber(program.threshold_usd));
  const rewardCents = toCents(toNumber(program.reward_usd));
  const capUsd =
    program.max_reward_per_user_usd == null
      ? null
      : toNumber(program.max_reward_per_user_usd);

  const base = {
    programId: program.id,
    programName: program.name,
    creatorUserId: program.creator_user_id,
  };

  const empty: CreatorRewardEntitlement = {
    ...base,
    qualifyingWagerUsd: 0,
    priorConsumedUsd: 0,
    availableWagerUsd: 0,
    units: 0,
    amountUsd: 0,
    consumesWagerUsd: 0,
    wagerToNextUnitUsd: 0,
    cappedByUserLimit: false,
    blockedReason: null,
  };

  if (!program.is_active) {
    return { ...empty, blockedReason: "This program is not active." };
  }
  if (thresholdCents <= 0 || rewardCents <= 0) {
    return { ...empty, blockedReason: "This program is misconfigured." };
  }
  // A creator can't farm their own program. `useCode` already refuses a user's
  // own affiliate code, but a program may span several codes and may be
  // re-pointed later, so the guard is re-asserted here at payout time.
  if (program.creator_user_id === userId) {
    return {
      ...empty,
      blockedReason: "A creator cannot claim their own program.",
    };
  }

  const [wagerUsd, prior] = await Promise.all([
    qualifyingWagerUsd(userId, program.codes, program.accrual_start_at),
    priorHoldings(program.id, userId),
  ]);

  const wagerCents = toCents(wagerUsd);
  const consumedCents = toCents(prior.consumedUsd);
  const availableCents = Math.max(0, wagerCents - consumedCents);

  let units = Math.floor(availableCents / thresholdCents);
  let cappedByUserLimit = false;

  if (capUsd != null) {
    const remainingCents = Math.max(
      0,
      toCents(capUsd) - toCents(prior.approvedRewardUsd),
    );
    const unitsAllowedByCap = Math.floor(remainingCents / rewardCents);
    if (unitsAllowedByCap < units) {
      units = unitsAllowedByCap;
      cappedByUserLimit = true;
    }
  }

  // Distance to the next unit, reported only while nothing is claimable —
  // once a unit is ready the useful number is the payout, not the remainder.
  const remainderCents = availableCents % thresholdCents;
  const toNextCents = units > 0 ? 0 : thresholdCents - remainderCents;

  return {
    ...base,
    qualifyingWagerUsd: fromCents(wagerCents),
    priorConsumedUsd: fromCents(consumedCents),
    availableWagerUsd: fromCents(availableCents),
    units,
    amountUsd: fromCents(units * rewardCents),
    consumesWagerUsd: fromCents(units * thresholdCents),
    wagerToNextUnitUsd: fromCents(toNextCents),
    cappedByUserLimit,
    blockedReason:
      units === 0 && cappedByUserLimit
        ? "This user has reached the program's per-user reward cap."
        : null,
  };
}

/**
 * Every entitlement a user has across the ACTIVE programs whose codes they've
 * actually wagered under. Drives both the bot's `/check` and the admin's
 * per-user preview.
 *
 * Programs are fetched once and evaluated concurrently; each evaluation is two
 * index-served reads, so this stays cheap even as the program count grows.
 */
export async function computeAllEntitlements(
  userId: string,
): Promise<CreatorRewardEntitlement[]> {
  const programs = await adminDb.creator_reward_programs.findMany({
    where: { is_active: true },
    orderBy: { created_at: "desc" },
  });
  if (programs.length === 0) return [];

  const results = await Promise.all(
    programs.map((p) => computeEntitlement(p, userId)),
  );
  // Only surface programs the user is actually attached to — a user who has
  // never wagered under a creator's code shouldn't see that creator's program
  // listed at all, let alone as "$0 available".
  return results.filter((e) => e.qualifyingWagerUsd > 0);
}
