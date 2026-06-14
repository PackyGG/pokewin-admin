import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";

/**
 * Coin / shard secondary-currency usage stats for the /rewards/shards
 * surface.
 *
 * WHAT THIS READS
 * ───────────────
 * The shard PACKS listed on /rewards/shards are bought & opened with the
 * `balances.shards` wallet (a wager-earned currency). The closest — and
 * only — usage LEDGER for that secondary-currency economy in the game DB
 * is `coin_transactions`: every coin/shard bet, payout, grant, refund,
 * rain tip/win and admin adjustment lands there with a positive `amount`
 * magnitude and a `balance_before` / `balance_after` pair (the canonical
 * audit chain). Direction (earned vs spent) is read from the SIGN of
 * `balance_after - balance_before` so a future enum member is classified
 * correctly without a hard-coded type list.
 *
 * House-POV note: this is the SECONDARY (coin/shard) currency, not USD.
 * Coins/shards are wager-earned and have no direct cash P&L on this
 * surface, so the numbers are presented neutrally (cyan/amber). The one
 * cash-adjacent signal — admin GRANTS of coins to users — is the closest
 * thing to a house cost and is surfaced separately.
 *
 * SCHEMA DRIFT (CRITICAL)
 * ───────────────────────
 * `coin_transactions` (and `balances.shards`) exist on the migrated
 * DEV/sweepstakes schema but NOT on every connected DB — production
 * (the live game DB) currently has NO `coin_transactions` table, so any
 * query against it throws `42P01 relation does not exist`. This module
 * probes the connected DB once (cached 5 min, keyed per prod/dev env)
 * and returns a `{ available: false }` result when the table is absent,
 * so the page degrades to a clear "not on this DB" panel instead of
 * crashing. Same self-healing pattern as
 * `insights-streamers/_schema-probe.ts`.
 *
 * READ-ONLY. SELECT + `to_regclass` introspection only — no writes, no
 * game-data mutation. Safe against the live production DB.
 */

// ─── Period model ─────────────────────────────────────────────────────

export type ShardStatsPeriod = "24h" | "7d" | "30d" | "all";

export function parseShardStatsPeriod(
  value: string | undefined,
): ShardStatsPeriod {
  switch (value) {
    case "24h":
    case "7d":
    case "30d":
    case "all":
      return value;
    default:
      return "30d";
  }
}

export function shardStatsPeriodLabel(p: ShardStatsPeriod): string {
  switch (p) {
    case "24h":
      return "Last 24 hours";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "all":
      return "All time";
  }
}

