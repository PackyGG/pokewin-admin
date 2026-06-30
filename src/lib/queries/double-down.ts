import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import {
  daysForDoubleDownPeriodCapped,
  cacheTtlForDoubleDownPeriod,
  type DoubleDownPeriod,
  type DoubleDownResult,
  type DoubleDownStatus,
  type DoubleDownStats,
  type DoubleDownLogRow,
  type DoubleDownLog,
  type DoubleDownDashboardStats,
  type UserDoubleDownHistory,
} from "@/lib/queries/double-down-shared";

// Re-export the client-safe shared surface so server call sites keep a single
// import path (`@/lib/queries/double-down`). The runtime period constants +
// the row TYPES live in `double-down-shared.ts` (no server-only graph) so
// client components can import them without pulling getDb / Prisma into the
// browser bundle.
export {
  DOUBLE_DOWN_PERIODS,
  DEFAULT_DOUBLE_DOWN_PERIOD,
  DOUBLE_DOWN_LIFETIME_LOOKBACK_DAYS,
  parseDoubleDownPeriod,
  doubleDownPeriodLabel,
} from "@/lib/queries/double-down-shared";
export type {
  DoubleDownPeriod,
  DoubleDownResult,
  DoubleDownStatus,
  DoubleDownStats,
  DoubleDownLogRow,
  DoubleDownLog,
  DoubleDownDashboardStats,
  UserDoubleDownHistory,
} from "@/lib/queries/double-down-shared";

/**
 * Double Down — shared read layer for BOTH admin surfaces.
 *
 * Double Down is a live packy.gg feature: after WINNING a battle, a user may
 * gamble those winnings. On a WIN they keep 90% of the staked winnings (the
 * house takes a flat 10% edge); on a LOSE they forfeit the whole win.
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
 *   origin='battle_double_down_payout', origin_id=offer.id, won_voucher_id set
 *   on the offer. We join vouchers by the offer's won_voucher_id and read the
 *   ACTUAL minted payout from metadata->>'payout_amount_usd' (NOT a hardcoded
 *   multiplier; fallback to the observed ~0.9 × won only when metadata omits
 *   it). The voucher's house_amount_usd is NOT used (see below).
 *
 * ── House-POV money (CLAUDE.md, STRICT) ──────────────────────────────────────
 *   • payout to a WINNER  = house COST  → 🔴 rose
 *   • a LOSE / forfeit (staked winnings never paid out) = house GAIN → 🟢 emerald
 *   • NET house P&L = forfeited − payouts. REAL money flows ONLY — there is NO
 *     edge/"house cut" term (the house edge is in the WIN PROBABILITY, ~45%
 *     player / 55% house, not a per-round cut; adding a cut would double-count).
 *     The voucher's house_amount_usd is therefore intentionally ignored.
 *   Win-rate / probability is NOT stored — it is derived empirically from
 *   `result` (this IS the edge indicator; noisy at low volume). All money is
 *   Decimal-safe (numeric → string → Number, never summed as float in SQL
 *   beyond Postgres's own exact numeric SUM).
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
 */

// ── Row mapping ───────────────────────────────────────────────────────────────

