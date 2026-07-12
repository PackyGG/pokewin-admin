import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { CUSTOMER_EXCLUDED_ROLES } from "@/lib/metrics/scope";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import {
  daysForDoubleDownPeriodCapped,
  cacheTtlForDoubleDownPeriod,
  type DoubleDownPeriod,
  type DoubleDownResult,
  type DoubleDownStats,
  type DoubleDownLogRow,
  type DoubleDownLog,
  type DoubleDownTimeSeriesPoint,
  type DoubleDownDashboardStats,
} from "@/lib/queries/double-down-shared";

// Re-export the client-safe shared surface so server call sites keep a single
// import path (`@/lib/queries/double-down`). The runtime period constants +
// the row TYPES live in `double-down-shared.ts` (no server-only graph) so
// client components can import them without pulling getDb / Prisma into the
// browser bundle.
export { doubleDownPeriodLabel } from "@/lib/queries/double-down-shared";
export type {
  DoubleDownPeriod,
  DoubleDownResult,
  DoubleDownStats,
  DoubleDownLogRow,
  DoubleDownLog,
  DoubleDownTimeSeriesPoint,
  DoubleDownDashboardStats,
  UserDoubleDownHistory,
} from "@/lib/queries/double-down-shared";

/**
 * Double Down — shared read layer for BOTH admin surfaces.
 *
 * Double Down is a live packy.gg feature: after WINNING a battle, a user may
 * gamble those winnings. On a WIN they are paid a voucher; on a LOSE they
 * forfeit the whole win. The house margin is in the win odds (~45% player /
 * 55% site) — there is NO per-round cut.
 *
 * This module is the SINGLE source of truth for reading Double Down activity —
 * consumed by:
 *   • the /insights/double-down page (global KPI strip + full audit log), and
 *   • the /users/[id] Gaming tab (this user's Double Down history log).
 *
 * ── DB facts (verified read-only against live prod, 2026-06-30) ──────────────
 * The tables/enums live ONLY in the live prod game DB — the local
 * prisma/schema.prisma is stale and does NOT model them, so every read here is
 * hand-written parameterized SQL through the prod client (getDb()) rather than
 * a generated Prisma model. MAIN is STRICTLY READ-ONLY — these are all SELECTs.
 *
 *   TABLE public.battle_double_down_offers (one row per round)
 *     id uuid PK · battle_id uuid · user_id text→"user".id ·
 *     game_session_id uuid · won_amount_usd numeric (the staked battle
 *     winnings) · result enum battle_double_down_result {win,lose} (NULL until
 *     resolved) · status enum battle_double_down_status
 *     {offered,accepted,resolved,expired} · won_voucher_id uuid (set on win) ·
 *     expires_at · accepted_at · resolved_at · created_at · updated_at.
 *     Indexes: PK(id) · UNIQUE(battle_id,user_id) · (status,expires_at) ·
 *     (user_id,status). NOTE: NO created_at index.
 *
 *   Payout money (on a WIN): a voucher is created with
 *   origin='battle_double_down_payout', won_voucher_id set on the offer. We
 *   join vouchers by the offer's won_voucher_id and read the REAL credited
 *   payout from the voucher's `value` column (which reconciles exactly to the
 *   `voucher_redeemed` ledger amount, verified read-only on prod). NO
 *   multiplier; the metadata->>'payout_amount_usd' key is MISSING on most wins
 *   so it is NOT used (a prior 0.9× metadata-fallback FABRICATED a wrong lower
 *   payout — e.g. a $24.76-stake win as $22.28 instead of the real $24.76 —
 *   and was removed). `won_amount_usd` is the STAKE; on a win the payout
 *   equals the stake (1.0×) in the current version (0.9× only in 4 early buggy
 *   rounds, captured by reading the real value). The voucher's
 *   house_amount_usd is NOT used.
 *
 * ── House-POV money (CLAUDE.md, STRICT) ──────────────────────────────────────
 *   • payout to a WINNER = house COST → 🔴 rose
 *   • House P&L over RESOLVED rounds = total staked − total paid out: losers
 *     forfeit their full stake (house keeps it), winners get their stake back.
 *     POSITIVE = house PROFIT → 🟢 emerald. There is NO per-round cut — the
 *     house margin is in the win odds (~45% player / 55% site).
 *   "Started rounds" is the engagement count (all started rounds); the MONEY
 *   (wager / payout / P&L) is over RESOLVED rounds so a still-pending accepted
 *   round's stake doesn't inflate house profit. All money is Decimal-safe
 *   (numeric → string → Number, exact Postgres SUM).
 *
 * ── Index-or-ClickHouse (CLAUDE.md, BACKEND_QUERY_SYSTEM.md) ──────────────────
 *   • Per-user lookup (getUserDoubleDownHistory) filters user_id → served by
 *     the (user_id,status) index (EXPLAIN → Bitmap Index Scan). Indexed. ✓
 *   • The global windowed aggregate + audit log ORDER BY created_at SEQ-SCAN
 *     (there is no created_at index). At today's tiny row count that is the
 *     planner's optimal plan, but per the rule a CREATE INDEX CONCURRENTLY on
 *     (created_at) is flagged — NOT applied — in prisma/recommended-indexes.sql.
 *     The aggregate + log are cached (unstable_cache) + timeout-wrapped at the
 *     call site, and the lifetime window is bounded (windowed, capped) so no
 *     unbounded scan ships.
 *   • The "how many battles use Double Down" DENOMINATOR (total battles SINCE
 *     LAUNCH, added to the KPI aggregate) is INDEX-SERVED: EXPLAIN (ANALYZE,
 *     BUFFERS) (read-only, prod) → Index Only Scan using
 *     idx_battles_status_created_at on battles(created_at >= GREATEST(since,
 *     min(offer.created_at))). No Seq Scan on the large battles table (the
 *     min() launch subquery is a tiny Seq Scan on the offers table). The window
 *     is FLOORED at the Double Down launch instant so the adoption rate is not
 *     diluted by battles from before the feature existed (owner rule).
 */

