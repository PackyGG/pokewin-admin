import { pgArrayParam } from "@/lib/drizzle-array-param";
import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_user_tags,
  creator_reward_claims,
  creator_reward_program_windows,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { user as mainUsers } from "@/lib/db-schema/main/schema";
import { getProdReadDrizzleDb } from "@/lib/db";
import { postgresTimestamp } from "@/lib/postgres-runtime";
import { toNumber } from "@/lib/utils/decimal";

import {
  BASIS_HOLDING_STATUSES,
  type CreatorRewardEntitlement,
  type CreatorRewardType,
  type ProgramForCompute,
} from "./types";
export type { ProgramForCompute } from "./types";
import {
  batchLossbackHeldClaims,
  computeFtdLossback,
  firstDeposits,
  holdingsUsd,
  signedUpCodes,
} from "./ftd-lossback";
import { enforceOfferExpiry, expiredWagerBasisUsd } from "./offer-expiry";

/**
 * The ONE eligibility engine for creator VIP wager rewards.
 *
 * Both the admin review UI and the Discord-bot claim endpoint call THIS —
 * never their own arithmetic. The bot supplies a Discord id and nothing else;
 * the amount it renders and the amount we would pay are the same number by
 * construction, so a tampered bot payload can't inflate a payout.
 *
 * ── THE MODEL ─────────────────────────────────────────────────────────────
 * Qualifying wager is the frozen leaderboard-weighted amount READ from prod
 * and never mutated. "Spending" it is modelled as admin-side CONSUMPTION:
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
 * read-only and uses `getProdReadDrizzleDb()` so a machine caller
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
  const [row] = await getProdReadDrizzleDb()
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
    ).map((row) => {
      const rowEnd = row.ended_at ? new Date(row.ended_at) : null;
      return {
        started_at: new Date(row.started_at),
        ended_at:
          program.ends_at && (!rowEnd || program.ends_at < rowEnd)
            ? program.ends_at
            : rowEnd,
      };
    });
  if (rows.length === 0) {
    return [
      { started_at: program.accrual_start_at, ended_at: program.ends_at },
    ];
  }
  return rows.map((row) => ({
    ...row,
    ended_at:
      program.ends_at && (!row.ended_at || program.ends_at < row.ended_at)
        ? program.ends_at
        : row.ended_at,
  }));
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

export type WagerPosition = {
  runStart: Date;
  currentUsd: number;
  lifetimeUsd: number;
};

type WagerPositionRow = {
  program_id: string;
  run_start: Date | string | null;
  current: string | null;
  lifetime: string | null;
};

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
 *   start, using the leaderboard-weighted amount frozen when the bet landed.
 *
 * `lifetime` — the same live-window bound WITHOUT the run clamp, so
 *   `forfeited = lifetime − current` isolates what code switches cost and
 *   never counts paused time as a loss.
 *
 * Both sums are bounded by the program's live windows, bound as parallel
 * arrays and matched with an EXISTS over `unnest` — any number of
 * pause/resume cycles stays one query, with no string-built OR chain.
 *
 * The amount is the SAME frozen value used by official races and creator
 * leaderboards: packs/battles currently count 1x, while upgrader/Keno count
 * 0.5x. We never read or expose the raw amount here. A missing frozen weight
 * is zero, not 1x: wager weighting predates Creator Rewards, so NULL means a
 * producer failed to freeze the weight and must fail closed rather than
 * silently over-crediting a player. Battle double-down sessions are excluded
 * explicitly: they are not eligible Creator Rewards wager, even if a future
 * producer starts populating a weighted amount for another purpose.
 *
 * KNOWN LIMIT: a player who switches codes and then generates NO activity
 * under the new one leaves no trace, so nothing is detectable and their run
 * continues. Attribution only exists where something happened.
 *
 * Codes match case-insensitively — `affiliate_codes` casing is MIXED for rows
 * the 0068 migration backfilled, and acu mirrors whatever the caller resolved.
 *
 * The live windows arrive already clamped to the program's `ends_at` by
 * `programWindows`, so a scheduled end narrows the accrual bound here exactly
 * as a pause would — this function never reads `ends_at` itself.
 *
 * Written as a fragment, so the single-program read and the
 * batched read are the SAME SQL rather than two hand-kept copies. It carries
 * its own `program_id` label so N of these can be UNION ALL'd into one
 * round-trip and demultiplexed by id on the way back.
 *
 * Returns null for the two cases that have no query at all — no codes, or
 * every live stretch ending before accrual start — which the caller answers
 * with the zero fallback.
 */