type RawLogRow = {
  id: string;
  user_id: string;
  username: string | null;
  battle_id: string;
  won_amount_usd: string;
  result: DoubleDownResult | null;
  status: DoubleDownStatus;
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

function mapLogRow(r: RawLogRow): DoubleDownLogRow {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    battleId: r.battle_id,
    stakedUsd: num(r.won_amount_usd) ?? 0,
    result: r.result,
    status: r.status,
    payoutUsd: num(r.payout_amount_usd),
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

// ── SURFACE 1: global windowed aggregate (KPI strip) ──────────────────────────

async function computeStats(period: DoubleDownPeriod): Promise<DoubleDownStats> {
  const db = await getDb();
  const days = daysForDoubleDownPeriodCapped(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // STARTED-only (owner rule): only rounds the user actually played
  // (status IN accepted/resolved) — offered/expired offers are excluded
  // entirely. One pass over the window: counts + exact numeric SUMs. The
  // win-leg payout and house-edge cut come from the paired voucher. SUM(numeric)
  // stays exact in Postgres; we stringify and parse.
  const rows = await db.$queryRaw<
    {
      total_rounds: bigint;
      resolved_rounds: bigint;
      win_count: bigint;
      lose_count: bigint;
      total_staked: string | null;
      total_paid_out: string | null;
      total_forfeited: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      count(*)                                                          AS total_rounds,
      count(*) FILTER (WHERE o.result IS NOT NULL)                      AS resolved_rounds,
      count(*) FILTER (WHERE o.result = 'win')                          AS win_count,
      count(*) FILTER (WHERE o.result = 'lose')                         AS lose_count,
      sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL)         AS total_staked,
      -- Win payout = the ACTUAL minted payout voucher value (NOT a hardcoded
      -- multiplier). A few win vouchers omit the breakdown in metadata; for
      -- those we fall back to the observed ~0.9 × won_amount (the actual
      -- minted ratio on prod), so no win leg is silently dropped from the P&L.
      sum(COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9))
        FILTER (WHERE o.result = 'win')                                 AS total_paid_out,
      sum(o.won_amount_usd) FILTER (WHERE o.result = 'lose')            AS total_forfeited
    FROM battle_double_down_offers o
    LEFT JOIN vouchers v
      ON v.id = o.won_voucher_id
     AND v.origin = 'battle_double_down_payout'
    WHERE ${STARTED_STATUS} AND o.created_at >= ${since}
  `);

  const r = rows[0];
  const totalRounds = Number(r?.total_rounds ?? 0);
  const resolvedRounds = Number(r?.resolved_rounds ?? 0);
  const winCount = Number(r?.win_count ?? 0);
  const loseCount = Number(r?.lose_count ?? 0);
  const totalStaked = num(r?.total_staked ?? null) ?? 0;
  const totalPaidOut = num(r?.total_paid_out ?? null) ?? 0;
  const totalForfeited = num(r?.total_forfeited ?? null) ?? 0;
  // Net house P&L = forfeited − payouts. Real money flows ONLY — the house
  // edge is in the win probability, so NO edge/house-cut term is added (that
  // would double-count).
  const netHousePnl = totalForfeited - totalPaidOut;

  return {
    totalRounds,
    resolvedRounds,
    winCount,
    loseCount,
    winRate: resolvedRounds > 0 ? winCount / resolvedRounds : null,
    totalStaked,
    totalPaidOut,
    totalForfeited,
    netHousePnl,
  };
}

/** KPI-strip aggregate for the /insights/double-down page. Cached on prod. */
export async function getDoubleDownStats(
  period: DoubleDownPeriod,
): Promise<DoubleDownStats> {
  const env = await readDbEnv();
  if (env !== "prod") return computeStats(period);
  // unstable_cache does not let us vary revalidate per-call from outside, so we
  // key the cache on the period AND pick the TTL via a period-specific wrapper.
  return unstable_cache(
    (p: DoubleDownPeriod) => computeStats(p),
    ["double-down-stats-v1", period],
    { revalidate: cacheTtlForDoubleDownPeriod(period), tags: ["double-down"] },
  )(period);
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
    o.status,
    -- On a win, surface the ACTUAL minted payout voucher value; if the voucher
    -- metadata omits it (a few rows do — verified on prod), fall back to the
    -- observed ~0.9 × won_amount so the row still shows a payout instead of a
    -- blank. Non-win rows resolve to NULL → "—". House-edge/"house cut" is NOT
    -- surfaced anywhere (the edge is in the win probability, not a per-round cut).
    CASE WHEN o.result = 'win'
      THEN COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9)::text
    END AS payout_amount_usd,
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
}): Promise<DoubleDownLog> {
  const db = await getDb();
  const { period, page, perPage, search } = args;
  const days = daysForDoubleDownPeriodCapped(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // STARTED-only (owner rule): the audit log shows ONLY rounds the user
  // actually played (status IN accepted/resolved) — offered/expired offers
  // never appear. Optional username search (prefix, case-insensitive,
  // parameterized). The window filter seq-scans (tiny table, no created_at
  // index, flagged); the status + username predicates narrow the same scan.
  const trimmed = search.trim().toLowerCase();
  const searchClause = trimmed
    ? Prisma.sql`AND lower(u.username) LIKE ${trimmed + "%"}`
    : Prisma.empty;
  const whereClause = Prisma.sql`WHERE ${STARTED_STATUS} AND o.created_at >= ${since} ${searchClause}`;

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
  const env = await readDbEnv();
  if (env !== "prod") return computeLog(args);
  return unstable_cache(
    (a: typeof args) => computeLog(a),
    [
      "double-down-log-v1",
      args.period,
      String(args.page),
      String(args.perPage),
      args.search.trim().toLowerCase(),
    ],
    { revalidate: cacheTtlForDoubleDownPeriod(args.period), tags: ["double-down"] },
  )(args);
}

// ── SURFACE 2: per-user history (INDEXED lookup) ──────────────────────────────

/**
 * This user's Double Down history — log rows + a compact summary. STARTED-only
 * (owner rule): only rounds the user actually played (status IN
 * accepted/resolved) — a user with only expired offers shows nothing. Filters
 * `user_id` + status so the planner serves it from the (user_id,status) index
 * (EXPLAIN → Bitmap Index Scan). Lazy-loaded by the /users/[id] Gaming tab
 * (kicked only when that tab is active — Active-Timeframe-Only). NOT cached:
 * it is a per-user operational read on an indexed lookup with a small LIMIT,
 * consistent with the other per-user Gaming-tab reads.
 *
 * `limit` bounds the row list; the summary aggregates ALL of this user's
 * STARTED rounds (also via the (user_id,status) index).
 */
export async function getUserDoubleDownHistory(
  userId: string,
  limit = 50,
): Promise<UserDoubleDownHistory> {
  const db = await getDb();

  const [summaryRows, rows] = await Promise.all([
    db.$queryRaw<
      {
        total_rounds: bigint;
        resolved_rounds: bigint;
        win_count: bigint;
        lose_count: bigint;
        total_staked: string | null;
        total_paid_out: string | null;
        total_forfeited: string | null;
      }[]
    >(Prisma.sql`
      SELECT
        count(*)                                                    AS total_rounds,
        count(*) FILTER (WHERE o.result IS NOT NULL)                AS resolved_rounds,
        count(*) FILTER (WHERE o.result = 'win')                    AS win_count,
        count(*) FILTER (WHERE o.result = 'lose')                   AS lose_count,
        sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL)   AS total_staked,
        -- Actual minted payout voucher value on wins (fallback ~0.9 × won when
        -- metadata is absent). No house-edge/"house cut" term — the edge is in
        -- the win probability, not a per-round cut.
        sum(COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9))
          FILTER (WHERE o.result = 'win')                           AS total_paid_out,
        sum(o.won_amount_usd) FILTER (WHERE o.result = 'lose')      AS total_forfeited
      FROM battle_double_down_offers o
      LEFT JOIN vouchers v
        ON v.id = o.won_voucher_id
       AND v.origin = 'battle_double_down_payout'
      WHERE o.user_id = ${userId} AND ${STARTED_STATUS}
    `),
    db.$queryRaw<RawLogRow[]>(Prisma.sql`
      ${LOG_SELECT}
      WHERE o.user_id = ${userId} AND ${STARTED_STATUS}
      ORDER BY o.created_at DESC
      LIMIT ${limit}
    `),
  ]);

  const s = summaryRows[0];
  const resolvedRounds = Number(s?.resolved_rounds ?? 0);
  const winCount = Number(s?.win_count ?? 0);
  const totalStaked = num(s?.total_staked ?? null) ?? 0;
  const totalPaidOut = num(s?.total_paid_out ?? null) ?? 0;
  const totalForfeited = num(s?.total_forfeited ?? null) ?? 0;

  return {
    summary: {
      totalRounds: Number(s?.total_rounds ?? 0),
      resolvedRounds,
      winCount,
      loseCount: Number(s?.lose_count ?? 0),
      winRate: resolvedRounds > 0 ? winCount / resolvedRounds : null,
      totalStaked,
      totalPaidOut,
      netStakedVsPaid: totalStaked - totalPaidOut,
      // Canonical House P&L on this user (matches Insights/dashboard):
      // forfeited − payouts. Real money flows ONLY, NO edge term.
      netHousePnl: totalForfeited - totalPaidOut,
    },
    rows: rows.map(mapLogRow),
  };
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
  forfeited: 0,
  paidOut: 0,
  netHousePnl: 0,
};

async function computeDashboardStats(): Promise<DoubleDownDashboardStats> {
  const db = await getDb();

  // DEV's CANONICAL method (source of truth for the dashboard's game-type
  // counting): start from game_sessions filtered to game_type
  // 'battle_double_down', JOIN game_id → battle_double_down_offers. A
  // game_session row exists ONLY for a PLAYED round (accepted → resolved), so
  // this counts played rounds the same way the dashboard counts pack / battle /
  // upgrader plays. Outcome is read from o.result + o.won_amount_usd; the win
  // payout comes strictly from the paired payout VOUCHER's ACTUAL minted value
  // (origin='battle_double_down_payout') — NOT from any ledger/balance row
  // (there is no real ledger tx for these; voucher_redeemed is reconciliation
  // only), and NOT a hardcoded multiplier. A few win vouchers omit the value in
  // metadata, so payout falls back to the observed ~0.9 × won (COALESCE). There
  // is NO house-edge/"house cut" term — the edge is in the win probability.
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
      forfeited: string | null;
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
      sum(o.won_amount_usd) FILTER (WHERE o.result = 'lose')            AS forfeited,
      sum(COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9))
        FILTER (WHERE o.result = 'win')                                 AS paid_out
    FROM game_sessions gs
    JOIN battle_double_down_offers o ON o.id = gs.game_id
    LEFT JOIN vouchers v
      ON v.id = o.won_voucher_id
     AND v.origin = 'battle_double_down_payout'
    WHERE gs.game_type = 'battle_double_down'
  `);

  const r = rows[0];
  const wins = Number(r?.wins ?? 0);
  const loses = Number(r?.loses ?? 0);
  const resolved = wins + loses;
  const staked = num(r?.staked ?? null) ?? 0;
  const forfeited = num(r?.forfeited ?? null) ?? 0;
  const paidOut = num(r?.paid_out ?? null) ?? 0;
  // Net house P&L = forfeited − payouts. Real money flows ONLY, NO edge term.
  const netHousePnl = forfeited - paidOut;

  return {
    rounds: Number(r?.rounds ?? 0),
    wins,
    loses,
    pending: Number(r?.pending ?? 0),
    uniquePlayers: Number(r?.unique_players ?? 0),
    winRate: resolved > 0 ? wins / resolved : null,
    staked,
    forfeited,
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
  const guarded = async () => {
    const db = await getDb();
    // to_regclass guard: on a DB without the table (e.g. an old snapshot) skip
    // the read and return zeros rather than throwing 42P01 — matches how
    // upgraderMetrics guards its table.
    const exists = await db.$queryRaw<{ reg: string | null }[]>(
      Prisma.sql`SELECT to_regclass('public.battle_double_down_offers')::text AS reg`,
    );
    if (!exists[0]?.reg) return EMPTY_DASHBOARD_STATS;
    return computeDashboardStats();
  };
  const env = await readDbEnv();
  if (env !== "prod") return guarded();
  return unstable_cache(guarded, ["dashboard-double-down-lifetime-v1"], {
    revalidate: 300,
    tags: ["dashboard-lifetime", "double-down"],
  })();
}
