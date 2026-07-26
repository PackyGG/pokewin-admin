import { pgArrayParam } from "@/lib/drizzle-array-param";
import "server-only";

import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_user_tags,
  creator_reward_claims,
  creator_reward_program_windows,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { user as mainUsers } from "@/lib/db-schema/main/schema";
import { getProdDrizzleDb } from "@/lib/db";
import { postgresTimestamp } from "@/lib/postgres-runtime";
import { toNumber } from "@/lib/utils/decimal";

import {
  BASIS_HOLDING_STATUSES,
  type CreatorRewardEntitlement,
  type CreatorRewardType,
} from "./types";
import {
  computeFtdLossback,
  firstDeposits,
  holdingsUsd,
} from "./ftd-lossback";
import {
  enforceOfferExpiry,
  expiredWagerBasisUsd,
} from "./offer-expiry";

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
 * read-only and uses `getProdDrizzleDb()` so a machine caller
 * can never be served the admin's dev/prod cookie toggle.
 *
 * `usage_type` is compared as `::text` for the same 22P02 hardening every
 * other acu query in this codebase uses — prod's enum has historically lagged
 * the generated client, and a bare comparison against an unknown label throws
 * at parse time instead of simply matching nothing.
 */


/**
 * Render a Date as a NAIVE UTC timestamp string: `YYYY-MM-DD HH:MM:SS.mmm`.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `affiliate_code_usages.created_at` and `ledger_transactions.created_at` are
 * `timestamp WITHOUT time zone`, holding UTC wall-clock values. Binding a JS
 * `Date` against such a column is ambiguous: the driver serialises it with the
 * CLIENT's offset, and Postgres then drops that offset — so the boundary moves
 * by however far the client is from UTC.
 *
 * Observed on a CEST (+02) machine 2026-07-23: a program starting
 * 23:53:14Z was compared as 01:53:14, silently excluding two hours of
 * genuinely-qualifying wager. Production runs UTC so the shift is zero there,
 * which is exactly what makes it dangerous — it is invisible until someone
 * runs the admin, or a script, from another timezone and gets different money.
 *
 * Formatting the parameter as naive UTC makes the comparison naive-vs-naive
 * and identical everywhere. It also keeps the predicate SARGABLE: the cast is
 * on the PARAMETER, never the column — casting the column is what disabled the
 * deposit index earlier today.
 */
function utcNaive(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

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
  vip_reward_usd: unknown;
  lossback_pct: unknown;
  min_deposit_usd: unknown;
  is_active: boolean;
  accrual_start_at: Date;
  max_reward_per_user_usd: unknown;
  /**
   * Live intervals, pre-loaded by the caller when available. Absent means
   * "not fetched" (it is looked up), NOT "never live".
   */
  windows?: { started_at: Date; ended_at: Date | null }[];
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
  const row = (
    await adminDrizzle
      .select({ id: admin_user_tags.id })
      .from(admin_user_tags)
      .where(
        and(
          eq(admin_user_tags.target_user_id, userId),
          eq(admin_user_tags.tag, "vip"),
        ),
      )
      .limit(1)
  )[0];
  return row !== undefined;
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
  const [row] = await getProdDrizzleDb()
    .select({
      is_banned: mainUsers.is_banned,
      is_locked: mainUsers.is_locked,
      affiliate_code: mainUsers.affiliate_code,
      affiliate_code_expires_at: mainUsers.affiliate_code_expires_at,
    })
    .from(mainUsers)
    .where(eq(mainUsers.id, userId))
    .limit(1);
  if (!row) return null;

  return {
    banned: row.is_banned,
    locked: row.is_locked,
    currentCode: row.affiliate_code ? row.affiliate_code.toUpperCase() : null,
    codeExpiresAt: row.affiliate_code_expires_at
      ? new Date(row.affiliate_code_expires_at)
      : null,
  };
}

