import "server-only";
import { unstable_cache } from "next/cache";
import { getDb, getProdDb, getDevDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import type { PaginatedResult } from "@/lib/types";
import {
  getCoinsEconomy,
  type CoinsPeriod,
} from "@/lib/queries/insights-coins";

/**
 * GLOBAL shard-pack OPENS — every opening of one of the dedicated SHARD PACKS
 * (the Common / Uncommon / Rare packs that cost SHARDS to open and return a
 * CARD). Powers the /rewards/shard-opens admin surface.
 *
 * WHAT A "SHARD-PACK OPEN" IS (confirmed read-only on the live prod DB, 2026-06-14)
 * ───────────────────────────────────────────────────────────────────────────────
 * The dedicated shard packs are `packs` rows with `pack_type='shard'` (resolved
 * DYNAMICALLY by that predicate — never hard-coded ids — so this stays correct
 * if the packs change). Each has a `shard_cost` (integer shards it costs to
 * open) and returns a CARD, NOT shards.
 *
 * An OPENING is one row in `game_sessions` where:
 *   • game_type = 'pack', and
 *   • game_id   = a shard pack's id   (game_sessions has NO pack_id column —
 *                                       the pack IS the game_id).
 *
 * SHARDS SPENT per open = the pack's `shard_cost` (2 / 5 / 10). There is NO
 * shard "payout" / "won" — opening a shard pack does not pay shards back, it
 * rolls a CARD. So the old "shards won" / "net house (shards)" / "house edge
 * over shard flow" concept does NOT apply to these packs and is intentionally
 * dropped.
 *
 * CARD each open produced → its USD value, via the provably-fair chain:
 *   provably_fair_results.game_session_id = the open's game_sessions.id
 *   → provably_fair_results.inventory_item_id → user_inventory.id
 *   → user_inventory.value_at_obtained  (Decimal USD — the card's value)
 *   → user_inventory.card_id → cards.name  (the card's name)
 *
 * Read-only prod evidence (2026-06-14, live DB): 31 opens total
 * (Rare 19 · Common 7 · Uncommon 5), ALL 31 with a linked inventory item
 * (exactly one PF row per session — no multiplication), Σ value_at_obtained
 * ≈ $12.23 (Rare $10.87 · Common $1.03 · Uncommon $0.33), 12 unique openers.
 *
 * HOUSE-POV / UNITS
 * ─────────────────
 * Two distinct, never-summed quantities:
 *   • SHARDS SPENT — the secondary, wager-earned currency the user spends to
 *     open. The house takes these in. Shards are NOT money; rendered NEUTRAL
 *     (cyan) since summing them with dollars would be wrong.
 *   • CARD VALUE ($) — the REAL dollars the house pays out as the card the open
 *     rolls into inventory. House cost ⇒ rendered ROSE.
 *
 * SCOPE
 * ─────
 * UNSCOPED — a raw ACTIVITY/AUDIT feed of every shard-pack open (staff/creator
 * opens shown too), not the customer-scoped USD GGR/NGR metric layer.
 *
 * SCHEMA DRIFT (defensive)
 * ────────────────────────
 * `game_sessions` + `packs` exist on the live prod game DB, but a non-migrated
 * DEV env may lack them. This module probes the connected DB once (cached 5
 * min, keyed per prod/dev env) for `packs` + `game_sessions` and returns
 * `{ available: false }` when absent, so the page degrades to a clear panel
 * instead of crashing.
 *
 * READ-ONLY. SELECT + `to_regclass` introspection only — no writes, no
 * game-data mutation. Safe against the live production DB.
 */

// ─── Period model ─────────────────────────────────────────────────────

export type ShardOpensPeriod = "24h" | "7d" | "30d" | "all";

export function parseShardOpensPeriod(
  value: string | undefined,
): ShardOpensPeriod {
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

export function shardOpensPeriodLabel(p: ShardOpensPeriod): string {
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
 * unbounded full-history scan (the pattern CLAUDE.md "Performance &
 * Daten-Laden" forbids). The shard packs launched 2026-06, so 365d covers all
 * activity.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(p: ShardOpensPeriod): number {
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

function cacheTtlForPeriod(p: ShardOpensPeriod): number {
  return p === "all" ? 300 : 60;
}

// ─── Result shapes ────────────────────────────────────────────────────

/**
 * Shard ECONOMY OVERVIEW — the live, window-independent supply snapshot plus
 * the period-scoped flow aggregates, REUSED verbatim from the canonical
 * `getCoinsEconomy` (insights-coins.ts). This is NOT a second rollup: the
 * fields are projected straight off the one-source-of-truth economy module so
 * /rewards/shard-opens can never disagree with the canonical numbers.
 *
 * UNIT: all figures are SHARDS (a secondary, wager-earned currency), NOT USD.
 */
export type ShardEconomyOverview = {
  /** Σ balances.shards across all wallets — live supply, no period. */
  totalShardsHeld: number;
  /** Wallets currently holding > 0 shards — distinct holders, no period. */
  shardHolders: number;
  /** Shards a GAME paid out to users in the window (wins; issuance EXCLUDED). */
  earned: number;
  /** Shards SPENT by users into games in the window. */
  spent: number;
  /** Net house GAME flow in the window = spent − earned (issuance EXCLUDED). */
  netHouse: number;
  /** Shards the HOUSE ISSUED to users in the window (minted grants). */
  issuedToUsers: number;
  /**
   * Customer-only variant of `issuedToUsers` — minted grants with staff +
   * creators + blacklist dropped (canonical customer scope). This is the
   * figure the "minted to users" tile shows, so it genuinely means real
   * customers, not internal/admin grants.
   */
  issuedToUsersCustomers: number;
  /** Distinct users with any shard activity in the window. */
  activeUsers: number;
  /** Total coin/shard ledger rows in the window. */
  txCount: number;
  /**
   * Per-day earned-vs-spent shard trend over the window (feeds the two
   * economy charts). `earned` = shards a game paid out that day (house out),
   * `spent` = shards wagered into games that day (house in). Projected
   * verbatim from `getCoinsEconomy().daily`. The shard ledger is brand-new, so
   * on prod this may currently be a single day — the charts render gracefully
   * with one point.
   */
  daily: { date: string; earned: number; spent: number }[];
};

/** Headline KPIs for one window. */
export type ShardOpensSummary = {
  /** Distinct shard-pack open sessions in the window. */
  totalOpens: number;
  /** Distinct users who opened a shard pack in the window. */
  uniqueOpeners: number;
  /** Total SHARDS spent into opens (Σ pack.shard_cost over opens). House in. */
  totalShardsSpent: number;
  /** Average shards spent per open (shardsSpent / opens; 0 when no opens). */
  avgShardsPerOpen: number;
  /**
   * Σ `user_inventory.value_at_obtained` (USD) of the cards the opens in this
   * window rolled into inventory — the REAL money the house paid out through
   * the shard-pack mechanic, in DOLLARS. House cost ⇒ rendered rose. NEVER
   * summed with the shard figures.
   */
  totalCardValueUsd: number;
  /** Number of inventory cards linked to opens in this window. */
  totalCardCount: number;
};

/** One shard pack rolled up: opens / shards spent / card value $. */
export type ShardPackBreakdownRow = {
  /** packs.id of the shard pack. */
  packId: string;
  /** packs.name (or a short id fallback when the pack row is gone). */
  packName: string;
  /** The pack's shard cost per open. */
  shardCost: number;
  /** Distinct opens of this pack in the window. */
  opens: number;
  /** Total SHARDS spent on this pack's opens (shardCost × opens). House in. */
  shardsSpent: number;
  /** Σ USD card value the opens of this pack rolled into inventory. House out. */
  cardValueUsd: number;
  /** Number of cards pulled from this pack's opens. */
  cardCount: number;
};

/** One individual shard-pack open for the feed (newest first). */
export type ShardPackOpenRow = {
  /** game_sessions.id of the open (stable key). */
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  /** Pack name (Common / Uncommon / Rare). */
  packName: string;
  /** Shards spent on this open (the pack's shard_cost). House in. */
  shardsSpent: number;
  /** Name of the card this open pulled (null when not linked yet). */
  cardName: string | null;
  /**
   * USD value of the CARD this open rolled into inventory
   * (`user_inventory.value_at_obtained`). REAL money out (house cost), in
   * DOLLARS — never a shard figure. 0 when no inventory card is linked yet.
   */
  cardValueUsd: number;
  /** Number of inventory cards linked to this open. */
  cardCount: number;
  createdAt: string;
};

export type ShardOpensAvailable = {
  available: true;
  period: ShardOpensPeriod;
  summary: ShardOpensSummary;
  /** Per-pack breakdown, sorted by opens desc (top packs first). */
  packs: ShardPackBreakdownRow[];
  /** Paginated feed of individual opens (newest first). */
  feed: PaginatedResult<ShardPackOpenRow>;
};

/**
 * Shard ECONOMY OVERVIEW result — the canonical supply/flow snapshot for the
 * window, reused from `getCoinsEconomy`. `null` when the coin/shard ledger is
 * absent on the connected DB so the overview self-hides without crashing.
 */
export type ShardEconomyResult = ShardEconomyOverview | null;

/**
 * TRUE integer-SHARD given-out snapshot — the headline the owner asked for.
 *
 * CRITICAL: `shards` and "coins" are TWO DIFFERENT currencies on this DB,
 * easy to conflate because the shard-economy panel borrows the coin ledger.
 *   • `balances.shards` is an INTEGER wager currency (Σ ≈ 114 held). It has NO
 *     transaction ledger table — there is no `shard_transactions` on prod.
 *   • `coin_transactions` (numeric, ≈ USD-pegged cents) is the ledger for the
 *     SEPARATE "coins" currency (`balances.coin_available_balance`), NOT for
 *     shards. The `coin_deposit_grant` ≈ 1,662 figure is COINS, not shards.
 *     Verified read-only on prod 2026-06-14: per-user latest
 *     `coin_transactions.balance_after` reconciles byte-for-byte to
 *     `coin_available_balance` (Σ 1588.15 ≈ 1588.16), never to `shards`.
 *
 * So there is no minted/earned shard LEDGER to read. But the only place shards
 * are SPENT is opening shard packs (the only shard sink: no other game type
 * consumes shards, and shards have no earn-back trail), so:
 *
 *     shards given out  =  shards still held  +  shards spent on opens
 *
 * This is the owner's own reconciliation (held ≈ 110 + spent ≈ 261). Verified
 * read-only on prod 2026-06-14: held = 117, spent-on-opens = 263 (Σ
 * pack.shard_cost over 37 shard-pack opens), so given-out = 380.
 *
 * UNIT: integer SHARDS, never USD — never summed with any coin/dollar figure.
 */
export type ShardGivenOut = {
  /** Σ `balances.shards` across all wallets — live circulating supply. */
  held: number;
  /** Wallets currently holding > 0 shards. */
  holders: number;
  /**
   * Σ `packs.shard_cost` over every shard-pack open (the only shard sink) —
   * lifetime, capped at the 365d lookback so this never full-scans history.
   */
  spent: number;
  /** Shards ever given out = held + spent (the headline figure). */
  givenOut: number;
};

/** `null` when the game schema (`balances`/`packs`/`game_sessions`) is absent. */
export type ShardGivenOutResult = ShardGivenOut | null;

export type ShardOpensResult =
  | ShardOpensAvailable
  | { available: false; period: ShardOpensPeriod };

// ─── Schema probe (env-keyed) ──────────────────────────────────────────

async function rawProbeShardTables(env: DbEnv): Promise<boolean> {
  const db = env === "dev" ? getDevDb() : getProdDb();
  try {
    const r = await db.$queryRaw<{ packs: string | null; sessions: string | null }[]>`
      SELECT
        to_regclass('public.packs')::text AS packs,
        to_regclass('public.game_sessions')::text AS sessions`;
    return r[0]?.packs != null && r[0]?.sessions != null;
  } catch (err) {
    console.error(
      "[shard-pack-opens] packs/game_sessions probe failed, treating as absent:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

const probeShardTablesProd = unstable_cache(
  () => rawProbeShardTables("prod"),
  ["shard-pack-opens-tables-probe-prod-v2"],
  { revalidate: 300 },
);

async function probeShardTables(env: DbEnv): Promise<boolean> {
  if (env === "dev") return rawProbeShardTables("dev");
  return probeShardTablesProd();
}

// ─── Raw row types ────────────────────────────────────────────────────

type RawSummaryRow = {
  opens: bigint | number;
  openers: bigint | number;
  shards_spent: string | number | null;
  card_value_usd: string | number | null;
  card_count: bigint | number | null;
};

type RawPackRow = {
  pack_id: string;
  pack_name: string | null;
  shard_cost: number | null;
  opens: bigint | number;
  shards_spent: string | number | null;
  card_value_usd: string | number | null;
  card_count: bigint | number | null;
};

type RawFeedRow = {
  id: string;
  user_id: string;
  username: string | null;
  image: string | null;
  pack_name: string | null;
  shard_cost: number | null;
  card_name: string | null;
  card_value_usd: string | number | null;
  card_count: bigint | number | null;
  created_at: Date | string;
};

// ─── Core query (uncached) ────────────────────────────────────────────

async function queryShardPackOpens(
  period: ShardOpensPeriod,
  page: number,
  perPage: number,
  env: DbEnv,
): Promise<ShardOpensResult> {
  const hasTables = await probeShardTables(env);
  if (!hasTables) return { available: false, period };

  // Data queries use `getDb()` (request-scope resolves the env cookie on the
  // direct dev path; the cached prod path runs outside request scope and
  // getDb() falls back to prod) — both resolve to the correct client for
  // their `env`. Only the probe needs the explicit env client.
  const db = await getDb();
  const days = daysForPeriod(period);

  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * safePerPage;

  // ── Window-scoped opens = game_sessions(game_type='pack') joined to the
  //    SHARD packs (pack_type='shard'). Shards spent = pack.shard_cost per
  //    open. Card value/count via the provably-fair → user_inventory chain
  //    (one PF row per open, verified). The window predicate is on the
  //    session's created_at. Parameterised interval → no injection surface.

  // Summary KPIs across ALL opens in the window (uncapped count/sums).
  const summaryRows = await db.$queryRaw<RawSummaryRow[]>`
    SELECT
      COUNT(*)::bigint AS opens,
      COUNT(DISTINCT gs.user_id)::bigint AS openers,
      COALESCE(SUM(pk.shard_cost), 0)::text AS shards_spent,
      COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text AS card_value_usd,
      COUNT(ui.id)::bigint AS card_count
    FROM game_sessions gs
    JOIN packs pk ON pk.id = gs.game_id AND pk.pack_type = 'shard'
    LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
    LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
    WHERE gs.game_type::text = 'pack'
      AND gs.created_at >= NOW() - (${days} * INTERVAL '1 day')`;

  const s = summaryRows[0];
  const totalOpens = s ? Number(s.opens) : 0;

  if (totalOpens === 0) {
    return {
      available: true,
      period,
      summary: {
        totalOpens: 0,
        uniqueOpeners: 0,
        totalShardsSpent: 0,
        avgShardsPerOpen: 0,
        totalCardValueUsd: 0,
        totalCardCount: 0,
      },
      packs: [],
      feed: {
        data: [],
        total: 0,
        page: safePage,
        perPage: safePerPage,
        totalPages: 0,
      },
    };
  }

  const totalShardsSpent = Number(s?.shards_spent ?? 0);
  const totalCardValueUsd = Number(s?.card_value_usd ?? 0);
  const totalCardCount = Number(s?.card_count ?? 0);

  // ── Per-pack breakdown: opens / shards spent / card value $ / card count.
  //    Sorted by opens desc.
  const packRows = await db.$queryRaw<RawPackRow[]>`
    SELECT
      pk.id::text AS pack_id,
      pk.name AS pack_name,
      pk.shard_cost AS shard_cost,
      COUNT(*)::bigint AS opens,
      COALESCE(SUM(pk.shard_cost), 0)::text AS shards_spent,
      COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text AS card_value_usd,
      COUNT(ui.id)::bigint AS card_count
    FROM game_sessions gs
    JOIN packs pk ON pk.id = gs.game_id AND pk.pack_type = 'shard'
    LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
    LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
    WHERE gs.game_type::text = 'pack'
      AND gs.created_at >= NOW() - (${days} * INTERVAL '1 day')
    GROUP BY pk.id, pk.name, pk.shard_cost
    ORDER BY opens DESC, shards_spent DESC`;

  const packs: ShardPackBreakdownRow[] = packRows.map((r) => ({
    packId: r.pack_id,
    packName: r.pack_name ?? `Pack ${r.pack_id.slice(0, 8)}`,
    shardCost: Number(r.shard_cost ?? 0),
    opens: Number(r.opens),
    shardsSpent: Number(r.shards_spent ?? 0),
    cardValueUsd: Number(r.card_value_usd ?? 0),
    cardCount: Number(r.card_count ?? 0),
  }));

  // ── Paginated feed of individual opens (newest first). The user join,
  //    pack-name and card-name resolution run ONLY for the page slice. The PF
  //    join is index-backed (idx_pf_results_game_session_id); inventory + card
  //    lookups are PK seeks — cheap and bounded to ≤perPage rows.
  const feedRows = await db.$queryRaw<RawFeedRow[]>`
    SELECT
      gs.id::text AS id,
      gs.user_id,
      u.username,
      u.image,
      pk.name AS pack_name,
      pk.shard_cost AS shard_cost,
      ca.name AS card_name,
      COALESCE(ui.value_at_obtained::numeric, 0)::text AS card_value_usd,
      (CASE WHEN ui.id IS NULL THEN 0 ELSE 1 END)::bigint AS card_count,
      gs.created_at
    FROM game_sessions gs
    JOIN packs pk ON pk.id = gs.game_id AND pk.pack_type = 'shard'
    LEFT JOIN "user" u ON u.id = gs.user_id
    LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
    LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
    LEFT JOIN cards ca ON ca.id = ui.card_id
    WHERE gs.game_type::text = 'pack'
      AND gs.created_at >= NOW() - (${days} * INTERVAL '1 day')
    ORDER BY gs.created_at DESC
    LIMIT ${safePerPage}
    OFFSET ${offset}`;

  const feedData: ShardPackOpenRow[] = feedRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    image: r.image,
    packName: r.pack_name ?? "Shard pack",
    shardsSpent: Number(r.shard_cost ?? 0),
    cardName: r.card_name,
    cardValueUsd: Number(r.card_value_usd ?? 0),
    cardCount: Number(r.card_count ?? 0),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  }));

  const summary: ShardOpensSummary = {
    totalOpens,
    uniqueOpeners: Number(s?.openers ?? 0),
    totalShardsSpent,
    avgShardsPerOpen: totalOpens > 0 ? totalShardsSpent / totalOpens : 0,
    totalCardValueUsd,
    totalCardCount,
  };

  return {
    available: true,
    period,
    summary,
    packs,
    feed: {
      data: feedData,
      total: totalOpens,
      page: safePage,
      perPage: safePerPage,
      totalPages: Math.ceil(totalOpens / safePerPage),
    },
  };
}

// ─── Env-keyed cache wrapper (mirrors insights-coins.ts) ───────────────
//
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope, so
// `cookies()` (and thus `readDbEnv` inside getDb()) falls back to "prod".
// Caching a dev-toggled request would serve PROD data to a dev admin. So:
// cache ONLY on prod (the default + hot path); a dev-toggled admin runs the
// query directly so they always see live dev data. Each (period, page,
// perPage) combo is its own cache key (Active-Timeframe-Only: no eager
// preload of other windows/pages). All-primitive payload (createdAt is an
// ISO string), so the cache JSON round-trip is lossless — no Date to coerce.

const cachedShardPackOpens = unstable_cache(
  (period: ShardOpensPeriod, page: number, perPage: number) =>
    queryShardPackOpens(period, page, perPage, "prod"),
  ["shard-pack-opens-v2"],
  { revalidate: 60, tags: ["shard-pack-opens"] },
);

/**
 * Public entry point. Returns the global shard-pack opens (summary KPIs +
 * per-pack breakdown + a paginated feed of individual opens) for ONE window.
 * Cached per (period, page, perPage) on prod; direct (uncached) on a
 * dev-toggled admin so they see live dev data. ACTIVE-TIMEFRAME-ONLY: the
 * caller fetches only the active window + active page — no eager preload.
 */
export async function getShardPackOpens(
  period: ShardOpensPeriod,
  page: number,
  perPage: number,
): Promise<ShardOpensResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryShardPackOpens(period, page, perPage, env);
  // Pin the per-period TTL by routing through a period-keyed wrapper. The
  // `cachedShardPackOpens` revalidate is 60s; for `all` we want 300s, so wrap
  // the lifetime window in its own longer-lived cache. Keeps the active-only
  // contract (only the requested period/page is fetched + cached).
  if (period === "all") return cachedShardPackOpensAll(page, perPage);
  return cachedShardPackOpens(period, page, perPage);
}

// Separate lifetime cache so the heavier 365d window gets the longer TTL
// (300s) without changing the 60s TTL of the active short windows. Same
// prod-only contract.
const cachedShardPackOpensAll = unstable_cache(
  (page: number, perPage: number) =>
    queryShardPackOpens("all", page, perPage, "prod"),
  ["shard-pack-opens-all-v2"],
  { revalidate: cacheTtlForPeriod("all"), tags: ["shard-pack-opens"] },
);

// ─── Shard economy overview (Part A) — REUSE the canonical economy ─────
//
// The standalone /insights/coins page was removed, taking its shard-economy
// OVERVIEW with it. This re-surfaces the same aggregates on /rewards/shard-opens
// by DELEGATING to the canonical `getCoinsEconomy` (insights-coins.ts) — the
// one-source-of-truth for the coin/shard ledger — and projecting out the supply
// snapshot + flow it already computes. NO second rollup, NO duplicated SQL: the
// caching, env-keyed schema-drift probe, 365d lifetime cap, and Active-Timeframe-
// Only contract all live in `getCoinsEconomy`; this is a thin, type-preserving
// pass-through (identical to how `shard-stats.ts` projects the same module).
// `ShardOpensPeriod` is structurally identical to `CoinsPeriod`, so the period
// passes straight through.

/**
 * Public entry point for the shard ECONOMY OVERVIEW for ONE window: the live
 * supply snapshot (Σ shards held, distinct holders) + the period-scoped flow
 * (earned / spent / net house game flow / issued-to-users / active users / tx
 * count), reused verbatim from `getCoinsEconomy`. Returns `null` when the
 * coin/shard ledger is absent on the connected DB so the overview self-hides.
 * ACTIVE-TIMEFRAME-ONLY (inherited): only the active window is fetched/cached.
 */
export async function getShardEconomyOverview(
  period: ShardOpensPeriod,
): Promise<ShardEconomyResult> {
  // ShardOpensPeriod ≡ CoinsPeriod; pass through with no remapping.
  const economy = await getCoinsEconomy(period as CoinsPeriod);
  if (!economy.available) return null;
  return {
    totalShardsHeld: economy.supply.totalShards,
    shardHolders: economy.supply.shardHolders,
    earned: economy.earned,
    spent: economy.spent,
    netHouse: economy.netHouse,
    issuedToUsers: economy.issuedToUsers,
    issuedToUsersCustomers: economy.issuedToUsersCustomers,
    activeUsers: economy.activeUsers,
    txCount: economy.txCount,
    daily: economy.daily.map((d) => ({
      date: d.date,
      earned: d.earned,
      spent: d.spent,
    })),
  };
}

// ─── TRUE shards GIVEN OUT (integer shard currency) ────────────────────
//
// The headline the owner wants: "how many SHARDS did we give out". See the
// `ShardGivenOut` docblock for the full currency model and prod evidence.
// This reads the INTEGER `balances.shards` supply + the shard SINK (Σ
// pack.shard_cost over shard-pack opens) — NOT the coin ledger — so it can
// never be confused with the USD-pegged coin grant figure. Two cheap bounded
// aggregates (supply is window-independent; the spent sum is capped at the
// 365d lifetime lookback), cached 300s on prod, schema-probed so it self-hides
// when the game schema is absent.

type RawGivenOutRow = {
  held: string | number | null;
  holders: bigint | number | null;
  spent: string | number | null;
};

async function queryShardGivenOut(env: DbEnv): Promise<ShardGivenOutResult> {
  const hasTables = await probeShardTables(env);
  if (!hasTables) return null;

  const db = await getDb();

  // Live integer-shard supply (Σ balances.shards) + the only shard sink
  // (Σ pack.shard_cost over shard-pack opens). Supply is window-independent;
  // the sink is capped at the 365d lookback so it never full-scans history.
  // One round-trip via a cross join of two single-row scalar aggregates.
  const rows = await db.$queryRaw<RawGivenOutRow[]>`
    SELECT
      sup.total_shards AS held,
      sup.holders AS holders,
      COALESCE(spend.shards_spent, 0) AS spent
    FROM (
      SELECT
        COALESCE(SUM(shards), 0)::text AS total_shards,
        COUNT(*) FILTER (WHERE shards > 0)::bigint AS holders
      FROM balances
    ) sup
    CROSS JOIN (
      SELECT COALESCE(SUM(pk.shard_cost), 0)::bigint AS shards_spent
      FROM game_sessions gs
      JOIN packs pk ON pk.id = gs.game_id AND pk.pack_type = 'shard'
      WHERE gs.game_type::text = 'pack'
        AND gs.created_at >= NOW() - (${LIFETIME_LOOKBACK_DAYS} * INTERVAL '1 day')
    ) spend`;

  const r = rows[0];
  const held = Number(r?.held ?? 0);
  const holders = Number(r?.holders ?? 0);
  const spent = Number(r?.spent ?? 0);
  return { held, holders, spent, givenOut: held + spent };
}

const cachedShardGivenOut = unstable_cache(
  () => queryShardGivenOut("prod"),
  ["shard-given-out-v1"],
  { revalidate: 300, tags: ["shard-pack-opens"] },
);

/**
 * Public entry point for the TRUE integer-SHARD given-out snapshot:
 * `held` (Σ balances.shards) + `spent` (Σ pack.shard_cost over opens) =
 * `givenOut`. Returns `null` when the game schema is absent so the tile
 * self-hides. Cached 300s on prod; direct on a dev-toggled admin.
 */
export async function getShardGivenOut(): Promise<ShardGivenOutResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryShardGivenOut(env);
  return cachedShardGivenOut();
}
