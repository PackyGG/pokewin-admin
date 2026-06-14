import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";

/**
 * Per-user SHARD/COIN WINNINGS — the secondary-currency wins a single user
 * collected, tagged by the game that paid them out. Surfaced on the
 * /users/[id] Gaming tab beside the USD ledger activity.
 *
 * WHAT THIS READS
 * ───────────────
 * The same `coin_transactions` ledger that backs the /rewards/shards
 * economy stats (see src/lib/queries/shard-stats.ts) — every coin/shard
 * bet, payout, grant, refund and rain win lands there with a positive
 * `amount` magnitude and a `balance_before` / `balance_after` audit pair.
 * This module scopes to one `user_id` and keeps ONLY the WINNING (payout)
 * types, mapping each enum member to a coarse SOURCE TAG so an admin can
 * see WHERE the user's shards came from (Packs / Battles / Upgrader / Rain).
 *
 * WINNING types → source tag (everything else is excluded):
 *   coin_pack_payout                      → Packs
 *   coin_battle_payout + coin_battle_refund → Battles
 *   coin_upgrader_payout                  → Upgrader
 *   coin_rain_win                         → Rain
 *
 * EXCLUDED (not game winnings): bets (`coin_*_bet`), grants
 * (`coin_deposit_grant` / `coin_admin_adjustment`), and `coin_rain_tip`.
 *
 * House-POV note: coins/shards are a SECONDARY, wager-earned currency, NOT
 * USD — figures are presented neutrally (cyan) and are NEVER summed into a
 * USD total. They have no direct cash P&L on this surface.
 *
 * SCHEMA DRIFT (CRITICAL)
 * ───────────────────────
 * `coin_transactions` exists on the migrated DEV/sweepstakes schema but NOT
 * on every connected DB — the live prod game DB currently has no such table,
 * so any query against it throws `42P01 relation does not exist`. This
 * module probes the connected DB once (cached 5 min, keyed per prod/dev env)
 * and returns `{ available: false }` when the table is absent, so the
 * section self-hides instead of crashing. Same self-healing guard as
 * shard-stats.ts.
 *
 * READ-ONLY. SELECT + `to_regclass` introspection only — no writes, no
 * game-data mutation. Safe against the live production DB.
 */

// ─── Source-tag model ─────────────────────────────────────────────────

/** Coarse game source a shard win came from. */
export type ShardWinSource = "packs" | "battles" | "upgrader" | "rain";

/**
 * Maps a winning `coin_transactions.type` to its source tag. Returns null
 * for any type that is NOT a game winning (bets, grants, rain tips, or a
 * future unmapped member) so the caller drops it cleanly.
 */
function sourceForWinType(type: string): ShardWinSource | null {
  switch (type) {
    case "coin_pack_payout":
      return "packs";
    case "coin_battle_payout":
    case "coin_battle_refund":
      return "battles";
    case "coin_upgrader_payout":
      return "upgrader";
    case "coin_rain_win":
      return "rain";
    default:
      return null;
  }
}

/** The enum members we treat as winnings (drives the SQL `IN (...)` list). */
const WIN_TYPES = [
  "coin_pack_payout",
  "coin_battle_payout",
  "coin_battle_refund",
  "coin_upgrader_payout",
  "coin_rain_win",
] as const;

/** Display label for a source tag. */
export function shardWinSourceLabel(source: ShardWinSource): string {
  switch (source) {
    case "packs":
      return "Packs";
    case "battles":
      return "Battles";
    case "upgrader":
      return "Upgrader";
    case "rain":
      return "Rain";
  }
}

// ─── Result shape ─────────────────────────────────────────────────────

/** One source rolled up: total shards won + how many wins fed it. */
export type ShardWinSourceRow = {
  source: ShardWinSource;
  label: string;
  /** Sum of |amount| in shards won from this source. */
  total: number;
  /** Number of winning ledger rows from this source. */
  count: number;
  /** Distinct coin game sessions that produced a win from this source. */
  sessions: number;
};