/**
 * The intervals during which this program was LIVE.
 *
 * Wager only counts while the program is running, so every wager read is
 * bounded by these rather than by a single start date. Without them a pause
 * would be invisible: a program switched off for a week would still pay for
 * everything wagered during that week once it came back.
 *
 * FALLBACK: a program with no rows is treated as live from `accrual_start_at`
 * until now. That is the pre-windows behaviour, and it is the safe direction —
 * a missing row must not silently erase a creator's whole program.
 */
async function programWindows(
  program: ProgramForCompute,
): Promise<{ started_at: Date; ended_at: Date | null }[]> {
  const rows =
    program.windows ??
    (
      await adminDrizzle
        .select({
          started_at: creator_reward_program_windows.started_at,
          ended_at: creator_reward_program_windows.ended_at,
        })
        .from(creator_reward_program_windows)
        .where(eq(creator_reward_program_windows.program_id, program.id))
        .orderBy(asc(creator_reward_program_windows.started_at))
    ).map((row) => ({
      started_at: new Date(row.started_at),
      ended_at: row.ended_at ? new Date(row.ended_at) : null,
    }));
  if (rows.length === 0) {
    return [{ started_at: program.accrual_start_at, ended_at: null }];
  }
  return rows;
}

/**
 * Clamp the live windows to start no earlier than `from`, and drop any that
 * ended before it. Returns the parallel start/end arrays the wager query
 * binds — an open window becomes a far-future date so the SQL needs no NULL
 * handling.
 */
function windowBounds(
  windows: { started_at: Date; ended_at: Date | null }[],
  from: Date,
): { starts: string[]; ends: string[] } {
  const FAR_FUTURE = new Date("9999-12-31T00:00:00.000Z");
  const starts: string[] = [];
  const ends: string[] = [];
  for (const w of windows) {
    const end = w.ended_at ?? FAR_FUTURE;
    if (end <= from) continue;
    // Naive-UTC strings, not Dates — see `utcNaive`.
    starts.push(utcNaive(w.started_at > from ? w.started_at : from));
    ends.push(utcNaive(end));
  }
  return { starts, ends };
}

/**
 * Run start + qualifying wager + lifetime wager, in ONE round-trip.
 *
 * These three were three separate queries, and they are strictly sequential by
 * nature — the wager sums depend on the run boundary. On this path network
 * latency dominates (roughly 20 ms per trip against a sub-millisecond query),
 * so they are folded into a single statement with the boundary as a CTE.
 *
 * ── WHAT EACH PIECE MEANS ─────────────────────────────────────────────────
 * `run_start` — progress RESETS when a player leaves for another creator's
 *   code. The reset point is the newest `affiliate_code_usages` row (of ANY
 *   kind) whose code is not one of this program's. Clamped to the accrual
 *   start on both ends: a switch predating the program is irrelevant, and a
 *   run can never begin before the program did.
 *
 * `current` — spendable wager: inside a live window AND at/after the run
 *   start.
 *
 * `lifetime` — the same live-window bound WITHOUT the run clamp, so
 *   `forfeited = lifetime − current` isolates what code switches cost and
 *   never counts paused time as a loss.
 *
 * Both sums are bounded by the program's live windows, bound as parallel
 * arrays and matched with an EXISTS over `unnest` — any number of
 * pause/resume cycles stays one query, with no string-built OR chain.
 *
 * KNOWN LIMIT: a player who switches codes and then generates NO activity
 * under the new one leaves no trace, so nothing is detectable and their run
 * continues. Attribution only exists where something happened.
 *
 * Codes match case-insensitively — `affiliate_codes` casing is MIXED for rows
 * the 0068 migration backfilled, and acu mirrors whatever the caller resolved.
 */
