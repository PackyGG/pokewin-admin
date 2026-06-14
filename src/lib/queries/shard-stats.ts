import "server-only";
import {
  getCoinsEconomy,
  type CoinCategoryRow,
  type CoinsPeriod,
} from "@/lib/queries/insights-coins";

/**
 * Coin / shard secondary-currency usage stats for the /rewards/shards
 * surface.
 *
 * SINGLE SOURCE OF TRUTH (why this module no longer queries directly)
 * ──────────────────────────────────────────────────────────────────
 * The shard PACKS listed on /rewards/shards are bought & opened with the
 * secondary, wager-earned currency whose ONLY usage ledger is
 * `coin_transactions`. The canonical `getCoinsEconomy` (insights-coins.ts)
 * reads exactly that ledger — window model, earned/spent/netHouse/issued
 * math, per-type breakdown.
 *
 * This module used to run its OWN copy of that `coin_transactions` rollup
 * behind its OWN `unstable_cache` (keys `shard-stats-*`). Two independent
 * caches over ONE ledger could hold DIFFERENT snapshots, so two surfaces
 * could DISAGREE on the same figure until a cache expired.
 *
 * The fix: this module now DELEGATES to the canonical `getCoinsEconomy` and
 * projects out the subset /rewards/shards renders, so there is exactly ONE
 * cached economy value per window. (The standalone /insights/coins page that
 * also consumed it has since been removed; /rewards/shards is now the sole
 * consumer.) No SQL, no second cache, no second `coin_transactions` probe
 * here: the coins module owns the ledger read (incl. its env-keyed
 * schema-drift probe + per-period cache), this module is a thin,
 * type-preserving projection.
 *
 * READ-ONLY (inherited from `getCoinsEconomy`): SELECT + `to_regclass`
 * introspection only — no writes, no game-data mutation. Safe against the live
 * production DB.
 */

// ─── Period model ─────────────────────────────────────────────────────
//
// Kept identical to (and assignable to) `CoinsPeriod` so the delegation is a
// straight pass-through with no remapping.

export type ShardStatsPeriod = CoinsPeriod;

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

// ─── Result shape ─────────────────────────────────────────────────────
//
// A SUBSET of `CoinsEconomyAvailable` (no supply snapshot, no daily trend —
// the /rewards/shards panel doesn't render those). Field-for-field the same
// types + meaning as the coins module, so the projection below is a plain
// pick, never a recompute.

/** One `coin_transactions.type` rolled up for the breakdown table. */
export type ShardCategoryRow = CoinCategoryRow;

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
   * negative ⇒ games paid out more than users wagered.
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

/**
 * Public entry point. Returns the coin/shard usage stats for one window by
 * PROJECTING the canonical global economy (`getCoinsEconomy`) down to the
 * subset /rewards/shards renders — so both pages share ONE cache entry and can
 * never disagree. Caching, the env-keyed schema-drift probe, and
 * active-timeframe-only loading all live in `getCoinsEconomy`; this is a thin
 * pass-through.
 */
export async function getShardStats(
  period: ShardStatsPeriod,
): Promise<ShardStatsResult> {
  const economy = await getCoinsEconomy(period);
  if (!economy.available) {
    return { available: false, period };
  }
  return {
    available: true,
    period: economy.period,
    earned: economy.earned,
    spent: economy.spent,
    netHouse: economy.netHouse,
    txCount: economy.txCount,
    activeUsers: economy.activeUsers,
    issuedToUsers: economy.issuedToUsers,
    categories: economy.categories,
  };
}