function wagerPositionSql(
  programId: string,
  userId: string,
  codes: readonly string[],
  accrualStart: Date,
  windows: { started_at: Date; ended_at: Date | null }[],
): SQL | null {
  if (codes.length === 0) return null;

  const { starts, ends } = windowBounds(windows, accrualStart);
  // Every live stretch ended before the program's accrual start — impossible
  // in practice, but it would make the window predicate match nothing.
  if (starts.length === 0) return null;

  const upper = codes.map((c) => c.toUpperCase());
  const since = utcNaive(accrualStart);

  return sql`
    WITH boundary AS (
      SELECT COALESCE(MAX(created_at), ${since}::timestamp) AS run_start
        FROM affiliate_code_usages
       WHERE referred_user_id = ${userId}
         AND UPPER(code) <> ALL(${pgArrayParam(upper)}::text[])
         AND created_at >= ${since}::timestamp
    ),
    live AS (
      SELECT
        acu.created_at,
        COALESCE(acu.weighted_wager_amount_usd, 0) AS reward_wager_amount_usd
        FROM affiliate_code_usages acu
       WHERE acu.referred_user_id = ${userId}
         AND acu.usage_type::text = 'wager'
         AND UPPER(acu.code) = ANY(${pgArrayParam(upper)}::text[])
         AND acu.created_at >= ${since}::timestamp
         AND NOT EXISTS (
           SELECT 1
             FROM game_sessions gs
            WHERE gs.id = acu.game_session_id
              AND gs.game_type::text = 'battle_double_down'
         )
         AND EXISTS (
           SELECT 1
             FROM unnest(${pgArrayParam(starts)}::timestamp[], ${pgArrayParam(ends)}::timestamp[]) AS w(s, e)
            WHERE acu.created_at >= w.s AND acu.created_at < w.e
         )
    )
    SELECT
      ${programId}::text AS program_id,
      (SELECT run_start FROM boundary) AS run_start,
      COALESCE(SUM(live.reward_wager_amount_usd::numeric) FILTER (
        WHERE live.created_at >= (SELECT run_start FROM boundary)
      ), 0)::text AS current,
      COALESCE(SUM(live.reward_wager_amount_usd::numeric), 0)::text AS lifetime
    FROM live
  `;
}

function parseWagerPosition(
  row: WagerPositionRow | undefined,
  accrualStart: Date,
): WagerPosition {
  if (!row) return { runStart: accrualStart, currentUsd: 0, lifetimeUsd: 0 };
  return {
    runStart:
      row.run_start == null
        ? accrualStart
        : postgresTimestamp(row.run_start, "creatorVip.run_start"),
    currentUsd: toNumber(row.current ?? 0),
    lifetimeUsd: toNumber(row.lifetime ?? 0),
  };
}

async function wagerPosition(
  programId: string,
  userId: string,
  codes: readonly string[],
  accrualStart: Date,
  windows: { started_at: Date; ended_at: Date | null }[],
): Promise<WagerPosition> {
  const statement = wagerPositionSql(
    programId,
    userId,
    codes,
    accrualStart,
    windows,
  );
  if (!statement) {
    return { runStart: accrualStart, currentUsd: 0, lifetimeUsd: 0 };
  }
  const result =
    await getProdReadDrizzleDb().execute<WagerPositionRow>(statement);
  return parseWagerPosition(result.rows[0], accrualStart);
}

