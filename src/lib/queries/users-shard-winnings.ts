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
