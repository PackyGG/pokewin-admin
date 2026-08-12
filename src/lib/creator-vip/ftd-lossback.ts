import { pgArrayParam } from "@/lib/drizzle-array-param";
import "server-only";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { creator_reward_claims } from "@/lib/db-schema/admin/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { postgresTimestamp } from "@/lib/postgres-runtime";
import {
  FTD_MAX_ACCOUNT_AGE_DAYS,
  isFtdAccountAgeEligible,
} from "./ftd-account-age";

import {
  BASIS_HOLDING_STATUSES,
  type ProgramForCompute,
} from "./types";

/**
 * First-time-deposit lossback: a one-off "% back on what you lost from your
 * FIRST deposit" for players who signed up under a creator's code.
 *
 * ── THE RULES, AND WHY ────────────────────────────────────────────────────
 *
 *  1. SIGNED UP under one of the program's codes. Not merely "used the code
 *     later" — this reward exists to pay for acquisition, so it keys off the
 *     `signup` attribution row, which the backend writes once per referral.
 *
 *  2. FIRST deposit only, and it must clear `min_deposit_usd`. There is
 *     exactly one first deposit, so a player whose first was below the floor
 *     is permanently ineligible — they cannot "retry" with a bigger one.
 *
 *  3. The FIRST deposit must land while the account is no more than four
 *     weeks old. Eligibility is frozen at deposit time, so review delays do
 *     not age an otherwise valid player out of the reward.
 *
 *  4. A SECOND DEPOSIT CLOSES THE WINDOW. This is the judgement call in the
 *     spec. Once fresh money is on the account there is no honest way to say
 *     which deposit a later loss came from, and the alternative — keep paying
 *     against the first deposit forever — is exactly the "deposit $50, don't
 *     lose, deposit $1000, lose it all, get paid" case the owner ruled out.
 *     So eligibility ends when deposit #2 lands.
 *
 *     TRADE-OFF, stated plainly: a player who genuinely loses their first
 *     deposit and then re-deposits BEFORE claiming loses the reward. The bot
 *     surfaces it as claimable the moment they are down, so the window is
 *     real, but it is not unlimited. Freezing the figure at deposit #2 instead
 *     would need the inventory value as it stood at that instant, which is not
 *     reconstructable from the ledger — and guessing it would overpay.
 *
 *  5. ONCE, EVER. Enforced by the same claim rows every other reward uses.
 *
 * ── HOW "LOST" IS MEASURED ────────────────────────────────────────────────
 *     lost = firstDeposit − whatTheyStillHold      (clamped to [0, deposit])
 *
 * `whatTheyStillHold` is cash AND card value — available + locked balance,
 * plus inventory, plus unredeemed vouchers — mirroring the house P&L identity
 * used everywhere else in this codebase. Counting cash alone would call a
 * player who spent their whole deposit on packs "fully lost" while they sit on
 * the cards, and pay out on a loss that hasn't happened.
 *
 * All reads are per-user and read-only against prod.
 */

/** Money in whole cents — all arithmetic is integer to avoid float drift. */
const toCents = (usd: number): number => Math.round(usd * 100);
const fromCents = (cents: number): number => cents / 100;

export type FtdLossbackState = {
  /** The qualifying first deposit, or null if they've never deposited. */
  firstDepositUsd: number | null;
  firstDepositAt: string | null;
  /** True once a second deposit has landed — the window is then closed. */
  hasSecondDeposit: boolean;
  /** Everything they still hold: balance + locked + inventory + vouchers. */
  holdingsUsd: number;
  /** firstDeposit − holdings, clamped to [0, firstDeposit]. */
  lostUsd: number;
  /** pct × lost, after any cap. */
  payoutUsd: number;
  blockedReason: string | null;
};

const EMPTY: FtdLossbackState = {
  firstDepositUsd: null,
  firstDepositAt: null,
  hasSecondDeposit: false,
  holdingsUsd: 0,
  lostUsd: 0,
  payoutUsd: 0,
  blockedReason: null,
};

/**
 * Did this player SIGN UP under one of the program's codes?
 *
 * Case-insensitive because `affiliate_codes` casing is mixed for legacy rows
 * and `affiliate_code_usages` mirrors whatever the caller resolved.
 */