/**
 * Every program's wager position for one player, in ONE prod round-trip.
 *
 * The per-program statement is unchanged — it is literally the same fragment,
 * UNION ALL'd. Each branch is independent and self-bounded, so the planner
 * still resolves each one through `idx_acu_upper_code` ∧
 * `idx_acu_referred_user_created_at`; nothing is joined across branches.
 *
 * Chunked because the parameter count grows with programs × (codes + windows),
 * and a statement wide enough to matter is also one the planner spends real
 * time on. Programs with no codes / no live stretch produce no branch and keep
 * the zero fallback, exactly as the single-program path does.
 */
const WAGER_POSITION_CHUNK = 20;

async function batchWagerPositions(
  userId: string,
  programs: ProgramForCompute[],
): Promise<Map<string, WagerPosition>> {
  const out = new Map<string, WagerPosition>();
  const branches: { programId: string; statement: SQL }[] = [];

  // Same resolution the single-program path uses — including the "no rows means
  // live since accrual start" fallback, which is a different thing from an
  // empty window list and would otherwise zero out every program silently.
  const resolved = await Promise.all(
    programs.map(async (program) => ({
      program,
      windows: await programWindows(program),
    })),
  );

  for (const { program, windows } of resolved) {
    // Seeded with the fallback first: presence in this map is what tells the
    // per-program path "already batched, do not re-read", so every covered
    // program must have an entry even when it has no query.
    out.set(program.id, {
      runStart: program.accrual_start_at,
      currentUsd: 0,
      lifetimeUsd: 0,
    });
    const statement = wagerPositionSql(
      program.id,
      userId,
      program.codes,
      program.accrual_start_at,
      windows,
    );
    if (statement) branches.push({ programId: program.id, statement });
  }
  if (branches.length === 0) return out;

  const accrualById = new Map(
    programs.map((program) => [program.id, program.accrual_start_at]),
  );

  for (let i = 0; i < branches.length; i += WAGER_POSITION_CHUNK) {
    const chunk = branches.slice(i, i + WAGER_POSITION_CHUNK);
    const statement =
      chunk.length === 1
        ? chunk[0].statement
        : sql.join(
            chunk.map((branch) => sql`(${branch.statement})`),
            sql` UNION ALL `,
          );
    const result =
      await getProdReadDrizzleDb().execute<WagerPositionRow>(statement);
    for (const row of result.rows) {
      const accrual = accrualById.get(row.program_id);
      if (!accrual) continue;
      out.set(row.program_id, parseWagerPosition(row, accrual));
    }
  }
  return out;
}

/**
 * Reward already HELD against the program's per-user cap, in whole cents.
 *
 * ── ONE CEILING, BOTH LEGS ────────────────────────────────────────────────
 * `max_reward_per_user_usd` is a "lifetime cap per user" on the PROGRAM — the
 * create dialog says exactly that, and the program card renders it as
 * "cap $X/user". It is not a per-leg allowance. Counting one leg's claims made
 * the ceiling depend on the ORDER the legs were claimed in: an approved FTD
 * lossback was invisible to the wager leg's check, so lossback-then-wager paid
 * cap + lossback while wager-then-lossback paid the cap. Both legs now read
 * this one number, so there is no order left to exploit.
 *
 * ── WHY PENDING HOLDS ─────────────────────────────────────────────────────
 * A pending claim is a payout already queued, and nothing stops a user filing
 * the next one while it waits. Counting approved rows only hands every fresh
 * claim a clean slate, and the cap is discovered to be blown only once staff
 * approve the backlog — by which point the money is out. So pending holds
 * against the cap exactly as it holds wager basis (`BASIS_HOLDING_STATUSES`),
 * and rejection releases both by simply falling out of the filter, with no
 * compensating write.
 *
 * Summed in SQL as numeric and rounded to cents ONCE, so no float chain forms.
 */