// ── Row mapping ───────────────────────────────────────────────────────────────

type RawLogRow = {
  id: string;
  user_id: string;
  username: string | null;
  battle_id: string;
  won_amount_usd: string;
  result: DoubleDownResult | null;
  payout_amount_usd: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

/** Decimal-safe numeric→Number; null/NaN guard. */
function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * STARTED-only predicate (owner rule, 2026-06-30): Double Down is OPTIONAL —
 * the user is OFFERED the round and chooses whether to play. We only ever
 * track/count rounds the user ACTUALLY STARTED, i.e. accepted/played:
 * `status IN ('accepted','resolved')`. This EXCLUDES `offered` (pending, never
 * clicked) and `expired` (offered, never taken) from EVERY surface.
 *
 * Verified read-only on prod: `status IN ('accepted','resolved')` exactly
 * equals the set that has a `game_sessions` row with
 * game_type='battle_double_down' (the dashboard's "played" definition), so all
 * three surfaces agree. NOTE: `accepted_at` is NOT reliably populated on this
 * DB (all NULL in the sample) — `status` is the authoritative signal, so we
 * key off status, not accepted_at.
 *
 * An 'accepted'-but-not-yet-'resolved' round IS started (rare/transient — PF
 * resolves fast) and is included; it reads as a pending RESULT.
 */
const STARTED_STATUS = Prisma.sql`o.status IN ('accepted','resolved')`;

/**
 * CANONICAL customer scope for the AGGREGATE Double Down surfaces (Insights
 * stats / log / time-series + the dashboard panel). Reuses the SAME two
 * exclusions the rest of customer-analytics uses (CLAUDE.md "Staff-Exclusion
 * in Analytics"; `src/lib/metrics/scope.ts` `getMetricsScope`;
 * `src/lib/queries/_blacklist.ts`):
 *
 *   1. `excluded_users` BLACKLIST — the admin-managed blacklist resolved by
 *      `getExcludedUserIds()` (from the ADMIN DB, cross-DB applied here as a
 *      `NOT IN` on the MAIN query), same as every other money aggregate.
 *   2. CREATORS dropped WHOLESALE — `role NOT IN CUSTOMER_EXCLUDED_ROLES`
 *      (`'admin','support','creator'`). This is the canonical CUSTOMER
 *      population (`scope.ts` §1). Dropping every creator is a SUPERSET that
 *      covers creator-FILL / on-stream sessions: the codebase's fill/stream
 *      definition is the best-effort backend session-window CTE
 *      (`getCreatorSessionWindowsCte`), which `scope.ts` §3 documents as a
 *      REDUNDANT no-op once creators are dropped wholesale — so we drop
 *      creators wholesale (non-best-effort, no backend dependency) rather than
 *      re-plumbing the session-window CTE into these tiny reads. There is NO
 *      game_sessions/battle-level "fill" marker on MAIN (verified read-only:
 *      only `game_sessions.bot_id` + `battles.sponsorship_*` exist, and the
 *      creator DD rounds link to NO `creator_fill_conversion`), so a
 *      session-level fill filter cannot be built without guessing.
 *
 * The excluded ids are resolved OUTSIDE any `unstable_cache` and passed in as a
 * serializable cache-key arg (same pattern as the other cached aggregates).
 * NOT applied to the /users/[id] per-user history — that page intentionally
 * shows a specific user's own rounds even if they're a creator/blacklisted.
 */
const CUSTOMER_EXCLUDED_ROLES_SQL = Prisma.join(
  CUSTOMER_EXCLUDED_ROLES.map((r) => Prisma.sql`${r}`),
);

function customerScopeSql(excludedIds: string[]): Prisma.Sql {
  // Blacklist tail — reuse escapeBlacklistIds (the single canonical escaper);
  // Prisma.raw is safe here because the ids are already quote-escaped literals.
  const blacklistTail =
    excludedIds.length > 0
      ? Prisma.sql` AND id NOT IN (${Prisma.raw(escapeBlacklistIds(excludedIds))})`
      : Prisma.empty;
  return Prisma.sql`o.user_id IN (
    SELECT id FROM "user"
    WHERE role NOT IN (${CUSTOMER_EXCLUDED_ROLES_SQL})${blacklistTail}
  )`;
}

function mapLogRow(r: RawLogRow): DoubleDownLogRow {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    battleId: r.battle_id,
    stakedUsd: num(r.won_amount_usd) ?? 0,
    result: r.result,
    payoutUsd: num(r.payout_amount_usd),
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

// ── SURFACE 1: global windowed aggregate (KPI strip) ──────────────────────────

async function computeStats(
  period: DoubleDownPeriod,
  excludedIds: string[],
): Promise<DoubleDownStats> {
  const db = await getDb();
  const days = daysForDoubleDownPeriodCapped(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const scope = customerScopeSql(excludedIds);

  // STARTED-only (owner rule): only rounds the user actually played
  // (status IN accepted/resolved) — offered/expired offers are excluded.
  // "Started rounds" is the engagement count (all started rounds in the
  // window); the MONEY (staked / paid / P&L) is over RESOLVED rounds so a
  // still-pending accepted round's stake doesn't inflate house profit.
  //
  // PAYOUT SOURCE = the REAL credited amount = the paired payout voucher's
  // `value` (reconciles exactly to the `voucher_redeemed` ledger amount,
  // verified read-only on prod). The old metadata.payout_amount_usd key is
  // MISSING on most wins and the previous 0.9× fallback FABRICATED a lower
  // payout (e.g. a $24.76-stake win showed $22.28 instead of the real $24.76)
  // — both deleted. We read v.value with NO multiplier. SUM(numeric) is exact.
  // Two reads, run in parallel:
  //   (1) the DD offers aggregate (existing) — plus count(DISTINCT o.battle_id),
  //       the NUMERATOR of "how many battles do double down" (distinct battles
  //       with a STARTED round; customer-scoped, same predicate as the rest of
  //       the strip). Seq-scans the tiny offers table (planner-optimal, flagged).
  //   (2) total battles SINCE DOUBLE DOWN LAUNCHED — the DENOMINATOR. Owner
  //       rule (2026-07-01): "count from the time we added it, not lifetime".
  //       DD is only a few days old, so counting the full 30d window here
  //       (battles from BEFORE DD existed) massively understated the adoption
  //       rate (~0.11% vs the real ~13.8%). The launch instant is derived IN
  //       SQL — min(created_at) over the offers table — so nothing is hardcoded
  //       and it self-adapts. GREATEST(${since}, launch) floors the window at
  //       launch today and gracefully clamps back to the 30d page window once
  //       the feature is >30d old. Index-served: EXPLAIN (ANALYZE, BUFFERS)
  //       (read-only, prod) → Index Only Scan using idx_battles_status_created_at
  //       on battles; the min() subquery is a tiny Seq Scan on the offers table.
  //       NO Seq Scan on the large battles table. NOT customer-scoped (a battle
  //       has no single owner) — it is the whole battle population since launch.
  const [rows, battleCountRows] = await Promise.all([
    db.$queryRaw<
      {
        total_rounds: bigint;
        resolved_rounds: bigint;
        win_count: bigint;
        lose_count: bigint;
        total_staked: string | null;
        total_paid_out: string | null;
        distinct_battles_with_dd: bigint;
      }[]
    >(Prisma.sql`
      SELECT
        count(*)                                                          AS total_rounds,
        count(*) FILTER (WHERE o.result IS NOT NULL)                      AS resolved_rounds,
        count(*) FILTER (WHERE o.result = 'win')                          AS win_count,
        count(*) FILTER (WHERE o.result = 'lose')                         AS lose_count,
        -- Total wager = staked over RESOLVED rounds.
        sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL)         AS total_staked,
        -- Real payout = the paired payout voucher's value (no multiplier).
        sum(v.value) FILTER (WHERE o.result = 'win')                      AS total_paid_out,
        -- Distinct battles that had a started DD round (numerator).
        count(DISTINCT o.battle_id)                                       AS distinct_battles_with_dd
      FROM battle_double_down_offers o
      LEFT JOIN vouchers v
        ON v.id = o.won_voucher_id
       AND v.origin = 'battle_double_down_payout'
      WHERE ${STARTED_STATUS} AND o.created_at >= ${since} AND ${scope}
    `),
    db.$queryRaw<{ total_battles: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total_battles
      FROM battles
      WHERE created_at >= GREATEST(
        ${since},
        (SELECT min(created_at) FROM battle_double_down_offers)
      )
    `),
  ]);

  const r = rows[0];
  const totalRounds = Number(r?.total_rounds ?? 0);
  const resolvedRounds = Number(r?.resolved_rounds ?? 0);
  const winCount = Number(r?.win_count ?? 0);
  const loseCount = Number(r?.lose_count ?? 0);
  const totalStaked = num(r?.total_staked ?? null) ?? 0;
  const totalPaidOut = num(r?.total_paid_out ?? null) ?? 0;
  const distinctBattlesWithDd = Number(r?.distinct_battles_with_dd ?? 0);
  const totalBattles = Number(battleCountRows[0]?.total_battles ?? 0);
  // House P&L over RESOLVED rounds = total staked − total actually paid out.
  // Losers forfeit their full stake (house keeps it); winners get their stake
  // back (net ~0 in the fixed era). POSITIVE = house PROFIT (emerald).
  const netHousePnl = totalStaked - totalPaidOut;

  return {
    totalRounds,
    resolvedRounds,
    winCount,
    loseCount,
    winRate: resolvedRounds > 0 ? winCount / resolvedRounds : null,
    totalStaked,
    totalPaidOut,
    netHousePnl,
    distinctBattlesWithDd,
    totalBattles,
    // Divide-by-zero guard: no battles in the window → null (renders "—").
    battleDoubleDownRate:
      totalBattles > 0 ? distinctBattlesWithDd / totalBattles : null,
  };
}

/** KPI-strip aggregate for the /insights/double-down page. Cached on prod.
 *  Excluded ids (blacklist + customer scope) resolved OUTSIDE the cache and
 *  keyed on the sorted list — same pattern as the other money aggregates. */
export async function getDoubleDownStats(
  period: DoubleDownPeriod,
): Promise<DoubleDownStats> {
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const env = await readDbEnv();
  if (env !== "prod") return computeStats(period, excludedIds);
  // unstable_cache does not let us vary revalidate per-call from outside, so we
  // key the cache on the period AND pick the TTL via a period-specific wrapper.
  // Cache key bumped to v4 (2026-07-01): the MEANING of the denominator changed
  // — totalBattles (and thus battleDoubleDownRate) is now floored at the Double
  // Down LAUNCH instant (GREATEST(since, min(offer.created_at))) instead of the
  // full 30d window, so a stale v4-predecessor hit would serve the old diluted
  // ~0.11% rate instead of the real ~13.8%. Bumping the version forces a fresh
  // compute with the launch-floored denominator. (v3 first shipped the
  // distinctBattlesWithDd / totalBattles / battleDoubleDownRate keys — commit
  // 4133e1d3; before that a stale v2 hit rendered "— NaN of NaN battles".)
  return unstable_cache(
    (p: DoubleDownPeriod, ids: string[]) => computeStats(p, ids),
    ["double-down-stats-v4", period, excludedIds.join(",")],
    { revalidate: cacheTtlForDoubleDownPeriod(period), tags: ["double-down"] },
  )(period, excludedIds);
}

// ── SURFACE 1: hourly time series (Usage + House P&L charts) ──────────────────

async function computeTimeSeries(
  period: DoubleDownPeriod,
  excludedIds: string[],
): Promise<DoubleDownTimeSeriesPoint[]> {
  const db = await getDb();
  const days = daysForDoubleDownPeriodCapped(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const scope = customerScopeSql(excludedIds);

  // DAILY buckets (date_trunc('day', …), UTC). The page is locked to a 30d
  // window, so hourly buckets produced up to 720 bars crammed under 24 repeating
  // "HH:00" labels (unreadable + wrong — the same label reappeared every day).
  // Daily gives one bar per day with a clean "MMM d" X-axis (matches the other
  // insights daily charts). `started` = count of started rounds in the day
  // (Usage); `pnl` = net house P&L over RESOLVED rounds in the day = Σ staked −
  // Σ real voucher payout (same model as the KPI strip). Bounded by the period
  // window (started-only). The table has no created_at index → this seq-scans
  // the tiny table (fine at this volume; flagged in recommended-indexes.sql like
  // the other reads).
  const rows = await db.$queryRaw<
    { bucket: Date; started: bigint; pnl: string | null }[]
  >(Prisma.sql`
    SELECT
      date_trunc('day', o.created_at)                             AS bucket,
      count(*)                                                    AS started,
      coalesce(sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL), 0)
        - coalesce(sum(v.value) FILTER (WHERE o.result = 'win'), 0)  AS pnl
    FROM battle_double_down_offers o
    LEFT JOIN vouchers v
      ON v.id = o.won_voucher_id
     AND v.origin = 'battle_double_down_payout'
    WHERE ${STARTED_STATUS} AND o.created_at >= ${since} AND ${scope}
    GROUP BY 1
    ORDER BY 1
  `);

  // Build the running cumulative P&L and the "yyyy-MM-dd" UTC day key (the
  // client chart pretty-prints it to "MMM d", same helper as the other daily
  // insights charts).
  let cum = 0;
  return rows.map((r) => {
    const pnl = num(r.pnl) ?? 0;
    cum += pnl;
    const d = r.bucket;
    const bucket = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    return {
      bucket,
      started: Number(r.started ?? 0),
      pnl,
      cumPnl: cum,
    };
  });
}

/**
 * Daily time series for the /insights/double-down charts (Usage = round
 * count per day; House P&L = staked − real payout per day, + a cumulative
 * line). Cached on prod, keyed on period.
 */
export async function getDoubleDownTimeSeries(
  period: DoubleDownPeriod,
): Promise<DoubleDownTimeSeriesPoint[]> {
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const env = await readDbEnv();
  if (env !== "prod") return computeTimeSeries(period, excludedIds);
  return unstable_cache(
    (p: DoubleDownPeriod, ids: string[]) => computeTimeSeries(p, ids),
    // v3 (2026-07-01): buckets changed HOURLY ("HH:00") → DAILY ("yyyy-MM-dd").
    // A stale v2 hit would serve the old hourly buckets under the new day-label
    // chart, so the version is bumped to force a fresh daily-bucket compute.
    ["double-down-timeseries-v3", period, excludedIds.join(",")],
    { revalidate: cacheTtlForDoubleDownPeriod(period), tags: ["double-down"] },
  )(period, excludedIds);
}

// ── SURFACE 1: paginated audit log ────────────────────────────────────────────

const LOG_SELECT = Prisma.sql`
  SELECT
    o.id,
    o.user_id,
    u.username,
    o.battle_id,
    o.won_amount_usd,
    o.result,
    -- Payout on a win = the paired payout voucher's REAL value (the actual
    -- credited amount; reconciles to the voucher_redeemed ledger). NO
    -- multiplier, NO metadata fallback — the old metadata key is missing on
    -- most wins and the 0.9× fallback fabricated a wrong lower payout. Non-win
    -- rows resolve to NULL → "—".
    CASE WHEN o.result = 'win' THEN v.value::text END AS payout_amount_usd,
    o.created_at,
    o.resolved_at
  FROM battle_double_down_offers o
  LEFT JOIN "user" u ON u.id = o.user_id
  LEFT JOIN vouchers v
    ON v.id = o.won_voucher_id
   AND v.origin = 'battle_double_down_payout'
`;

async function computeLog(args: {
  period: DoubleDownPeriod;
  page: number;
  perPage: number;
  search: string;
  excludedIds: string[];
}): Promise<DoubleDownLog> {
  const db = await getDb();
  const { period, page, perPage, search, excludedIds } = args;
  const days = daysForDoubleDownPeriodCapped(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const scope = customerScopeSql(excludedIds);

  // STARTED-only (owner rule): the audit log shows ONLY rounds the user
  // actually played (status IN accepted/resolved) — offered/expired offers
  // never appear. Canonical customer scope (blacklist + creators dropped
  // wholesale) also applied — see customerScopeSql. Optional username search
  // (prefix, case-insensitive, parameterized). The window filter seq-scans
  // (tiny table, no created_at index, flagged); the status + scope + username
  // predicates narrow the same scan.
  const trimmed = search.trim().toLowerCase();
  const searchClause = trimmed
    ? Prisma.sql`AND lower(u.username) LIKE ${trimmed + "%"}`
    : Prisma.empty;
  const whereClause = Prisma.sql`WHERE ${STARTED_STATUS} AND o.created_at >= ${since} AND ${scope} ${searchClause}`;

  const offset = (page - 1) * perPage;

  const [countRows, rows] = await Promise.all([
    db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT count(*) AS n
      FROM battle_double_down_offers o
      LEFT JOIN "user" u ON u.id = o.user_id
      ${whereClause}
    `),
    db.$queryRaw<RawLogRow[]>(Prisma.sql`
      ${LOG_SELECT}
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ${perPage} OFFSET ${offset}
    `),
  ]);

  const total = Number(countRows[0]?.n ?? 0);
  return {
    rows: rows.map(mapLogRow),
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Paginated, server-driven audit log for the /insights/double-down page.
 * Cached on prod keyed on (period, page, perPage, search). The list is
 * read-mostly so caching is safe (no operator mutation path on MAIN).
 */
export async function getDoubleDownLog(args: {
  period: DoubleDownPeriod;
  page: number;
  perPage: number;
  search: string;
}): Promise<DoubleDownLog> {
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const full = { ...args, excludedIds };
  const env = await readDbEnv();
  if (env !== "prod") return computeLog(full);
  return unstable_cache(
    (a: typeof full) => computeLog(a),
    [
      "double-down-log-v2",
      args.period,
      String(args.page),
      String(args.perPage),
      args.search.trim().toLowerCase(),
      excludedIds.join(","),
    ],
    { revalidate: cacheTtlForDoubleDownPeriod(args.period), tags: ["double-down"] },
  )(full);
}

// ── SURFACE 3: dashboard lifetime stats (DEV's canonical game_type method) ─────

const EMPTY_DASHBOARD_STATS: DoubleDownDashboardStats = {
  rounds: 0,
  wins: 0,
  loses: 0,
  pending: 0,
  uniquePlayers: 0,
  winRate: null,
  staked: 0,
  paidOut: 0,
  netHousePnl: 0,
};

async function computeDashboardStats(
  excludedIds: string[],
): Promise<DoubleDownDashboardStats> {
  const db = await getDb();
  const scope = customerScopeSql(excludedIds);

  // DEV's CANONICAL method (source of truth for the dashboard's game-type
  // counting): start from game_sessions filtered to game_type
  // 'battle_double_down', JOIN game_id → battle_double_down_offers. A
  // game_session row exists ONLY for a PLAYED round (accepted → resolved), so
  // this counts played rounds the same way the dashboard counts pack / battle /
  // upgrader plays. Outcome is read from o.result + o.won_amount_usd; the win
  // payout comes strictly from the paired payout VOUCHER's REAL value
  // (origin='battle_double_down_payout', v.value) — the actual credited amount,
  // which reconciles to the voucher_redeemed ledger amount. NOT a hardcoded
  // multiplier, NOT the (mostly-missing) metadata.payout_amount_usd key.
  // House P&L = staked − paid (over RESOLVED rounds): losers forfeit their full
  // stake (house keeps it), winners get their stake back → POSITIVE house P&L.
  //
  // Index path (EXPLAIN-proven read-only): the planner drives from the TINY
  // battle_double_down_offers table (Seq Scan, dozens of rows) and probes the
  // 653k-row game_sessions via idx_gs_game_id (Index Scan on game_id) — so the
  // large table is index-served. No game_sessions(game_type) index is needed
  // at this shape; flagged in recommended-indexes.sql only if the offers table
  // grows large enough that game_type-first filtering becomes the better plan.
  const rows = await db.$queryRaw<
    {
      rounds: bigint;
      wins: bigint;
      loses: bigint;
      pending: bigint;
      unique_players: bigint;
      staked: string | null;
      paid_out: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      count(*)                                                          AS rounds,
      count(*) FILTER (WHERE o.result = 'win')                          AS wins,
      count(*) FILTER (WHERE o.result = 'lose')                         AS loses,
      count(*) FILTER (WHERE o.result IS NULL)                          AS pending,
      count(DISTINCT gs.user_id)                                        AS unique_players,
      sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL)         AS staked,
      sum(v.value) FILTER (WHERE o.result = 'win')                      AS paid_out
    FROM game_sessions gs
    JOIN battle_double_down_offers o ON o.id = gs.game_id
    LEFT JOIN vouchers v
      ON v.id = o.won_voucher_id
     AND v.origin = 'battle_double_down_payout'
    WHERE gs.game_type = 'battle_double_down' AND ${scope}
  `);

  const r = rows[0];
  const wins = Number(r?.wins ?? 0);
  const loses = Number(r?.loses ?? 0);
  const resolved = wins + loses;
  const staked = num(r?.staked ?? null) ?? 0;
  const paidOut = num(r?.paid_out ?? null) ?? 0;
  // House P&L over RESOLVED rounds = staked − paid. >0 = house profit.
  const netHousePnl = staked - paidOut;

  return {
    rounds: Number(r?.rounds ?? 0),
    wins,
    loses,
    pending: Number(r?.pending ?? 0),
    uniquePlayers: Number(r?.unique_players ?? 0),
    winRate: resolved > 0 ? wins / resolved : null,
    staked,
    paidOut,
    netHousePnl,
  };
}

/**
 * Lifetime Double Down stats for the /dashboard panel. Mirrors the upgrader
 * panel's contract: lifetime aggregate, 5-minute cross-request cache (drifts
 * slowly, invisible to operators, skips the scan on the 60s dashboard
 * refresh), prod-only (a dev-DB-toggled admin reads live). Self-degrades to
 * zeroed stats via the to_regclass guard so a pre-feature DB renders an empty
 * panel instead of throwing 42P01.
 */
export async function getDoubleDownDashboardStats(): Promise<DoubleDownDashboardStats> {
  const excludedIds = [...(await getExcludedUserIds())].sort();
  const guarded = async (ids: string[]) => {
    const db = await getDb();
    // to_regclass guard: on a DB without the table (e.g. an old snapshot) skip
    // the read and return zeros rather than throwing 42P01 — matches how
    // upgraderMetrics guards its table.
    const exists = await db.$queryRaw<{ reg: string | null }[]>(
      Prisma.sql`SELECT to_regclass('public.battle_double_down_offers')::text AS reg`,
    );
    if (!exists[0]?.reg) return EMPTY_DASHBOARD_STATS;
    return computeDashboardStats(ids);
  };
  const env = await readDbEnv();
  if (env !== "prod") return guarded(excludedIds);
  return unstable_cache(
    (ids: string[]) => guarded(ids),
    ["dashboard-double-down-lifetime-v2", excludedIds.join(",")],
    { revalidate: 300, tags: ["dashboard-lifetime", "double-down"] },
  )(excludedIds);
}
