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
 *   on the offer, metadata { payout_amount_usd, house_amount_usd,
 *   won_amount_usd, battle_id, ticket, offer_id }. We join vouchers by the
 *   offer's won_voucher_id to read per-round payout + house-edge cut.
 *   (payout = won − house; user keeps 90%, house takes the 10% edge.)
 *
 * ── House-POV money (CLAUDE.md, STRICT) ──────────────────────────────────────
 *   • payout to a WINNER  = house COST  → 🔴 rose
 *   • a LOSE / forfeit (staked winnings never paid out) = house GAIN → 🟢 emerald
 *   • the 10% house_amount_usd edge cut  = house revenue → 🟢 emerald
 *   • NET house P&L = forfeited + edgeCut − payouts.
 *   Win-rate / probability is NOT stored — it is derived empirically from
 *   `result`. All money is Decimal-safe (numeric → string → Number, never
 *   summed as float in SQL beyond Postgres's own exact numeric SUM).
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
  house_amount_usd: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

/** Decimal-safe numeric→Number; null/NaN guard. */
function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
    houseCutUsd: num(r.house_amount_usd),
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

// ── SURFACE 1: global windowed aggregate (KPI strip) ──────────────────────────

async function computeStats(period: DoubleDownPeriod): Promise<DoubleDownStats> {
  const db = await getDb();
  const days = daysForDoubleDownPeriodCapped(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // One pass over the window: counts + exact numeric SUMs. The win-leg payout
  // and house-edge cut come from the paired voucher (origin filter is redundant
  // with the won_voucher_id join but keeps the join honest if a voucher is ever
  // repurposed). SUM(numeric) stays exact in Postgres; we stringify and parse.
  const rows = await db.$queryRaw<
    {
      total_rounds: bigint;
      accepted_rounds: bigint;
      not_accepted_rounds: bigint;
      resolved_rounds: bigint;
      win_count: bigint;
      lose_count: bigint;
      total_staked: string | null;
      total_paid_out: string | null;
      total_forfeited: string | null;
      total_edge_cut: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      count(*)                                                          AS total_rounds,
      count(*) FILTER (WHERE o.status IN ('accepted','resolved'))       AS accepted_rounds,
      count(*) FILTER (WHERE o.status IN ('offered','expired'))         AS not_accepted_rounds,
      count(*) FILTER (WHERE o.result IS NOT NULL)                      AS resolved_rounds,
      count(*) FILTER (WHERE o.result = 'win')                          AS win_count,
      count(*) FILTER (WHERE o.result = 'lose')                         AS lose_count,
      sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL)         AS total_staked,
      -- payout / house edge come from the paired voucher's metadata when
      -- present; a small number of win rows have a joined voucher whose
      -- metadata blob omits the breakdown (verified read-only on prod). For
      -- those we fall back to the DOCUMENTED flat split (winner keeps 90%,
      -- house takes the 10% edge) so payout + edge always reconcile to
      -- won_amount and the win legs are never silently dropped from the P&L.
      sum(COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9))
        FILTER (WHERE o.result = 'win')                                 AS total_paid_out,
      sum(o.won_amount_usd) FILTER (WHERE o.result = 'lose')            AS total_forfeited,
      sum(COALESCE((v.metadata->>'house_amount_usd')::numeric, o.won_amount_usd * 0.1))
        FILTER (WHERE o.result = 'win')                                 AS total_edge_cut
    FROM battle_double_down_offers o
    LEFT JOIN vouchers v
      ON v.id = o.won_voucher_id
     AND v.origin = 'battle_double_down_payout'
    WHERE o.created_at >= ${since}
  `);

  const r = rows[0];
  const totalRounds = Number(r?.total_rounds ?? 0);
  const acceptedRounds = Number(r?.accepted_rounds ?? 0);
  const notAcceptedRounds = Number(r?.not_accepted_rounds ?? 0);
  const resolvedRounds = Number(r?.resolved_rounds ?? 0);
  const winCount = Number(r?.win_count ?? 0);
  const loseCount = Number(r?.lose_count ?? 0);
  const totalStaked = num(r?.total_staked ?? null) ?? 0;
  const totalPaidOut = num(r?.total_paid_out ?? null) ?? 0;
  const totalForfeited = num(r?.total_forfeited ?? null) ?? 0;
  const totalEdgeCut = num(r?.total_edge_cut ?? null) ?? 0;
  const netHousePnl = totalForfeited + totalEdgeCut - totalPaidOut;

  return {
    totalRounds,
    acceptedRounds,
    notAcceptedRounds,
    resolvedRounds,
    winCount,
    loseCount,
    winRate: resolvedRounds > 0 ? winCount / resolvedRounds : null,
    totalStaked,
    totalPaidOut,
    totalForfeited,
    totalEdgeCut,
    netHousePnl,
    houseEdgePct: totalStaked > 0 ? netHousePnl / totalStaked : null,
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
    -- On a win, surface the voucher's payout / house-edge breakdown; if the
    -- voucher metadata omits it (a few rows do — verified on prod), fall back
    -- to the documented flat 90/10 split so the row still shows a payout +
    -- house cut instead of a blank. Non-win rows resolve to NULL → "—".
    CASE WHEN o.result = 'win'
      THEN COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9)::text
    END AS payout_amount_usd,
    CASE WHEN o.result = 'win'
      THEN COALESCE((v.metadata->>'house_amount_usd')::numeric, o.won_amount_usd * 0.1)::text
    END AS house_amount_usd,
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

  // Optional username search (exact-or-prefix, case-insensitive, parameterized).
  // The window filter alone seq-scans (no created_at index, flagged); the
  // username predicate further narrows in the same scan.
  const trimmed = search.trim().toLowerCase();
  const searchClause = trimmed
    ? Prisma.sql`AND lower(u.username) LIKE ${trimmed + "%"}`
    : Prisma.empty;
  const whereClause = Prisma.sql`WHERE o.created_at >= ${since} ${searchClause}`;

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
 * This user's Double Down history — log rows + a compact summary. Filters
 * `user_id` so the planner serves it from the (user_id,status) index
 * (EXPLAIN → Bitmap Index Scan). Lazy-loaded by the /users/[id] Gaming tab
 * (kicked only when that tab is active — Active-Timeframe-Only). NOT cached:
 * it is a per-user operational read on an indexed lookup with a small LIMIT,
 * consistent with the other per-user Gaming-tab reads.
 *
 * `limit` bounds the row list; the summary aggregates ALL of this user's
 * rounds (also via the user_id index).
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
      }[]
    >(Prisma.sql`
      SELECT
        count(*)                                                    AS total_rounds,
        count(*) FILTER (WHERE o.result IS NOT NULL)                AS resolved_rounds,
        count(*) FILTER (WHERE o.result = 'win')                    AS win_count,
        count(*) FILTER (WHERE o.result = 'lose')                   AS lose_count,
        sum(o.won_amount_usd) FILTER (WHERE o.result IS NOT NULL)   AS total_staked,
        -- Same documented 90/10 fallback as computeStats: use the voucher
        -- payout when present, else won_amount * 0.9 (winner keeps 90%).
        sum(COALESCE((v.metadata->>'payout_amount_usd')::numeric, o.won_amount_usd * 0.9))
          FILTER (WHERE o.result = 'win')                           AS total_paid_out
      FROM battle_double_down_offers o
      LEFT JOIN vouchers v
        ON v.id = o.won_voucher_id
       AND v.origin = 'battle_double_down_payout'
      WHERE o.user_id = ${userId}
    `),
    db.$queryRaw<RawLogRow[]>(Prisma.sql`
      ${LOG_SELECT}
      WHERE o.user_id = ${userId}
      ORDER BY o.created_at DESC
      LIMIT ${limit}
    `),
  ]);

  const s = summaryRows[0];
  const resolvedRounds = Number(s?.resolved_rounds ?? 0);
  const winCount = Number(s?.win_count ?? 0);
  const totalStaked = num(s?.total_staked ?? null) ?? 0;
  const totalPaidOut = num(s?.total_paid_out ?? null) ?? 0;

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
    },
    rows: rows.map(mapLogRow),
  };
}