async function heldRewardCents(
  programId: string,
  userId: string,
): Promise<number> {
  const rows = await adminDrizzle
    .select({
      value: sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
    })
    .from(creator_reward_claims)
    .where(
      and(
        eq(creator_reward_claims.program_id, programId),
        eq(creator_reward_claims.user_id, userId),
        // No `leg` filter, and deliberately NOT run-scoped: this is a lifetime
        // ceiling on the program, so a code switch does not reset it either.
        inArray(creator_reward_claims.status, [...BASIS_HOLDING_STATUSES]),
      ),
    );
  return toCents(toNumber(rows[0]?.value));
}

/**
 * Wager BASIS already held by this user's claims on this program.
 *
 * Strictly wager-leg: basis is a wager-leg concept, a lossback claim consumes
 * none of it (it writes 0), and widening this to other legs would let a
 * lossback silently eat wager the player is still owed against. The per-user
 * reward cap is a separate quantity with separate scoping — see
 * `heldRewardCents`.
 */
async function priorHoldings(
  programId: string,
  userId: string,
  runStart: Date,
): Promise<{ consumedUsd: number }> {
  const rows = await adminDrizzle
    .select({
      status: creator_reward_claims.status,
      consumed: sql<string>`COALESCE(SUM(${creator_reward_claims.consumed_wager_usd}), 0)::text`,
    })
    .from(creator_reward_claims)
    .where(
      and(
        eq(creator_reward_claims.program_id, programId),
        eq(creator_reward_claims.user_id, userId),
        eq(creator_reward_claims.leg, "wager"),
      ),
    )
    // Consumption is scoped to the CURRENT run for the same reason the wager
    // is: basis burned on a previous run must not eat into the new one, or the
    // reset would be one-sided and a returning player could never claim again.
    .groupBy(creator_reward_claims.status);

  let consumedUsd = 0;
  for (const r of rows) {
    if (r.status === "approved" || r.status === "pending") {
      consumedUsd += toNumber(r.consumed);
    }
  }

  // Run-scoping the consumed basis needs a row-level date filter, which the
  // status groupBy above can't express. Claims per (program, user) are few, so
  // this correction is a cheap targeted read and only runs when there is
  // something to correct.
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
  return { consumedUsd };
}

/**
 * `heldRewardCents` for many programs at once — one GROUP BY instead of one
 * statement per program. A program with no holding claims produces no row and
 * keeps the seeded 0, which is the same number the per-program SUM returns.
 */
async function batchHeldRewardCents(
  programIds: string[],
  userId: string,
): Promise<Map<string, number>> {
  const out = new Map(programIds.map((id) => [id, 0]));
  if (programIds.length === 0) return out;

  const rows = await adminDrizzle
    .select({
      program_id: creator_reward_claims.program_id,
      value: sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
    })
    .from(creator_reward_claims)
    .where(
      and(
        inArray(creator_reward_claims.program_id, programIds),
        eq(creator_reward_claims.user_id, userId),
        inArray(creator_reward_claims.status, [...BASIS_HOLDING_STATUSES]),
      ),
    )
    .groupBy(creator_reward_claims.program_id);

  for (const row of rows) {
    out.set(row.program_id, toCents(toNumber(row.value)));
  }
  return out;
}

/**
 * `priorHoldings` for many programs at once.
 *
 * The three reads it makes are program-scoped in the same shape, differing
 * only in the program id and — for the two run-scoped ones — the run start
 * that program resolved to. Batched by binding the (program, run start) pairs
 * as parallel arrays and joining them with `unnest`, so each becomes one
 * statement regardless of program count.
 *
 * The arithmetic is deliberately assembled in JS in the SAME order the
 * per-program function uses (status sums, then the stale subtraction with its
 * clamp, then expired basis) — the intermediate is a float and reordering it
 * would be a behaviour change dressed up as an optimisation.
 *
 * `now` is taken ONCE for the whole sweep instead of per program. That is the
 * only observable difference from N separate calls, and it is the safer
 * direction: every program in one check now measures expiry against the same
 * instant rather than drifting across the fan-out.
 */