/**
 * Lifetime lookback cap (days) so the `all` window never triggers an
 * unbounded full-history scan — the pattern CLAUDE.md ("Performance &
 * Daten-Laden") forbids. Mirrors the reward-insights 365d cap. The coin
 * ledger is young (launched 2026-06), so 365d covers all activity while
 * keeping the cold cache fill tractable.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

/** Day count for the window. `all` resolves to the capped lookback. */
function daysForPeriod(p: ShardStatsPeriod): number {
  switch (p) {
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

function cacheTtlForPeriod(p: ShardStatsPeriod): number {
  return p === "all" ? 300 : 60;
}

// ─── Result shape ─────────────────────────────────────────────────────

/**
 * Currency-ISSUANCE types — coins/shards the HOUSE MINTED INTO existence and
 * handed to users, NOT coins a game paid out. These are house-funded issuance
 * (a liability the house created), not bets-vs-payouts game flow, so they must
 * be kept OUT of the `earned`/`netHouse` game-flow math and surfaced as a
 * separate ISSUANCE line. Kept IN SYNC with `insights-coins.ts` (same surface,
 * same ledger) and mirrors the grant-vs-winning split in
 * `users-shard-winnings.ts`.
 *
 *   • coin_deposit_grant            — coins granted on a deposit (always +).
 *   • coin_admin_adjustment (+ leg) — an admin crediting coins to a user.
 *
 * Only the POSITIVE (earned) leg of `coin_admin_adjustment` is issuance; its
 * negative leg is a claw-back and stays in the spent/game side.
 */
const ISSUANCE_TYPES: ReadonlySet<string> = new Set([
  "coin_deposit_grant",
  "coin_admin_adjustment",
]);

/**
 * True when a ledger row is house→user currency ISSUANCE (minted coins), not a
 * game payout. Only the EARNED leg of an issuance type counts.
 */
function isIssuance(type: string, direction: "earned" | "spent"): boolean {
  return direction === "earned" && ISSUANCE_TYPES.has(type);
}

/** One `coin_transactions.type` rolled up for the breakdown table. */
export type ShardCategoryRow = {
  type: string;
  /** Friendly label derived from the raw enum member. */
  label: string;
  /** "earned" (balance went up) | "spent" (balance went down). */
  direction: "earned" | "spent";
  /** Number of ledger rows in the window. */
  count: number;
  /** Sum of |amount| in coins/shards over the window. */
  total: number;
  /** Distinct users with at least one row of this type in the window. */
  users: number;
  /**
   * True when this row is house→user currency ISSUANCE (a minted grant), not
   * game flow. Issuance is EXCLUDED from the earned/netHouse game-flow totals
   * and shown separately, so the UI can flag it instead of folding it into
   * "earned".
   */
  isIssuance: boolean;
};

export type ShardStatsAvailable = {
  available: true;
  period: ShardStatsPeriod;
  /**
   * Coins/shards a GAME paid out to users (balance increases) in the window —
   * i.e. game WINS only. EXCLUDES house-funded issuance (`coin_deposit_grant`
   * and the positive leg of `coin_admin_adjustment`), which is surfaced
   * separately as `issuedToUsers`. This is what feeds `netHouse`.
   */
  earned: number;
  /** Total coins/shards SPENT by users (balance decreases) in the window. */
  spent: number;
  /**
   * Net house GAME flow in coins/shards = spent − earned (issuance EXCLUDED).
   * Positive ⇒ users net lost coins into games (house took in / self-funding);
   * negative ⇒ games paid out more than users wagered. A healthy economy is no
   * longer dragged negative just because the house MINTED coins (issuance lands
   * in `issuedToUsers`, not here).
   */
  netHouse: number;
  /** Total ledger rows in the window. */
  txCount: number;
  /** Distinct users with any coin/shard activity in the window. */
  activeUsers: number;
  /**
   * Coins/shards the HOUSE ISSUED to users in the window — minted grants, NOT
   * game payouts: `coin_deposit_grant` + the positive leg of
   * `coin_admin_adjustment`. House-funded issuance (a created liability), shown
   * as its OWN line so it is never mistaken for game flow.
   */
  issuedToUsers: number;
  /** Per-type breakdown, sorted by total desc. */
  categories: ShardCategoryRow[];
};

export type ShardStatsResult =
  | ShardStatsAvailable
  | { available: false; period: ShardStatsPeriod };

// ─── Schema probe ─────────────────────────────────────────────────────

const probeCoinTableCached = unstable_cache(
  async (): Promise<boolean> => {
    const db = await getDb();
    try {
      const r = await db.$queryRaw<{ exists: string | null }[]>`
        SELECT to_regclass('public.coin_transactions')::text AS exists`;
      return r[0]?.exists != null;
    } catch (err) {
      console.error(
        "[shard-stats] coin_transactions probe failed, treating as absent:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  },
  ["shard-stats-coin-table-probe-v1"],
  { revalidate: 300 },
);

// ─── Label mapping ────────────────────────────────────────────────────

/**
 * Friendly label for a `coin_transactions.type`. Falls back to a
 * de-prefixed, title-cased rendering of the raw enum member so a
 * future, not-yet-mapped type still reads cleanly instead of showing a
 * raw `coin_*` token.
 */
function labelForType(type: string): string {
  const known: Record<string, string> = {
    coin_deposit_grant: "Deposit grant",
    coin_pack_bet: "Pack opens",
    coin_pack_payout: "Pack payouts",
    coin_battle_bet: "Battle bets",
    coin_battle_payout: "Battle payouts",
    coin_battle_refund: "Battle refunds",
    coin_upgrader_bet: "Upgrader bets",
    coin_upgrader_payout: "Upgrader payouts",
    coin_admin_adjustment: "Admin adjustments",
    coin_rain_tip: "Rain tips",
    coin_rain_win: "Rain wins",
  };
  if (known[type]) return known[type];
  return type
    .replace(/^coin_/, "")
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ─── Core query (uncached) ────────────────────────────────────────────

type RawCategoryRow = {
  type: string;
  direction: string;
  count: bigint | number;
  total: string | number | null;
  users: bigint | number;
};

async function queryShardStats(
  period: ShardStatsPeriod,
): Promise<ShardStatsResult> {
  const hasTable = await probeCoinTableCached();
  if (!hasTable) return { available: false, period };

  const db = await getDb();
  const days = daysForPeriod(period);

  // Per (type, direction) rollup. Direction is the SIGN of the audited
  // balance delta — ground truth for earned vs spent that needs no
  // hard-coded type list and classifies a split type (admin adjustment,
  // which can be + or −) correctly. `amount` is a positive magnitude, so
  // |amount| == amount; we sum it directly. The window is a parameterised
  // interval (no string interpolation → no injection surface).
  const rows = await db.$queryRaw<RawCategoryRow[]>`
    SELECT
      type::text AS type,
      CASE WHEN balance_after >= balance_before THEN 'earned' ELSE 'spent' END
        AS direction,
      COUNT(*)::bigint AS count,
      COALESCE(SUM(amount), 0)::text AS total,
      COUNT(DISTINCT user_id)::bigint AS users
    FROM coin_transactions
    WHERE created_at >= NOW() - (${days} * INTERVAL '1 day')
    GROUP BY type::text, direction`;

  // GAME-FLOW totals (issuance excluded). `earned` is ONLY coins a game paid
  // out (wins); house-funded issuance (deposit grants + positive admin
  // adjustments) is summed into `issuedToUsers` and kept OUT of earned, so
  // `netHouse = spent − earned` is a pure bets-vs-payouts read.
  let earned = 0;
  let spent = 0;
  let issuedToUsers = 0;
  // Per-type earned/spent magnitudes tracked SEPARATELY so the display badge
  // direction is decided from the FINAL totals (not a half-mutated running
  // sum). A type rarely spans both directions, but admin adjustments do.
  const earnedByType = new Map<string, number>();
  const spentByType = new Map<string, number>();
  const byType = new Map<string, ShardCategoryRow>();

  for (const r of rows) {
    const total = Number(r.total ?? 0);
    const count = Number(r.count);
    const users = Number(r.users);
    const direction = r.direction === "spent" ? "spent" : "earned";
    const issuance = isIssuance(r.type, direction);

    // Game-flow vs issuance: minted grants never touch the earned/netHouse
    // game-flow math — they accumulate into the separate issuance line.
    if (issuance) {
      issuedToUsers += total;
    } else if (direction === "earned") {
      earned += total;
    } else {
      spent += total;
    }

    if (direction === "earned") earnedByType.set(r.type, total);
    else spentByType.set(r.type, total);

    const existing = byType.get(r.type);
    if (existing) {
      existing.count += count;
      existing.total += total;
      // Distinct users can't be summed exactly across direction splits;
      // take the max as a safe lower-bound estimate for the display row.
      existing.users = Math.max(existing.users, users);
    } else {
      byType.set(r.type, {
        type: r.type,
        label: labelForType(r.type),
        direction,
        count,
        total,
        users,
        // Provisional; finalised below once both direction legs are merged.
        isIssuance: issuance,
      });
    }
  }

  // Finalise each display row's badge direction + issuance flag from the FINAL
  // per-type totals (decided at the END, not from a running total). A type is
  // shown "earned" when its earned leg dominates; an issuance type's earned
  // leg is house-funded issuance, so flag the row when that leg dominates.
  for (const row of byType.values()) {
    const earnedLeg = earnedByType.get(row.type) ?? 0;
    const spentLeg = spentByType.get(row.type) ?? 0;
    row.direction = earnedLeg >= spentLeg ? "earned" : "spent";
    row.isIssuance = row.direction === "earned" && ISSUANCE_TYPES.has(row.type);
  }

  const categories = Array.from(byType.values()).sort(
    (a, b) => b.total - a.total,
  );

  // Distinct active users across the whole window (not summable from the
  // grouped rows). Single cheap aggregate, same parameterised window.
  const activeRows = await db.$queryRaw<{ users: bigint | number }[]>`
    SELECT COUNT(DISTINCT user_id)::bigint AS users
    FROM coin_transactions
    WHERE created_at >= NOW() - (${days} * INTERVAL '1 day')`;
  const activeUsers = Number(activeRows[0]?.users ?? 0);

  const txCount = categories.reduce((sum, c) => sum + c.count, 0);

  return {
    available: true,
    period,
    earned,
    spent,
    netHouse: spent - earned,
    txCount,
    activeUsers,
    issuedToUsers,
    categories,
  };
}

// ─── Env-keyed cache wrapper ──────────────────────────────────────────
//
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope,
// so `cookies()` (and thus `readDbEnv`) inside `getDb()` falls back to
// "prod". Caching a dev-toggled request would therefore serve PROD data
// to a dev admin (and the prod-keyed entry would be wrong). So: cache ONLY
// on prod (the default + the hot path); a dev-toggled admin runs the query
// directly so they always see live dev data. Identical reasoning to
// `users-detail-cache.ts`.

const cachedByPeriod: Record<
  ShardStatsPeriod,
  (p: ShardStatsPeriod) => Promise<ShardStatsResult>
> = {
  "24h": unstable_cache(queryShardStats, ["shard-stats-24h-v1"], {
    revalidate: cacheTtlForPeriod("24h"),
    tags: ["shard-stats"],
  }),
  "7d": unstable_cache(queryShardStats, ["shard-stats-7d-v1"], {
    revalidate: cacheTtlForPeriod("7d"),
    tags: ["shard-stats"],
  }),
  "30d": unstable_cache(queryShardStats, ["shard-stats-30d-v1"], {
    revalidate: cacheTtlForPeriod("30d"),
    tags: ["shard-stats"],
  }),
  all: unstable_cache(queryShardStats, ["shard-stats-all-v1"], {
    revalidate: cacheTtlForPeriod("all"),
    tags: ["shard-stats"],
  }),
};

/**
 * Public entry point. Returns the coin/shard usage stats for one window.
 * Cached per-period on prod (60s / 300s); direct (uncached) on a
 * dev-toggled admin so they see live dev data. ACTIVE-TIMEFRAME-ONLY: the
 * caller fetches only the active window — no eager preload of the others.
 */
export async function getShardStats(
  period: ShardStatsPeriod,
): Promise<ShardStatsResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryShardStats(period);
  return cachedByPeriod[period](period);
}