/** One recent winning row for the optional list (newest first). */
export type ShardWinEntry = {
  id: string;
  source: ShardWinSource;
  sourceLabel: string;
  /** |amount| in shards. */
  amount: number;
  createdAt: string;
};

export type ShardWinningsAvailable = {
  available: true;
  /** Total shards won across all sources. */
  totalShards: number;
  /** Total winning ledger rows. */
  totalWins: number;
  /** Per-source breakdown, sorted by total desc. */
  sources: ShardWinSourceRow[];
  /** Most-recent winnings (capped), newest first. */
  recent: ShardWinEntry[];
};

export type ShardWinningsResult =
  | ShardWinningsAvailable
  | { available: false };

// ─── Schema probe (mirrors shard-stats.ts) ────────────────────────────

const probeCoinTableCached = unstable_cache(
  async (): Promise<boolean> => {
    const db = await getDb();
    try {
      const r = await db.$queryRaw<{ exists: string | null }[]>`
        SELECT to_regclass('public.coin_transactions')::text AS exists`;
      return r[0]?.exists != null;
    } catch (err) {
      console.error(
        "[users-shard-winnings] coin_transactions probe failed, treating as absent:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  },
  ["users-shard-winnings-coin-table-probe-v1"],
  { revalidate: 300 },
);

// ─── Core query (uncached) ────────────────────────────────────────────

/** How many recent winnings to surface in the list. */
const RECENT_LIMIT = 25;

type RawSourceRow = {
  type: string;
  count: bigint | number;
  total: string | number | null;
  sessions: bigint | number;
};

type RawRecentRow = {
  id: string;
  type: string;
  amount: string | number | null;
  created_at: Date | string;
};

async function queryUserShardWinnings(
  userId: string,
): Promise<ShardWinningsResult> {
  const hasTable = await probeCoinTableCached();
  if (!hasTable) return { available: false };

  const db = await getDb();
  // Fixed WIN_TYPES constants (no user input) passed as a parameterised text
  // array — `type::text = ANY($winTypes)` is the canonical Prisma-safe way to
  // bind a list, so there is no injection surface even though the user_id is
  // also bound.
  const winTypes: string[] = [...WIN_TYPES];

  // Per-type rollup for this user. `amount` is a positive magnitude, so we
  // sum it directly. game_session_id can be null (e.g. rain) — COUNT(DISTINCT
  // …) ignores nulls, which is the desired "distinct sessions" semantics.
  const rows = await db.$queryRaw<RawSourceRow[]>`
    SELECT
      type::text AS type,
      COUNT(*)::bigint AS count,
      COALESCE(SUM(amount), 0)::text AS total,
      COUNT(DISTINCT game_session_id)::bigint AS sessions
    FROM coin_transactions
    WHERE user_id = ${userId}
      AND type::text = ANY(${winTypes})
    GROUP BY type::text`;

  const recentRows = await db.$queryRaw<RawRecentRow[]>`
    SELECT id::text AS id, type::text AS type, amount::text AS amount,
           created_at
    FROM coin_transactions
    WHERE user_id = ${userId}
      AND type::text = ANY(${winTypes})
    ORDER BY created_at DESC
    LIMIT ${RECENT_LIMIT}`;

  return aggregate(rows, recentRows);
}

function aggregate(
  rows: RawSourceRow[],
  recentRows: RawRecentRow[],
): ShardWinningsResult {
  const bySource = new Map<ShardWinSource, ShardWinSourceRow>();
  let totalShards = 0;
  let totalWins = 0;

  for (const r of rows) {
    const source = sourceForWinType(r.type);
    if (!source) continue;
    const total = Number(r.total ?? 0);
    const count = Number(r.count);
    const sessions = Number(r.sessions);
    totalShards += total;
    totalWins += count;

    const existing = bySource.get(source);
    if (existing) {
      existing.total += total;
      existing.count += count;
      // battle_payout + battle_refund both map to "battles" and can carry
      // different sessions; sum is a safe upper bound for the display count.
      existing.sessions += sessions;
    } else {
      bySource.set(source, {
        source,
        label: shardWinSourceLabel(source),
        total,
        count,
        sessions,
      });
    }
  }

  const sources = Array.from(bySource.values()).sort(
    (a, b) => b.total - a.total,
  );

  const recent: ShardWinEntry[] = recentRows
    .map((r) => {
      const source = sourceForWinType(r.type);
      if (!source) return null;
      return {
        id: r.id,
        source,
        sourceLabel: shardWinSourceLabel(source),
        amount: Number(r.amount ?? 0),
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
      } satisfies ShardWinEntry;
    })
    .filter((e): e is ShardWinEntry => e !== null);

  return { available: true, totalShards, totalWins, sources, recent };
}

// ─── Env-keyed cache wrapper (mirrors shard-stats.ts) ──────────────────
//
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope, so
// `cookies()` (and thus `readDbEnv` inside getDb()) falls back to "prod".
// Caching a dev-toggled request would serve PROD data to a dev admin. So:
// cache ONLY on prod (the default + hot path); a dev-toggled admin runs the
// query directly so they always see live dev data. Identical reasoning to
// shard-stats.ts / users-detail-cache.ts.

const cachedByUser = unstable_cache(
  queryUserShardWinnings,
  ["users-shard-winnings-v1"],
  { revalidate: 60, tags: ["users-shard-winnings"] },
);

/**
 * Public entry point. Returns the per-user shard winnings tagged by source.
 * Cached 60s on prod; direct (uncached) on a dev-toggled admin so they see
 * live dev data. ACTIVE-TIMEFRAME-ONLY: the caller kicks this ONLY when the
 * Gaming tab is active.
 */
export async function getUserShardWinnings(
  userId: string,
): Promise<ShardWinningsResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryUserShardWinnings(userId);
  return cachedByUser(userId);
}

// ════════════════════════════════════════════════════════════════════════
//  SHARD-PACK OPENS — the SPEND side of the coin economy for one user.
// ════════════════════════════════════════════════════════════════════════
//
// A "shard pack" is a pack BOUGHT WITH SHARDS (the secondary, wager-earned
// currency) instead of USD. Opening one is recorded entirely in the SAME
// `coin_transactions` ledger, NOT in the USD `ledger_transactions`:
//
//   • coin_pack_bet     — shards SPENT on the open ("Opened N pack(s) with
//                         coins"). One row per open session, `amount` is the
//                         positive shard magnitude spent.
//   • coin_pack_payout  — the VALUE WON from that open, ALSO in shards (the
//                         coin value the pack(s) returned). Same
//                         `game_session_id` as the bet. A losing/zero open
//                         has NO payout row at all.
//
// Both legs are bound by `game_session_id`, so a LEFT JOIN bet→payout on
// that column reconstructs each open with its spend + win (payout 0 when the
// open returned nothing). `amount` on both is a positive shard magnitude, so
// net = won − spent.
//
// HOUSE-POV / UNIT: shards are NOT dollars. Spend + win here are both SHARDS
// and are presented neutrally (cyan) — never summed into any USD total. The
// USD P&L of the underlying cards is already accounted for in the inventory /
// USD ledger; this surface is purely the shard wager flow so an admin can see
// how many shards a user spent and won opening shard packs.
//
// Same read-only drift-guard (`probeCoinTableCached`) + env-keyed cache as
// the winnings query above. SELECT-only. Safe against the live prod DB
// (returns `{ available: false }` when `coin_transactions` is absent).

/** One shard-pack open: shards spent + value (shards) won, paired by session. */
export type ShardPackOpenEntry = {
  /** game_session_id of the open (stable key). */
  id: string;
  /** Shards spent on this open (|coin_pack_bet.amount|). */
  spent: number;
  /** Value won, in shards (|coin_pack_payout.amount|; 0 when no payout). */
  won: number;
  /** Number of packs opened in this session (from metadata.pack_ids). */
  packs: number;
  createdAt: string;
};

export type ShardPackOpensAvailable = {
  available: true;
  /** Distinct shard-pack open sessions. */
  totalOpens: number;
  /** Total shards spent across all opens. */
  totalSpent: number;
  /** Total value won (shards) across all opens. */
  totalWon: number;
  /** Most-recent opens (capped), newest first. */
  recent: ShardPackOpenEntry[];
};

export type ShardPackOpensResult =
  | ShardPackOpensAvailable
  | { available: false };

type RawOpenRow = {
  id: string;
  spent: string | number | null;
  won: string | number | null;
  packs: bigint | number | null;
  created_at: Date | string;
};

type RawOpenTotals = {
  opens: bigint | number;
  spent: string | number | null;
  won: string | number | null;
};

async function queryUserShardPackOpens(
  userId: string,
): Promise<ShardPackOpensResult> {
  const hasTable = await probeCoinTableCached();
  if (!hasTable) return { available: false };

  const db = await getDb();

  // Totals across ALL opens (uncapped count/sums). Pair each bet to its
  // payout by game_session_id (LEFT JOIN → 0 won when the open returned
  // nothing). game_session_id can in theory repeat for a payout, so collapse
  // payouts to one summed row per session first.
  const totalsRows = await db.$queryRaw<RawOpenTotals[]>`
    WITH bets AS (
      SELECT game_session_id, SUM(amount) AS spent
      FROM coin_transactions
      WHERE user_id = ${userId}
        AND type::text = 'coin_pack_bet'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    ),
    pays AS (
      SELECT game_session_id, SUM(amount) AS won
      FROM coin_transactions
      WHERE user_id = ${userId}
        AND type::text = 'coin_pack_payout'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    )
    SELECT
      COUNT(*)::bigint AS opens,
      COALESCE(SUM(b.spent), 0)::text AS spent,
      COALESCE(SUM(p.won), 0)::text AS won
    FROM bets b
    LEFT JOIN pays p USING (game_session_id)`;

  const recentRows = await db.$queryRaw<RawOpenRow[]>`
    WITH bets AS (
      SELECT
        game_session_id,
        SUM(amount) AS spent,
        MAX(created_at) AS created_at,
        -- pack count from the metadata.pack_ids array on the bet row
        MAX(COALESCE(jsonb_array_length(metadata -> 'pack_ids'), 0)) AS packs
      FROM coin_transactions
      WHERE user_id = ${userId}
        AND type::text = 'coin_pack_bet'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    ),
    pays AS (
      SELECT game_session_id, SUM(amount) AS won
      FROM coin_transactions
      WHERE user_id = ${userId}
        AND type::text = 'coin_pack_payout'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    )
    SELECT
      b.game_session_id::text AS id,
      b.spent::text AS spent,
      COALESCE(p.won, 0)::text AS won,
      b.packs::bigint AS packs,
      b.created_at
    FROM bets b
    LEFT JOIN pays p USING (game_session_id)
    ORDER BY b.created_at DESC
    LIMIT ${RECENT_LIMIT}`;

  const t = totalsRows[0];
  const totalOpens = t ? Number(t.opens) : 0;
  if (totalOpens === 0) {
    return { available: true, totalOpens: 0, totalSpent: 0, totalWon: 0, recent: [] };
  }

  const recent: ShardPackOpenEntry[] = recentRows.map((r) => ({
    id: r.id,
    spent: Number(r.spent ?? 0),
    won: Number(r.won ?? 0),
    packs: Number(r.packs ?? 0),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  }));

  return {
    available: true,
    totalOpens,
    totalSpent: Number(t?.spent ?? 0),
    totalWon: Number(t?.won ?? 0),
    recent,
  };
}

const cachedOpensByUser = unstable_cache(
  queryUserShardPackOpens,
  ["users-shard-pack-opens-v1"],
  { revalidate: 60, tags: ["users-shard-pack-opens"] },
);

/**
 * Public entry point for a user's shard-pack OPENS (shards spent + value
 * won, both in shards). Cached 60s on prod; direct on a dev-toggled admin.
 * ACTIVE-TIMEFRAME-ONLY: kicked ONLY when the Gaming tab is active.
 */
export async function getUserShardPackOpens(
  userId: string,
): Promise<ShardPackOpensResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryUserShardPackOpens(userId);
  return cachedOpensByUser(userId);
}