async function signedUpUnderCode(
  userId: string,
  codes: readonly string[],
): Promise<boolean> {
  if (codes.length === 0) return false;
  const upper = codes.map((c) => c.toUpperCase());
  const result = await getProdReadDrizzleDb().execute<{ hit: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM affiliate_code_usages
       WHERE referred_user_id = ${userId}
         AND usage_type::text = 'signup'
         AND UPPER(code) = ANY(${pgArrayParam(upper)}::text[])
    ) AS hit
  `);
  return result.rows[0]?.hit === true;
}

/**
 * The same question for MANY programs at once: which of these codes did the
 * player sign up under?
 *
 * Returned as the set of matching UPPERCASE codes rather than a per-program
 * boolean, so the caller answers each program by testing its own codes against
 * it — `codes.some(...)` is exactly the EXISTS above, evaluated in memory.
 *
 * Same predicate, same `idx_acu_upper_code` path, and signup rows are one per
 * referral so the set is tiny. The EXISTS short-circuit in
 * `computeAllEntitlements` is deliberately left alone: it must stay a
 * first-row-and-stop probe for the common "not attached to anything" case.
 */
export async function signedUpCodes(
  userId: string,
  codes: readonly string[],
): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  const upper = codes.map((c) => c.toUpperCase());
  const result = await getProdReadDrizzleDb().execute<{ code: string }>(sql`
    SELECT DISTINCT UPPER(code) AS code
      FROM affiliate_code_usages
     WHERE referred_user_id = ${userId}
       AND usage_type::text = 'signup'
       AND UPPER(code) = ANY(${pgArrayParam(upper)}::text[])
  `);
  return new Set(result.rows.map((row) => row.code));
}

/**
 * Lossback claims already held, per program, in one GROUP BY. A program with
 * none produces no row and keeps the seeded 0 — the same answer the
 * per-program COUNT gives.
 */
export async function batchLossbackHeldClaims(
  programIds: string[],
  userId: string,
): Promise<Map<string, number>> {
  const out = new Map(programIds.map((id) => [id, 0]));
  if (programIds.length === 0) return out;

  const rows = await adminDrizzle
    .select({
      program_id: creator_reward_claims.program_id,
      value: count(),
    })
    .from(creator_reward_claims)
    .where(
      and(
        inArray(creator_reward_claims.program_id, programIds),
        eq(creator_reward_claims.user_id, userId),
        eq(creator_reward_claims.leg, "ftd_lossback"),
        inArray(creator_reward_claims.status, [...BASIS_HOLDING_STATUSES]),
      ),
    )
    .groupBy(creator_reward_claims.program_id);

  for (const row of rows) out.set(row.program_id, row.value);
  return out;
}

/**
 * The player's first two completed deposits, oldest first.
 *
 * ── WHY `type = 'deposit'::ledger_transaction_type` AND NOT `type::text` ──
 * This codebase compares enum columns as `::text` by convention, to survive
 * prod enums that lag the generated client (a bare comparison against an
 * unknown label throws 22P02 at parse time). That hardening is right for
 * `affiliate_code_usages.usage_type`, where `signup` genuinely was missing on
 * prod for a while.
 *
 * It is WRONG here, and expensively so: casting the indexed column makes it
 * non-sargable, so Postgres cannot match ANY index on `type` and falls back to
 * fetching every ledger row for that user and top-N sorting them. Measured on
 * prod 2026-07-23, same row, same user:
 *
 *   type::text = 'deposit'   6.092 ms   2564 buffers   no index   + sort
 *   type = 'deposit'::enum   0.087 ms      8 buffers   index scan, no sort
 *
 * `deposit` is a core member of `ledger_transaction_type` and has always
 * existed, so there is no drift to defend against — only 70x to lose. The
 * explicit `::ledger_transaction_type` cast keeps the comparison typed rather
 * than relying on literal inference.
 *
 * Served by `idx_ledger_user_deposit_created` (user_id, created_at) WHERE
 * type='deposit' AND status='completed' — applied to prod 2026-07-23.
 *
 * Also hoisted: `loadUserFacts` runs this ONCE per player per request, not
 * once per program.
 */
export async function firstDeposits(
  userId: string,
): Promise<{ amountUsd: number; at: Date }[]> {
  const result = await getProdReadDrizzleDb().execute<{
    amount: string;
    created_at: Date | string;
  }>(sql`
    SELECT amount::text, created_at
      FROM ledger_transactions
     WHERE user_id = ${userId}
       AND type = 'deposit'::ledger_transaction_type
       AND status = 'completed'
     ORDER BY created_at ASC
     LIMIT 2
  `);
  return result.rows.map((r) => ({
    amountUsd: Math.abs(toNumber(r.amount)),
    at: postgresTimestamp(r.created_at, "firstDeposits.created_at"),
  }));
}

/**
 * Everything the player still holds — cash AND card value.
 *
 * These three sums ARE the "what the house still owes this user" side of the
 * canonical P&L identity (`src/lib/queries/pnl.ts`: onSiteBalance +
 * inventoryValue + unclaimedVouchers). They are computed directly here rather
 * than by calling `calculateUserPnl`, deliberately:
 *
 * that helper is a dashboard query. Importing it pulls the analytics read
 * resolution, Edge Config feature flags, the excluded-users cache and the
 * daily-P&L comparison harness into what is otherwise a three-index-probe
 * Discord endpoint — an enormous dependency graph for one number, and every
 * one of those is a way for a bot command to fail for reasons that have
 * nothing to do with the bot.
 *
 * The column semantics are the fiddly part and are mirrored exactly (verified
 * against prod 2026-07-23, all three index-served, 0.16–0.20 ms):
 *   • open inventory = neither sold, nor exchanged, nor locked for an
 *     in-flight withdrawal — and valued at `value_at_obtained` (there is no
 *     `value` column on user_inventory)
 *   • outstanding vouchers gate on `claimed_at IS NULL` (not `redeemed_at`)
 *   • on-site balance is available + locked
 *
 * If the canonical definition in pnl.ts ever changes, this must follow.
 */
export async function holdingsUsd(userId: string): Promise<number> {
  // ONE round-trip, not three. Each leg is a sub-select rather than a separate
  // query: they are independent, all index-served, and on this path network
  // latency dwarfs execution time — three 20 ms trips cost 60 ms to compute a
  // number that takes under a millisecond.
  const result = await getProdReadDrizzleDb().execute<{ total: string }>(sql`
    SELECT (
      COALESCE((
        SELECT available_balance::numeric + locked_balance::numeric
          FROM balances WHERE user_id = ${userId}
      ), 0)
      + COALESCE((
        SELECT SUM(value_at_obtained::numeric) FROM user_inventory
         WHERE user_id = ${userId}
           AND sold_at IS NULL
           AND exchanged_at IS NULL
           AND withdrawal_locked_at IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(value::numeric) FROM vouchers
         WHERE user_id = ${userId} AND claimed_at IS NULL
      ), 0)
    )::text AS total
  `);
  return toNumber(result.rows[0]?.total ?? 0);
}

/**
 * Compute the FTD-lossback position for one player on one program.
 *
 * Returns a fully-populated state even when nothing is payable, so the bot can
 * explain WHY ("your first deposit was below $50") instead of silently showing
 * nothing.
 */
export async function computeFtdLossback(
  program: ProgramForCompute & {
    lossback_pct: unknown;
    min_deposit_usd: unknown;
  },
  userId: string,
  /** Account creation is immutable; the first deposit must land by day 28. */
  accountCreatedAt: Date,
  /**
   * Per-user facts already loaded by the caller. Passing them is what stops
   * a player with N programs paying for N deposit lookups and N P&L reads —
   * neither depends on the program. Omit and they are loaded here.
   */
  facts?: { deposits: { amountUsd: number; at: Date }[]; holdingsUsd: number },
  /** Live intervals — the deposit must fall inside one of them. */
  windows?: { started_at: Date; ended_at: Date | null }[],
  /**
   * Program-scoped reads already resolved for a whole sweep. Presence of this
   * program's id (or a non-null code set) means "already read"; anything
   * missing falls through to the per-program read below.
   */
  batch?: {
    lossbackHeldClaims: Map<string, number>;
    signupCodes: Set<string> | null;
  },
): Promise<FtdLossbackState> {
  const pct = program.lossback_pct == null ? 0 : toNumber(program.lossback_pct);
  const minDeposit =
    program.min_deposit_usd == null ? 0 : toNumber(program.min_deposit_usd);

  if (pct <= 0) {
    return { ...EMPTY, blockedReason: "This program is misconfigured." };
  }

  // Already taken. One claim ever — pending counts, so a queued request can't
  // be duplicated while it waits.
  //
  // SCOPED TO THIS LEG. A program can also run wager milestones, and those
  // share this table: without the `leg` filter a single pending wager claim
  // would report the lossback as "already claimed" and silently withhold it.
  const batchedExisting = batch?.lossbackHeldClaims.get(program.id);
  let existing = batchedExisting;
  if (existing === undefined) {
    const existingRows = await adminDrizzle
      .select({ value: count() })
      .from(creator_reward_claims)
      .where(
        and(
          eq(creator_reward_claims.program_id, program.id),
          eq(creator_reward_claims.user_id, userId),
          eq(creator_reward_claims.leg, "ftd_lossback"),
          inArray(creator_reward_claims.status, [...BASIS_HOLDING_STATUSES]),
        ),
      );
    existing = existingRows[0]?.value ?? 0;
  }
  if (existing > 0) {
    return { ...EMPTY, blockedReason: "Already claimed." };
  }

  const batchedSignupCodes = batch?.signupCodes;
  const [signedUp, deposits] = await Promise.all([
    // Program-specific — batched across programs as a code SET when the caller
    // supplies one, since membership is the same test the EXISTS performs.
    batchedSignupCodes
      ? program.codes.some((c) => batchedSignupCodes.has(c.toUpperCase()))
      : signedUpUnderCode(userId, program.codes),
    facts?.deposits ?? firstDeposits(userId),
  ]);

  if (!signedUp) {
    return {
      ...EMPTY,
      blockedReason: "This player didn't sign up under the creator's code.",
    };
  }

  const first = deposits[0];
  if (!first) {
    return { ...EMPTY, blockedReason: "No deposit yet." };
  }

  // The first deposit must land while the program was actually LIVE — not
  // merely after it was created. A deposit made while the program was
  // paused earns nothing, same as wager placed during a pause.
  const live = windows ?? [
    { started_at: program.accrual_start_at, ended_at: null },
  ];
  const insideLiveWindow = live.some(
    (w) => first.at >= w.started_at && (w.ended_at == null || first.at < w.ended_at),
  );
  if (!insideLiveWindow) {
    return {
      ...EMPTY,
      firstDepositUsd: first.amountUsd,
      firstDepositAt: first.at.toISOString(),
      blockedReason:
        first.at < program.accrual_start_at
          ? "Their first deposit predates this program."
          : "Their first deposit landed while this program was paused.",
    };
  }

  if (first.amountUsd < minDeposit) {
    return {
      ...EMPTY,
      firstDepositUsd: first.amountUsd,
      firstDepositAt: first.at.toISOString(),
      blockedReason: `First deposit was $${first.amountUsd.toFixed(2)} — below the $${minDeposit.toFixed(2)} minimum.`,
    };
  }

  if (!isFtdAccountAgeEligible(accountCreatedAt, first.at)) {
    return {
      ...EMPTY,
      firstDepositUsd: first.amountUsd,
      firstDepositAt: first.at.toISOString(),
      blockedReason: `Account was older than ${FTD_MAX_ACCOUNT_AGE_DAYS} days when the first deposit landed.`,
    };
  }

  if (deposits.length > 1) {
    return {
      ...EMPTY,
      firstDepositUsd: first.amountUsd,
      firstDepositAt: first.at.toISOString(),
      hasSecondDeposit: true,
      blockedReason:
        "They've deposited again — losses can no longer be tied to the first deposit.",
    };
  }

  const holdings = facts?.holdingsUsd ?? (await holdingsUsd(userId));
  const depositCents = toCents(first.amountUsd);
  const lostCents = Math.min(
    depositCents,
    Math.max(0, depositCents - toCents(holdings)),
  );

  // Percent applied in cents, then rounded once — never a float chain.
  const payoutCents = Math.round((lostCents * pct) / 100);

  return {
    firstDepositUsd: first.amountUsd,
    firstDepositAt: first.at.toISOString(),
    hasSecondDeposit: false,
    holdingsUsd: holdings,
    lostUsd: fromCents(lostCents),
    payoutUsd: fromCents(payoutCents),
    blockedReason:
      lostCents === 0 ? "They haven't lost any of their first deposit yet." : null,
  };
}