async function wagerPosition(
  userId: string,
  codes: readonly string[],
  accrualStart: Date,
  windows: { started_at: Date; ended_at: Date | null }[],
): Promise<{ runStart: Date; currentUsd: number; lifetimeUsd: number }> {
  const fallback = {
    runStart: accrualStart,
    currentUsd: 0,
    lifetimeUsd: 0,
  };
  if (codes.length === 0) return fallback;

  const { starts, ends } = windowBounds(windows, accrualStart);
  // Every live stretch ended before the program's accrual start — impossible
  // in practice, but it would make the window predicate match nothing.
  if (starts.length === 0) return fallback;

  const upper = codes.map((c) => c.toUpperCase());
  const since = utcNaive(accrualStart);

  const result = await getProdDrizzleDb().execute<{
    run_start: Date | string;
    current: string;
    lifetime: string;
  }>(sql`
    WITH boundary AS (
      SELECT COALESCE(MAX(created_at), ${since}::timestamp) AS run_start
        FROM affiliate_code_usages
       WHERE referred_user_id = ${userId}
         AND UPPER(code) <> ALL(${pgArrayParam(upper)}::text[])
         AND created_at >= ${since}::timestamp
    ),
    live AS (
      SELECT acu.created_at, acu.wager_amount_usd
        FROM affiliate_code_usages acu
       WHERE acu.referred_user_id = ${userId}
         AND acu.usage_type::text = 'wager'
         AND UPPER(acu.code) = ANY(${pgArrayParam(upper)}::text[])
         AND acu.created_at >= ${since}::timestamp
         AND EXISTS (
           SELECT 1
             FROM unnest(${pgArrayParam(starts)}::timestamp[], ${pgArrayParam(ends)}::timestamp[]) AS w(s, e)
            WHERE acu.created_at >= w.s AND acu.created_at < w.e
         )
    )
    SELECT
      (SELECT run_start FROM boundary) AS run_start,
      COALESCE(SUM(live.wager_amount_usd::numeric) FILTER (
        WHERE live.created_at >= (SELECT run_start FROM boundary)
      ), 0)::text AS current,
      COALESCE(SUM(live.wager_amount_usd::numeric), 0)::text AS lifetime
    FROM live
  `);

  const row = result.rows[0];
  if (!row) return fallback;
  return {
    runStart:
      row.run_start == null
        ? accrualStart
        : postgresTimestamp(row.run_start, "creatorVip.run_start"),
    currentUsd: toNumber(row.current ?? 0),
    lifetimeUsd: toNumber(row.lifetime ?? 0),
  };
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
  // ONE grouped read instead of two aggregates. Consumed basis and approved
  // reward differ only in which rows they count, so they are derived in JS
  // from a single pass rather than costing a second round-trip.
  const rows = await adminDrizzle
    .select({
      status: creator_reward_claims.status,
      consumed: sql<string>`COALESCE(SUM(${creator_reward_claims.consumed_wager_usd}), 0)::text`,
      amount: sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
    })
    .from(creator_reward_claims)
    .where(
      and(
        eq(creator_reward_claims.program_id, programId),
        eq(creator_reward_claims.user_id, userId),
      // WAGER leg only. A lossback claim consumes no wager basis (it writes
      // 0), so today this changes nothing — but leaving the legs mixed here
      // would silently break the moment that stopped being true.
        eq(creator_reward_claims.leg, "wager"),
      ),
    )
    // Consumption is scoped to the CURRENT run for the same reason the wager
    // is: basis burned on a previous run must not eat into the new one, or the
    // reset would be one-sided and a returning player could never claim again.
    // The per-user reward CAP is deliberately NOT run-scoped — it is a
    // lifetime ceiling, so it is summed from every approved row below.
    .groupBy(creator_reward_claims.status);

  let consumedUsd = 0;
  let approvedRewardUsd = 0;
  for (const r of rows) {
    if (r.status === "approved") {
      approvedRewardUsd += toNumber(r.amount);
    }
    if (r.status === "approved" || r.status === "pending") {
      consumedUsd += toNumber(r.consumed);
    }
  }

  // Run-scoping the consumed basis needs a row-level date filter, which a
  // groupBy can't express alongside the lifetime cap sum. Claims per
  // (program, user) are few, so this correction is a cheap targeted read and
  // only runs when there is something to correct.
  if (consumedUsd > 0) {
    const stale = await adminDrizzle
      .select({
        value: sql<string>`COALESCE(SUM(${creator_reward_claims.consumed_wager_usd}), 0)::text`,
      })
      .from(creator_reward_claims)
      .where(
        and(
          eq(creator_reward_claims.program_id, programId),
          eq(creator_reward_claims.user_id, userId),
          eq(creator_reward_claims.leg, "wager"),
          inArray(creator_reward_claims.status, [...BASIS_HOLDING_STATUSES]),
          lt(creator_reward_claims.requested_at, runStart.toISOString()),
        ),
      );
    consumedUsd -= toNumber(stale[0]?.value);
    if (consumedUsd < 0) consumedUsd = 0;
  }

  consumedUsd += await expiredWagerBasisUsd(programId, userId, runStart);
  return { consumedUsd, approvedRewardUsd };
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
  facts?: UserFacts,
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

  if (thresholdCents <= 0 || standardRewardCents <= 0) {
    return { ...empty, blockedReason: "The wager leg isn't configured." };
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

  const standing = facts?.standing ?? (await userStanding(userId));
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

  const windows = await programWindows(program);

  // Run start and both wager totals arrive together — see `wagerPosition`.
  const position = await wagerPosition(
    userId,
    program.codes,
    program.accrual_start_at,
    windows,
  );
  const runStart = position.runStart;
  const wagerUsd = position.currentUsd;
  const lifetimeWagerUsd = position.lifetimeUsd;

  const [prior, vip] = await Promise.all([
    priorHoldings(program.id, userId, runStart),
    facts?.isVip ?? isVipNow(userId),
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

  return enforceOfferExpiry({
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
  }, userId);
}



/**
 * Per-user facts that do NOT vary by program.
 *
 * A player can have several programs, each offering two legs, and a naive
 * fan-out re-reads all of this for every one of them — including the two
 * expensive ones (the deposit lookup, and the whole P&L aggregate behind
 * holdings). Loading them ONCE per request and threading them down turns an
 * O(programs × legs) read pattern into O(1) for these, leaving only the
 * genuinely program-scoped reads (wager sums, run start, prior claims,
 * signup-under-code) in the loop.
 */
export type UserFacts = {
  standing: Awaited<ReturnType<typeof userStanding>>;
  isVip: boolean;
  holdingsUsd: number;
  deposits: { amountUsd: number; at: Date }[];
};

export async function loadUserFacts(userId: string): Promise<UserFacts> {
  const [standing, vip, holdings, deposits] = await Promise.all([
    userStanding(userId),
    isVipNow(userId),
    holdingsUsd(userId),
    firstDeposits(userId),
  ]);
  return { standing, isVip: vip, holdingsUsd: holdings, deposits };
}

/**
 * The LOSSBACK leg of a program, normalised into the same entitlement shape as
 * the wager leg so every caller (bot `/check`, `/info`, the claim path, the
 * admin preview) keeps ONE code path.
 *
 * Kept separate from `computeEntitlement` because a program can run BOTH legs
 * and a player earns them independently — a single function returning one
 * answer per program could not express that.
 */
export async function computeLossbackEntitlement(
  program: ProgramForCompute,
  userId: string,
  facts?: UserFacts,
): Promise<CreatorRewardEntitlement> {
  const base = {
    programId: program.id,
    programName: program.name,
    creatorUserId: program.creator_user_id,
  };
  const empty: CreatorRewardEntitlement = {
    ...base,
    type: "ftd_lossback",
    ftd: null,
    isVip: false,
    appliedRewardUsd: 0,
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
  if (program.lossback_pct == null || program.min_deposit_usd == null) {
    return { ...empty, blockedReason: "The lossback leg isn't configured." };
  }
  if (program.creator_user_id === userId) {
    return {
      ...empty,
      blockedReason: "A creator cannot claim their own program.",
    };
  }

  const standing = facts?.standing ?? (await userStanding(userId));
  if (!standing) return { ...empty, blockedReason: "No such player." };
  if (standing.banned) return { ...empty, blockedReason: "This account is banned." };
  if (standing.locked) return { ...empty, blockedReason: "This account is locked." };

  // Same switch rule as the wager leg: leaving for another creator's code
  // forfeits it, an expired code does not.
  const upperCodes = program.codes.map((c) => c.toUpperCase());
  if (standing.currentCode && !upperCodes.includes(standing.currentCode)) {
    return {
      ...empty,
      blockedReason: `Switched to another creator's code (${standing.currentCode}) — rewards earned here can no longer be claimed.`,
    };
  }

  const ftd = await computeFtdLossback(
    program,
    userId,
    facts,
    await programWindows(program),
  );

  // The per-user cap applies to BOTH legs. It was previously enforced on the
  // wager leg only, so a capped program still paid an uncapped lossback.
  let payout = ftd.payoutUsd;
  let capped = false;
  if (program.max_reward_per_user_usd != null) {
    const approved = await adminDrizzle
      .select({
        value: sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
      })
      .from(creator_reward_claims)
      .where(
        and(
          eq(creator_reward_claims.program_id, program.id),
          eq(creator_reward_claims.user_id, userId),
          eq(creator_reward_claims.status, "approved"),
        ),
      );
    const remainingCents = Math.max(
      0,
      toCents(toNumber(program.max_reward_per_user_usd)) -
        toCents(toNumber(approved[0]?.value)),
    );
    if (toCents(payout) > remainingCents) {
      payout = fromCents(remainingCents);
      capped = true;
    }
  }

  return enforceOfferExpiry({
    ...empty,
    ftd: { ...ftd, payoutUsd: payout },
    units: payout > 0 ? 1 : 0,
    amountUsd: payout,
    appliedRewardUsd: payout,
    cappedByUserLimit: capped,
    blockedReason:
      capped && payout === 0
        ? "This user has reached the program's per-user reward cap."
        : ftd.blockedReason,
  }, userId);
}

/** Is this leg configured on the program at all? */
function legConfigured(
  program: ProgramForCompute,
  leg: CreatorRewardType,
): boolean {
  return leg === "wager"
    ? program.threshold_usd != null && program.reward_usd != null
    : program.lossback_pct != null && program.min_deposit_usd != null;
}

/**
 * Every offer a program makes to one player — one per CONFIGURED leg. A
 * program running both returns two, and the player can claim each separately.
 */
export async function computeProgramOffers(
  program: ProgramForCompute,
  userId: string,
  facts?: UserFacts,
): Promise<CreatorRewardEntitlement[]> {
  const legs: Promise<CreatorRewardEntitlement>[] = [];
  if (legConfigured(program, "wager")) {
    legs.push(computeEntitlement(program, userId, facts));
  }
  if (legConfigured(program, "ftd_lossback")) {
    legs.push(computeLossbackEntitlement(program, userId, facts));
  }
  return Promise.all(legs);
}

/**
 * Every entitlement a user has across the ACTIVE programs they are attached
 * to. Drives both the bot's `/check` and the admin's per-user preview.
 *
 * Programs are fetched once and evaluated concurrently; each evaluation is two
 * index-served reads, so this stays cheap even as the program count grows.
 */
export async function computeAllEntitlements(
  userId: string,
): Promise<CreatorRewardEntitlement[]> {
  const programRows = await adminDrizzle
    .select()
    .from(creator_reward_programs)
    .where(eq(creator_reward_programs.is_active, true))
    // Windows come along for the ride — otherwise every program would
    // trigger its own lookup inside the fan-out.
    .orderBy(desc(creator_reward_programs.created_at));
  if (programRows.length === 0) return [];
  const windowRows = await adminDrizzle
    .select()
    .from(creator_reward_program_windows)
    .where(
      inArray(
        creator_reward_program_windows.program_id,
        programRows.map((program) => program.id),
      ),
    )
    .orderBy(asc(creator_reward_program_windows.started_at));
  const windowsByProgram = new Map<
    string,
    { started_at: Date; ended_at: Date | null }[]
  >();
  for (const window of windowRows) {
    const list = windowsByProgram.get(window.program_id) ?? [];
    list.push({
      started_at: new Date(window.started_at),
      ended_at: window.ended_at ? new Date(window.ended_at) : null,
    });
    windowsByProgram.set(window.program_id, list);
  }
  const programs: ProgramForCompute[] = programRows.map((program) => ({
    ...program,
    codes: program.codes ?? [],
    accrual_start_at: new Date(program.accrual_start_at),
    windows: windowsByProgram.get(program.id) ?? [],
  }));

  // SHORT-CIRCUIT. Both legs require an `affiliate_code_usages` row under one
  // of the program's codes — the wager leg needs wager rows, the lossback leg
  // needs the signup row. A player with none can qualify for neither, so one
  // cheap EXISTS decides it before any of the expensive work happens.
  //
  // This matters because the expensive work is unconditional otherwise:
  // loadUserFacts alone is four reads including the deposit lookup (the most
  // costly query on the path), and each program adds more. For the common
  // case — someone who simply isn't attached to a creator running a program —
  // that is ~8 network round-trips spent to conclude "nothing".
  //
  // Cheap by construction: EXISTS stops at the first matching row, and the
  // predicate is served by `idx_acu_upper_code` (verified index-served
  // against prod).
  const allCodes = [
    ...new Set(programs.flatMap((p) => p.codes.map((c) => c.toUpperCase()))),
  ];
  if (allCodes.length === 0) return [];

  const attached = await getProdDrizzleDb().execute<{ hit: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM affiliate_code_usages
       WHERE referred_user_id = ${userId}
         AND UPPER(code) = ANY(${pgArrayParam(allCodes)}::text[])
    ) AS hit
  `);
  if (attached.rows[0]?.hit !== true) return [];

  // Load the program-independent facts ONCE, then fan out. Without this a
  // player with 4 programs would trigger 4 deposit lookups and 4 holdings
  // reads for answers that are identical every time.
  const facts = await loadUserFacts(userId);
  const results = (
    await Promise.all(
      programs.map((p) => computeProgramOffers(p, userId, facts)),
    )
  ).flat();

  // Programs whose code the player is on RIGHT NOW. Being on the code is
  // attachment on its own — it is what the creator told them to do, and it is
  // what makes the offer theirs to work towards.
  //
  // Without this a program is invisible until its first wager lands, so a
  // player who enters the code and immediately checks (or any player of a
  // program created minutes ago) is told the code runs no rewards at all —
  // which is both wrong and the exact opposite of what the copy is for.
  // `currentCode` is already uppercase; program codes are stored uppercase but
  // are re-normalised here rather than trusted.
  const currentCode = facts.standing?.currentCode ?? null;
  const onCodeProgramIds = new Set(
    currentCode == null
      ? []
      : programs
          .filter((p) => p.codes.some((c) => c.toUpperCase() === currentCode))
          .map((p) => p.id),
  );

  // Otherwise, surface only programs the player has history with. For a WAGER
  // program that means they've wagered something under the code; for an FTD
  // lossback there is no wager basis at all, so the test is whether they have
  // a qualifying first deposit. Filtering lossbacks on wager would have hidden
  // every one of them.
  //
  // Nothing here decides CLAIMABILITY — a surfaced offer with zero units still
  // reports 0 and its own `blockedReason`, and every caller re-checks both.
  return results.filter((e) => {
    if (onCodeProgramIds.has(e.programId)) return true;
    return e.type === "ftd_lossback"
      ? e.ftd?.firstDepositUsd != null
      : e.qualifyingWagerUsd > 0;
  });
}
