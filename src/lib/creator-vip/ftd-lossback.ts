import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getProdDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

import { BASIS_HOLDING_STATUSES } from "./types";
import type { ProgramForCompute } from "./compute";

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
 *  3. A SECOND DEPOSIT CLOSES THE WINDOW. This is the judgement call in the
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
 *  4. ONCE, EVER. Enforced by the same claim rows every other reward uses.
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
  const rows = await getProdDb().$queryRaw<{ hit: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM affiliate_code_usages
       WHERE referred_user_id = ${userId}
         AND usage_type::text = 'signup'
         AND UPPER(code) = ANY(${upper}::text[])
    ) AS hit
  `;
  return rows[0]?.hit === true;
}

/**
 * The player's first two completed deposits, oldest first.
 *
 * The most expensive read on this path: `ledger_transactions` is 1.27M rows
 * / 675 MB, and while the user_id index is used, Postgres still has to fetch
 * every ledger row for that user and top-N sort them (measured 7.96 ms, 724
 * pages read, against prod 2026-07-23). A partial index on
 * (user_id, created_at) WHERE type='deposit' AND status='completed' turns it
 * into a 2-row index scan — see prisma/recommended-indexes.sql. MAIN is
 * read-only here, so that index is the owner's to apply.
 *
 * Until then the cost is contained by hoisting: `loadUserFacts` runs this
 * ONCE per player per request, not once per program.
 */
export async function firstDeposits(
  userId: string,
): Promise<{ amountUsd: number; at: Date }[]> {
  const rows = await getProdDb().$queryRaw<
    { amount: string; created_at: Date }[]
  >`
    SELECT amount::text, created_at
      FROM ledger_transactions
     WHERE user_id = ${userId}
       AND type::text = 'deposit'
       AND status = 'completed'
     ORDER BY created_at ASC
     LIMIT 2
  `;
  return rows.map((r) => ({
    amountUsd: Math.abs(toNumber(r.amount)),
    at: r.created_at,
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
 * that helper is a DASHBOARD query. Importing it pulls ClickHouse read
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
  const db = getProdDb();

  const [balance, inventory, vouchers] = await Promise.all([
    db.balances
      .findUnique({
        where: { user_id: userId },
        select: { available_balance: true, locked_balance: true },
      })
      .then((b) =>
        b ? toNumber(b.available_balance) + toNumber(b.locked_balance) : 0,
      ),
    db.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(value_at_obtained::numeric), 0)::text AS total
        FROM user_inventory
       WHERE user_id = ${userId}
         AND sold_at IS NULL
         AND exchanged_at IS NULL
         AND withdrawal_locked_at IS NULL
    `.then((rows) => toNumber(rows[0]?.total ?? 0)),
    db.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(value::numeric), 0)::text AS total
        FROM vouchers
       WHERE user_id = ${userId}
         AND claimed_at IS NULL
    `.then((rows) => toNumber(rows[0]?.total ?? 0)),
  ]);

  return balance + inventory + vouchers;
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
  /**
   * Per-user facts already loaded by the caller. Passing them is what stops
   * a player with N programs paying for N deposit lookups and N P&L reads —
   * neither depends on the program. Omit and they are loaded here.
   */
  facts?: { deposits: { amountUsd: number; at: Date }[]; holdingsUsd: number },
  /** Live intervals — the deposit must fall inside one of them. */
  windows?: { started_at: Date; ended_at: Date | null }[],
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
  const existing = await adminDb.creator_reward_claims.count({
    where: {
      program_id: program.id,
      user_id: userId,
      leg: "ftd_lossback",
      status: { in: [...BASIS_HOLDING_STATUSES] },
    },
  });
  if (existing > 0) {
    return { ...EMPTY, blockedReason: "Already claimed." };
  }

  const [signedUp, deposits] = await Promise.all([
    // Program-specific — cannot be hoisted.
    signedUpUnderCode(userId, program.codes),
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