async function batchPriorConsumedUsd(
  entries: { programId: string; runStart: Date }[],
  userId: string,
): Promise<Map<string, number>> {
  const out = new Map(entries.map((entry) => [entry.programId, 0]));
  if (entries.length === 0) return out;

  const programIds = entries.map((entry) => entry.programId);
  const runStartsIso = entries.map((entry) => entry.runStart.toISOString());
  const holding = [...BASIS_HOLDING_STATUSES];
  const now = new Date().toISOString();

  const byStatus = await adminDrizzle
    .select({
      program_id: creator_reward_claims.program_id,
      status: creator_reward_claims.status,
      consumed: sql<string>`COALESCE(SUM(${creator_reward_claims.consumed_wager_usd}), 0)::text`,
    })
    .from(creator_reward_claims)
    .where(
      and(
        inArray(creator_reward_claims.program_id, programIds),
        eq(creator_reward_claims.user_id, userId),
        eq(creator_reward_claims.leg, "wager"),
      ),
    )
    .groupBy(creator_reward_claims.program_id, creator_reward_claims.status);

  for (const row of byStatus) {
    if (row.status !== "approved" && row.status !== "pending") continue;
    out.set(
      row.program_id,
      (out.get(row.program_id) ?? 0) + toNumber(row.consumed),
    );
  }

  // Only the programs that actually consumed something need the run-scoped
  // correction — the per-program path skips the read entirely otherwise, and
  // skipping it here too keeps the batch from costing MORE statements than the
  // fan-out it replaces when a player has no claims (the common case).
  const needsStale = entries.filter(
    (entry) => (out.get(entry.programId) ?? 0) > 0,
  );

  const [stale, expired] = await Promise.all([
    needsStale.length === 0
      ? null
      : adminDrizzle.execute<{ program_id: string; value: string }>(sql`
          SELECT c.program_id::text AS program_id,
                 COALESCE(SUM(c.consumed_wager_usd), 0)::text AS value
            FROM creator_reward_claims c
            JOIN unnest(
                   ${pgArrayParam(needsStale.map((e) => e.programId))}::uuid[],
                   ${pgArrayParam(needsStale.map((e) => e.runStart.toISOString()))}::timestamptz[]
                 ) AS r(program_id, run_start)
              ON r.program_id = c.program_id
           WHERE c.user_id = ${userId}
             AND c.leg = 'wager'
             AND c.status = ANY(${pgArrayParam(holding)}::text[])
             AND c.requested_at < r.run_start
           GROUP BY 1
        `),

    adminDrizzle.execute<{ program_id: string; value: string }>(sql`
      SELECT w.program_id::text AS program_id,
             COALESCE(SUM(w.basis_usd), 0)::text AS value
        FROM creator_reward_offer_windows w
        JOIN unnest(
               ${pgArrayParam(programIds)}::uuid[],
               ${pgArrayParam(runStartsIso)}::timestamptz[]
             ) AS r(program_id, run_start)
          ON r.program_id = w.program_id
       WHERE w.user_id = ${userId}
         AND w.leg = 'wager'
         AND w.run_started_at = r.run_start
         AND w.claimed_at IS NULL
         AND w.expires_at <= ${now}::timestamptz
       GROUP BY 1
    `),
  ]);

  for (const row of stale?.rows ?? []) {
    const consumed = out.get(row.program_id);
    // Never drives the total negative — same clamp as the per-program path.
    if (consumed === undefined) continue;
    out.set(row.program_id, Math.max(0, consumed - toNumber(row.value)));
  }
  for (const row of expired.rows) {
    const consumed = out.get(row.program_id);
    if (consumed === undefined) continue;
    out.set(row.program_id, consumed + toNumber(row.value));
  }
  return out;
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
  batch?: EntitlementBatch,
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
  if (program.ends_at && program.ends_at.getTime() <= Date.now()) {
    return { ...empty, blockedReason: "This program has ended." };
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

  // Run start and both wager totals arrive together — see `wagerPosition`.
  // A batched position is the SAME statement already executed for this
  // program; anything not in the batch falls back to its own read, which is
  // what keeps the single-program callers (the claim path, the admin preview)
  // on exactly the code they have always run.
  const position =
    batch?.positions.get(program.id) ??
    (await wagerPosition(
      program.id,
      userId,
      program.codes,
      program.accrual_start_at,
      await programWindows(program),
    ));
  const runStart = position.runStart;
  const wagerUsd = position.currentUsd;
  const lifetimeWagerUsd = position.lifetimeUsd;

  // Basis consumption and cap holdings are different quantities with different
  // scoping (see both functions), so they are two reads — issued together, so
  // the split costs no extra latency.
  const batchedConsumed = batch?.priorConsumedUsd.get(program.id);
  const batchedHeld = batch?.heldRewardCents.get(program.id);
  const [prior, heldCents, vip] = await Promise.all([
    batchedConsumed === undefined
      ? priorHoldings(program.id, userId, runStart)
      : { consumedUsd: batchedConsumed },
    capUsd == null
      ? 0
      : (batchedHeld ?? (await heldRewardCents(program.id, userId))),
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
    const remainingCents = Math.max(0, toCents(capUsd) - heldCents);
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

  return enforceOfferExpiry(
    {
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
    },
    userId,
  );
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
  batch?: EntitlementBatch,
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
  if (program.ends_at && program.ends_at.getTime() <= Date.now()) {
    return { ...empty, blockedReason: "This program has ended." };
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
  if (standing.banned)
    return { ...empty, blockedReason: "This account is banned." };
  if (standing.locked)
    return { ...empty, blockedReason: "This account is locked." };

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
    batch,
  );

  // The per-user cap applies to BOTH legs, and both legs measure what is
  // already held the SAME way — `heldRewardCents` is the single definition.
  let payout = ftd.payoutUsd;
  let capped = false;
  if (program.max_reward_per_user_usd != null) {
    const batchedHeld = batch?.heldRewardCents.get(program.id);
    const remainingCents = Math.max(
      0,
      toCents(toNumber(program.max_reward_per_user_usd)) -
        (batchedHeld ?? (await heldRewardCents(program.id, userId))),
    );
    if (toCents(payout) > remainingCents) {
      payout = fromCents(remainingCents);
      capped = true;
    }
  }

  return enforceOfferExpiry(
    {
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
    },
    userId,
  );
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
  batch?: EntitlementBatch,
): Promise<CreatorRewardEntitlement[]> {
  const legs: Promise<CreatorRewardEntitlement>[] = [];
  if (legConfigured(program, "wager")) {
    legs.push(computeEntitlement(program, userId, facts, batch));
  }
  if (legConfigured(program, "ftd_lossback")) {
    legs.push(computeLossbackEntitlement(program, userId, facts, batch));
  }
  return Promise.all(legs);
}

/**
 * The program-SCOPED reads, pre-resolved for a whole sweep.
 *
 * `UserFacts` removed the reads that don't vary by program. This removes the
 * ones that do: each entry here is a query whose SHAPE repeats per program and
 * differs only in the program id (and, for the run-scoped ones, the run start
 * that program resolved to), so N programs collapse to a fixed number of
 * statements instead of N × legs round-trips.
 *
 * ── PRESENCE IS THE CONTRACT ──────────────────────────────────────────────
 * A program id present in a map means "already read, use this". Absent means
 * "not batched, read it yourself". Every covered program is therefore seeded
 * with its zero/fallback value BEFORE the query runs, so a program that simply
 * has no rows is still covered and never silently falls back to a duplicate
 * read. This is also what makes the batch a pure cost optimisation: nothing
 * that isn't in it changes behaviour.
 */
export type EntitlementBatch = {
  positions: Map<string, WagerPosition>;
  priorConsumedUsd: Map<string, number>;
  heldRewardCents: Map<string, number>;
  /** Wager-leg only; the lossback leg's own claim count is keyed separately. */
  lossbackHeldClaims: Map<string, number>;
  /** UPPERCASE codes this player signed up under. null = not batched. */
  signupCodes: Set<string> | null;
};

/**
 * Build the batch for one player across many programs.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not re-implement any guard. The caller passes only the programs that
 * could plausibly reach these reads, which is a COST filter and nothing else:
 * a program wrongly included is answered from the batch by an entitlement that
 * was going to block anyway (the read is wasted, the answer unchanged), and a
 * program wrongly excluded simply reads for itself. Correctness never depends
 * on that filter agreeing with the guards.
 *
 * Two latency layers, not one: the run-scoped reads cannot be issued until the
 * wager positions have resolved the run starts, which is the same dependency
 * the per-program path has.
 */
export async function loadEntitlementBatch(
  programs: ProgramForCompute[],
  userId: string,
): Promise<EntitlementBatch> {
  const wagerPrograms = programs.filter((p) => legConfigured(p, "wager"));
  const lossbackPrograms = programs.filter((p) =>
    legConfigured(p, "ftd_lossback"),
  );
  const cappedIds = programs
    .filter((p) => p.max_reward_per_user_usd != null)
    .map((p) => p.id);
  const lossbackCodes = [
    ...new Set(
      lossbackPrograms.flatMap((p) => p.codes.map((c) => c.toUpperCase())),
    ),
  ];

  const [positions, heldRewardCentsByProgram, lossbackClaims, signup] =
    await Promise.all([
      batchWagerPositions(userId, wagerPrograms),
      batchHeldRewardCents(cappedIds, userId),
      batchLossbackHeldClaims(
        lossbackPrograms.map((p) => p.id),
        userId,
      ),
      lossbackPrograms.length === 0
        ? Promise.resolve(null)
        : signedUpCodes(userId, lossbackCodes),
    ]);

  const priorConsumedUsd = await batchPriorConsumedUsd(
    wagerPrograms.map((p) => ({
      programId: p.id,
      // Present by construction: `batchWagerPositions` seeds every program it
      // is given, so this never silently substitutes the wrong run start.
      runStart:
        positions.get(p.id)?.runStart ?? p.accrual_start_at,
    })),
    userId,
  );

  return {
    positions,
    priorConsumedUsd,
    heldRewardCents: heldRewardCentsByProgram,
    lossbackHeldClaims: lossbackClaims,
    signupCodes: signup,
  };
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
    .where(
      and(
        eq(creator_reward_programs.is_active, true),
        or(
          isNull(creator_reward_programs.ends_at),
          gt(creator_reward_programs.ends_at, new Date().toISOString()),
        ),
      ),
    )
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
    ends_at: program.ends_at ? new Date(program.ends_at) : null,
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

  const attached = await getProdReadDrizzleDb().execute<{ hit: boolean }>(sql`
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

  // ── COST FILTER, NOT A GUARD ──────────────────────────────────────────────
  // Which programs are worth pre-reading for. It mirrors the cheap guards that
  // short-circuit BEFORE any program-scoped read (no standing, banned, locked,
  // creator's own program, switched to another creator's code) purely so the
  // batch doesn't pay for answers nobody will use. It decides nothing: the
  // entitlement functions re-assert every one of these themselves, and a
  // program left out of the batch reads for itself exactly as before.
  const standing = facts.standing;
  const switchedCode = standing?.currentCode ?? null;
  const worthBatching =
    standing == null || standing.banned || standing.locked
      ? []
      : programs.filter(
          (p) =>
            p.creator_user_id !== userId &&
            (switchedCode == null ||
              p.codes.some((c) => c.toUpperCase() === switchedCode)),
        );
  const batch = await loadEntitlementBatch(worthBatching, userId);

  const results = (
    await Promise.all(
      programs.map((p) => computeProgramOffers(p, userId, facts, batch)),
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
