import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getProdDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

import {
  BASIS_HOLDING_STATUSES,
  type CreatorRewardEntitlement,
} from "./types";
import { computeFtdLossback } from "./ftd-lossback";

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
  /** "wager" | "ftd_lossback" — decides which branch below runs. */
  type: string;
  creator_user_id: string;
  codes: string[];
  threshold_usd: unknown;
  reward_usd: unknown;
  vip_reward_usd: unknown;
  lossback_pct: unknown;
  min_deposit_usd: unknown;
  is_active: boolean;
  accrual_start_at: Date;
  max_reward_per_user_usd: unknown;
};

/**
 * Does this player hold the `vip` tag RIGHT NOW?
 *
 * Deliberately a live read on every eligibility check, never cached and never
 * copied onto the claim as a source of truth. VIP is an `admin_user_tags` row
 * that staff can remove at any moment; a cached flag would keep paying the
 * uplift to someone who has already lost it. The lookup is a point read on
 * the (target_user_id, tag) unique pair.
 */
async function isVipNow(userId: string): Promise<boolean> {
  const row = await adminDb.admin_user_tags.findFirst({
    where: { target_user_id: userId, tag: "vip" },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Account standing + the code the player is CURRENTLY on, re-read live on
 * every check.
 *
 * Two independent guards, one read:
 *
 *  • Banned / locked players must not be able to file claims. The bot is a
 *    side door into a payout, and it would be absurd for someone banned on
 *    the site to keep earning through Discord.
 *
 *  • `currentCode` is whatever code is SET on the player right now — read
 *    straight off the column, with NO expiry test.
 *
 * ── EXPIRING IS FINE. SWITCHING IS NOT. ───────────────────────────────────
 * These are very different events and only one of them is the player's doing:
 *
 *   EXPIRED  — the 7-day attribution simply lapsed. The code is still the one
 *              they chose; they did nothing. Wager stops booking until they
 *              re-enter it, but everything already earned stays claimable.
 *
 *   SWITCHED — they deliberately moved to a different creator's code. That is
 *              a choice to leave, and it forfeits the right to keep cashing
 *              in wager built up here.
 *
 * So the gate is "is the code still THEIRS", not "is the code still live" —
 * which is why `affiliate_code_expires_at` is deliberately NOT consulted here
 * (`/discord/info` still reports the remaining time, for the player's sake).
 * A NULL code is treated as not-a-switch: an admin clearing someone's code,
 * or a lapse that nulled it, should never silently confiscate earned rewards.
 *
 * Checked HERE rather than at the API boundary so the admin preview and the
 * bot agree, and so a future caller can't accidentally skip it.
 *
 * Returns null when the user row is missing entirely, which is itself a
 * refusal: an id that resolves to nothing is not a real claimant.
 */
async function userStanding(userId: string): Promise<{
  banned: boolean;
  locked: boolean;
  currentCode: string | null;
  codeExpiresAt: Date | null;
} | null> {
  const row = await getProdDb().user.findUnique({
    where: { id: userId },
    select: {
      is_banned: true,
      is_locked: true,
      affiliate_code: true,
      affiliate_code_expires_at: true,
    },
  });
  if (!row) return null;

  return {
    banned: row.is_banned,
    locked: row.is_locked,
    currentCode: row.affiliate_code ? row.affiliate_code.toUpperCase() : null,
    codeExpiresAt: row.affiliate_code_expires_at,
  };
}

/**
 * When did this user's CURRENT run on the program's codes begin?
 *
 * Progress RESETS when a player leaves for another creator's code. The reset
 * point is the last moment we have evidence they were attached elsewhere —
 * i.e. the newest `affiliate_code_usages` row (of ANY kind: signup, deposit or
 * wager) whose code is not one of this program's. Wager booked before that
 * moment belongs to a previous run and no longer counts.
 *
 * Bounded to `accrualStart` on both ends: a switch that happened before the
 * program existed is irrelevant, and the run can never start earlier than the
 * program itself.
 *
 * KNOWN LIMIT: a player who switches codes and then generates NO activity at
 * all under the new one leaves no trace in `affiliate_code_usages`, so there
 * is nothing to detect and their run continues. Attribution is only ever
 * recorded when something actually happens, so this is a floor on what the
 * data can support, not a gap in the rule.
 */
async function runStartedAt(
  userId: string,
  codes: readonly string[],
  accrualStart: Date,
): Promise<Date> {
  const db = getProdDb();
  const upper = codes.map((c) => c.toUpperCase());

  const rows = await db.$queryRaw<{ boundary: Date | null }[]>`
    SELECT MAX(created_at) AS boundary
      FROM affiliate_code_usages
     WHERE referred_user_id = ${userId}
       AND UPPER(code) <> ALL(${upper}::text[])
       AND created_at >= ${accrualStart}
  `;
  const boundary = rows[0]?.boundary ?? null;
  return boundary && boundary > accrualStart ? boundary : accrualStart;
}

/**
 * Σ wager this user booked under `codes` between `since` and now.
 *
 * Codes are matched case-insensitively: `affiliate_codes` casing is MIXED for
 * rows the 0068 migration backfilled, and `affiliate_code_usages` mirrors
 * whatever casing the caller resolved — so an exact match would silently miss
 * a legacy creator's entire history.
 */
async function wagerUsdSince(
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
  runStart: Date,
): Promise<{ consumedUsd: number; approvedRewardUsd: number }> {
  const [held, approved] = await Promise.all([
    adminDb.creator_reward_claims.aggregate({
      where: {
        program_id: programId,
        user_id: userId,
        status: { in: [...BASIS_HOLDING_STATUSES] },
        // Consumption is scoped to the CURRENT run for the same reason the
        // wager is: when a player leaves and comes back they start clean, so
        // basis they burned on a previous run must not eat into the new one.
        // Without this the reset would be one-sided — wager cleared, debt
        // kept — and a returning player could never claim again.
        requested_at: { gte: runStart },
      },
      _sum: { consumed_wager_usd: true },
    }),
    // The per-user reward CAP is deliberately NOT run-scoped — it is a
    // lifetime ceiling on what one player can extract from the program, so
    // switching away and back must not reset it.
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
  const standardRewardCents = toCents(toNumber(program.reward_usd));
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
    type: "wager",
    ftd: null,
    isVip: false,
    appliedRewardUsd: fromCents(standardRewardCents),
    qualifyingWagerUsd: 0,
    lifetimeWagerUsd: 0,
    forfeitedWagerUsd: 0,
    runStartedAt: program.accrual_start_at.toISOString(),
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

  // FTD lossback is a completely different shape of reward — one-off, keyed on
  // the first deposit rather than accumulated wager — so it branches out here
  // before any of the wager machinery below runs. It is normalised into the
  // same entitlement type so every caller (bot /check, /info, the claim path,
  // the admin preview) keeps ONE code path.
  if (program.type === "ftd_lossback") {
    const ftd = await computeFtdLossback(program, userId);
    return {
      ...empty,
      type: "ftd_lossback",
      ftd,
      // A lossback is all-or-nothing: one "unit", or none.
      units: ftd.payoutUsd > 0 ? 1 : 0,
      amountUsd: ftd.payoutUsd,
      appliedRewardUsd: ftd.payoutUsd,
      blockedReason: ftd.blockedReason,
    };
  }

  if (thresholdCents <= 0 || standardRewardCents <= 0) {
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

  const standing = await userStanding(userId);
  if (!standing) {
    return { ...empty, blockedReason: "No such player." };
  }
  if (standing.banned) {
    return { ...empty, blockedReason: "This account is banned." };
  }
  if (standing.locked) {
    return { ...empty, blockedReason: "This account is locked." };
  }

  // Blocked ONLY on a deliberate switch to a different creator's code. An
  // expired (or cleared) code is not a switch — the player didn't choose to
  // leave, so what they already earned stays claimable. See `userStanding`.
  const upperCodes = program.codes.map((c) => c.toUpperCase());
  if (standing.currentCode && !upperCodes.includes(standing.currentCode)) {
    return {
      ...empty,
      blockedReason: `Switched to another creator's code (${standing.currentCode}) — rewards earned here can no longer be claimed.`,
    };
  }

  // The current run's start gates everything below it, so it is resolved
  // first; the lifetime figure alongside it is audit-only (never spendable) —
  // it is what makes a reset visible instead of silent.
  const runStart = await runStartedAt(
    userId,
    program.codes,
    program.accrual_start_at,
  );

  const [wagerUsd, lifetimeWagerUsd, prior, vip] = await Promise.all([
    wagerUsdSince(userId, program.codes, runStart),
    wagerUsdSince(userId, program.codes, program.accrual_start_at),
    priorHoldings(program.id, userId, runStart),
    isVipNow(userId),
  ]);

  // The rate is decided HERE, live, from the tag as it stands this instant —
  // so losing VIP drops the player back to the standard rate on their very
  // next check, with no migration or cleanup.
  const vipRewardCents =
    program.vip_reward_usd == null
      ? null
      : toCents(toNumber(program.vip_reward_usd));
  const rewardCents =
    vip && vipRewardCents != null && vipRewardCents > 0
      ? vipRewardCents
      : standardRewardCents;

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

  // Wager booked under these codes on PREVIOUS runs — cleared by a switch and
  // no longer spendable. Kept purely so the reset is auditable: an operator
  // can see "$600 was forfeited when they moved to another code" rather than
  // watching a balance quietly disappear.
  const lifetimeCents = toCents(lifetimeWagerUsd);
  const forfeitedCents = Math.max(0, lifetimeCents - wagerCents);

  return {
    ...base,
    type: "wager",
    ftd: null,
    isVip: vip,
    appliedRewardUsd: fromCents(rewardCents),
    qualifyingWagerUsd: fromCents(wagerCents),
    lifetimeWagerUsd: fromCents(lifetimeCents),
    forfeitedWagerUsd: fromCents(forfeitedCents),
    runStartedAt: runStart.toISOString(),
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
  // Only surface programs the player is actually attached to. For a WAGER
  // program that means they've wagered something under the code; for an FTD
  // lossback there is no wager basis at all, so the test is whether they have
  // a qualifying first deposit. Filtering lossbacks on wager would have hidden
  // every one of them.
  return results.filter((e) =>
    e.type === "ftd_lossback"
      ? e.ftd?.firstDepositUsd != null
      : e.qualifyingWagerUsd > 0,
  );
}
