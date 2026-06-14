import "server-only";
import { unstable_cache } from "next/cache";
import { getDb, getProdDb, getDevDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import type { PaginatedResult } from "@/lib/types";

/**
 * GLOBAL shard-pack OPENS — every open of a pack bought with SHARDS (the
 * secondary, wager-earned currency), with how many shards it cost and how
 * many shards it won. Powers the /rewards/shard-opens admin surface.
 *
 * WHAT A "SHARD-PACK OPEN" IS (confirmed read-only on the live prod DB)
 * ────────────────────────────────────────────────────────────────────
 * Opening a pack with shards is recorded entirely in the `coin_transactions`
 * ledger (the secondary-currency usage trail), NOT in the USD
 * `ledger_transactions`. Each open is a pair of rows sharing one
 * `game_session_id`:
 *
 *   • coin_pack_bet     — shards SPENT on the open ("Opened N pack(s) with
 *                         coins"). `amount` is the positive shard magnitude
 *                         spent. `metadata.pack_ids` is the array of opened
 *                         pack UUIDs. One bet row per open session.
 *   • coin_pack_payout  — the value WON from that open, ALSO in shards
 *                         ("Coin payout from N pack(s)"). Same
 *                         `game_session_id`. A losing/zero open simply has
 *                         NO payout row, so a LEFT JOIN bet→payout yields a
 *                         won of 0 there.
 *
 * Read-only prod evidence (2026-06-14, current live DB): 11 `coin_pack_bet`
 * rows, all with a non-null `game_session_id`, each paired 1:1 to a
 * `coin_pack_payout` by `game_session_id` (0 null sessions, 1 bet/session,
 * 1 pack/open). Σ spent 11.82 shards, Σ won 1.90 shards → net house +9.92
 * shards. Pack names resolve from `packs.name` via `metadata.pack_ids`
 * (e.g. "5% Voyage", "Trash"). Openers seen are real customers (role
 * `user`).
 *
 * So an open pairs UNAMBIGUOUSLY to its winnings by `game_session_id`, and
 * "won" means SHARDS (the secondary currency), not cards or USD — the cards
 * the open actually rolls into inventory are a separate USD concern already
 * accounted for in the inventory / USD ledger. This surface is purely the
 * SHARD wager flow of opening shard packs.
 *
 * HOUSE-POV / UNIT
 * ────────────────
 * Shards are a SECONDARY, wager-earned currency, NOT dollars — every figure
 * here is in SHARDS and is never summed into a USD total. Following the same
 * convention as the coin/shard economy panels: shards a user SPENDS into an
 * open (the house takes in) read emerald; shards a user WINS (a house
 * liability) read rose; net house (spent − won) reads emerald when the house
 * is up, rose when down.
 *
 * SCOPE
 * ─────
 * UNSCOPED — this is a raw ACTIVITY/AUDIT feed of every shard-pack open,
 * deliberately NOT filtered to the customer-only metric scope. It is not a
 * revenue/edge metric the GGR/NGR layer owns (those are USD); it is "show me
 * who opened shard packs and what happened", so staff/creator opens are
 * shown too. (The displayed house-edge % is a descriptive read of the shown
 * shard flow, not a customer-scoped revenue metric.)
 *
 * SCHEMA DRIFT (defensive, mirrors the sibling coin/shard modules)
 * ────────────────────────────────────────────────────────────────
 * `coin_transactions` exists on the live prod game DB (verified), but a
 * non-migrated DEV env may lack it. This module probes the connected DB once
 * (cached 5 min, keyed per prod/dev env) and returns `{ available: false }`
 * when the table is absent, so the page degrades to a clear "no coin/shard
 * ledger on this database" panel instead of crashing. Same self-healing
 * guard as `shard-stats.ts` / `users-shard-winnings.ts`.
 *
 * READ-ONLY. SELECT + `to_regclass` introspection only — no writes, no
 * game-data mutation. Safe against the live production DB.
 */

// ─── Period model ─────────────────────────────────────────────────────
//
// Kept identical to the coin/shard economy panel (`shard-stats.ts`) so the
// two surfaces switch windows the same way.

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
 * Daten-Laden" forbids). Mirrors the 365d cap in `insights-coins.ts` /
 * `shard-stats.ts`. The coin ledger is young (launched 2026-06), so 365d
 * covers all activity.
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

/** Headline KPIs for one window, all in SHARDS (never USD). */
export type ShardOpensSummary = {
  /** Distinct shard-pack open sessions in the window. */
  totalOpens: number;
  /** Distinct users who opened a shard pack in the window. */
  uniqueOpeners: number;
  /** Total shards spent into opens (house takes in). */
  totalSpent: number;
  /** Total shards won from opens (house liability). */
  totalWon: number;
  /**
   * Net house shard flow = spent − won. Positive ⇒ house up (users net lost
   * shards into opens); negative ⇒ opens paid out more shards than spent.
   */
  netHouse: number;
  /** Average shards spent per open (spent / opens; 0 when no opens). */
  avgSpentPerOpen: number;
  /**
   * House edge over the shown shard flow = (spent − won) / spent, as a
   * percent. `null` when spent is 0 (undefined edge). Descriptive read of
   * the displayed flow, not a customer-scoped revenue metric.
   */
  houseEdgePct: number | null;
};

/** One shard pack rolled up: opens / shards spent / shards won / edge. */
export type ShardPackBreakdownRow = {
  /** packs.id of the shard pack. */
  packId: string;
  /** packs.name (or a short id fallback when the pack row is gone). */
  packName: string;
  /** Distinct opens that included this pack. */
  opens: number;
  /** Shards spent on opens including this pack. */
  spent: number;
  /** Shards won from opens including this pack. */
  won: number;
  /** Net house (spent − won) for this pack. */
  netHouse: number;
  /** House edge % over this pack's flow ((spent − won)/spent); null at 0. */
  houseEdgePct: number | null;
};

/** One individual shard-pack open for the feed (newest first). */
export type ShardPackOpenRow = {
  /** game_session_id of the open (stable key). */
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  /** Shards spent on this open (|coin_pack_bet.amount|). */
  spent: number;
  /** Shards won from this open (|coin_pack_payout.amount|; 0 when no payout). */
  won: number;
  /** Net house for this open (spent − won). */
  netHouse: number;
  /** Number of packs opened in this session (from metadata.pack_ids). */
  packs: number;
  /** Resolved pack name(s) for the open (joined from packs via pack_ids). */
  packNames: string[];
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

export type ShardOpensResult =
  | ShardOpensAvailable
  | { available: false; period: ShardOpensPeriod };

// ─── Schema probe (env-keyed; mirrors insights-coins.ts) ───────────────

async function rawProbeCoinTable(env: DbEnv): Promise<boolean> {
  const db = env === "dev" ? getDevDb() : getProdDb();
  try {
    const r = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.coin_transactions')::text AS exists`;
    return r[0]?.exists != null;
  } catch (err) {
    console.error(
      "[shard-pack-opens] coin_transactions probe failed, treating as absent:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

const probeCoinTableProd = unstable_cache(
  () => rawProbeCoinTable("prod"),
  ["shard-pack-opens-coin-table-probe-prod-v1"],
  { revalidate: 300 },
);

async function probeCoinTable(env: DbEnv): Promise<boolean> {
  if (env === "dev") return rawProbeCoinTable("dev");
  return probeCoinTableProd();
}

// ─── Raw row types ────────────────────────────────────────────────────

type RawSummaryRow = {
  opens: bigint | number;
  openers: bigint | number;
  spent: string | number | null;
  won: string | number | null;
};

type RawPackRow = {
  pack_id: string;
  pack_name: string | null;
  opens: bigint | number;
  spent: string | number | null;
  won: string | number | null;
};

type RawFeedRow = {
  id: string;
  user_id: string;
  username: string | null;
  image: string | null;
  spent: string | number | null;
  won: string | number | null;
  packs: bigint | number | null;
  pack_names: string[] | null;
  created_at: Date | string;
};

// ─── Core query (uncached) ────────────────────────────────────────────

function edgePct(spent: number, won: number): number | null {
  if (spent <= 0) return null;
  return ((spent - won) / spent) * 100;
}

async function queryShardPackOpens(
  period: ShardOpensPeriod,
  page: number,
  perPage: number,
  env: DbEnv,
): Promise<ShardOpensResult> {
  const hasTable = await probeCoinTable(env);
  if (!hasTable) return { available: false, period };

  // Data queries use `getDb()` (request-scope resolves the env cookie on the
  // direct dev path; the cached prod path runs outside request scope and
  // getDb() falls back to prod) — both resolve to the correct client for
  // their `env`, exactly as in insights-coins.ts. Only the probe needs the
  // explicit env client.
  const db = await getDb();
  const days = daysForPeriod(period);

  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * safePerPage;

  // ── Window-scoped open sessions, paired bet→payout by game_session_id.
  //    One bet row per open (verified), but GROUP defensively so a future
  //    multi-row session still collapses to one open. Payouts collapse to
  //    one summed row per session first so a session with >1 payout row
  //    never multiplies the open. `amount` is a positive magnitude on both
  //    legs. The window predicate is on the BET's created_at (the open
  //    happened then); the payout shares the session so it rides along.
  //    Parameterised interval → no injection surface.

  // Summary KPIs across ALL opens in the window (uncapped count/sums).
  const summaryRows = await db.$queryRaw<RawSummaryRow[]>`
    WITH bets AS (
      SELECT game_session_id, MIN(user_id) AS user_id, SUM(amount) AS spent
      FROM coin_transactions
      WHERE type::text = 'coin_pack_bet'
        AND game_session_id IS NOT NULL
        AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY game_session_id
    ),
    pays AS (
      SELECT game_session_id, SUM(amount) AS won
      FROM coin_transactions
      WHERE type::text = 'coin_pack_payout'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    )
    SELECT
      COUNT(*)::bigint AS opens,
      COUNT(DISTINCT b.user_id)::bigint AS openers,
      COALESCE(SUM(b.spent), 0)::text AS spent,
      COALESCE(SUM(p.won), 0)::text AS won
    FROM bets b
    LEFT JOIN pays p USING (game_session_id)`;

  const s = summaryRows[0];
  const totalOpens = s ? Number(s.opens) : 0;

  if (totalOpens === 0) {
    return {
      available: true,
      period,
      summary: {
        totalOpens: 0,
        uniqueOpeners: 0,
        totalSpent: 0,
        totalWon: 0,
        netHouse: 0,
        avgSpentPerOpen: 0,
        houseEdgePct: null,
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

  const totalSpent = Number(s?.spent ?? 0);
  const totalWon = Number(s?.won ?? 0);

  // ── Per-pack breakdown. Unnest each open's pack_ids so a multi-pack open
  //    contributes to every pack it included; the open's spent/won is
  //    attributed in full to each included pack (matches the
  //    one-pack-per-open reality and is the honest read when a session
  //    bundles packs — an open "including" pack X spent/won this much).
  //    Resolve the name from `packs`. Sorted by opens desc.
  const packRows = await db.$queryRaw<RawPackRow[]>`
    WITH bets AS (
      SELECT
        game_session_id,
        SUM(amount) AS spent,
        (array_agg(metadata -> 'pack_ids'))[1] AS pack_ids
      FROM coin_transactions
      WHERE type::text = 'coin_pack_bet'
        AND game_session_id IS NOT NULL
        AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY game_session_id
    ),
    pays AS (
      SELECT game_session_id, SUM(amount) AS won
      FROM coin_transactions
      WHERE type::text = 'coin_pack_payout'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    ),
    opens AS (
      SELECT b.game_session_id, b.spent, COALESCE(p.won, 0) AS won, b.pack_ids
      FROM bets b
      LEFT JOIN pays p USING (game_session_id)
    ),
    exploded AS (
      SELECT
        (jsonb_array_elements_text(o.pack_ids))::uuid AS pack_id,
        o.game_session_id,
        o.spent,
        o.won
      FROM opens o
      WHERE o.pack_ids IS NOT NULL
        AND jsonb_typeof(o.pack_ids) = 'array'
    )
    SELECT
      e.pack_id::text AS pack_id,
      pk.name AS pack_name,
      COUNT(DISTINCT e.game_session_id)::bigint AS opens,
      COALESCE(SUM(e.spent), 0)::text AS spent,
      COALESCE(SUM(e.won), 0)::text AS won
    FROM exploded e
    LEFT JOIN packs pk ON pk.id = e.pack_id
    GROUP BY e.pack_id, pk.name
    ORDER BY opens DESC, spent DESC`;

  const packs: ShardPackBreakdownRow[] = packRows.map((r) => {
    const spent = Number(r.spent ?? 0);
    const won = Number(r.won ?? 0);
    return {
      packId: r.pack_id,
      packName: r.pack_name ?? `Pack ${r.pack_id.slice(0, 8)}`,
      opens: Number(r.opens),
      spent,
      won,
      netHouse: spent - won,
      houseEdgePct: edgePct(spent, won),
    };
  });

  // ── Paginated feed of individual opens (newest first). The user join +
  //    pack-name resolution run ONLY for the page slice. pack_names is
  //    resolved by unnesting the open's pack_ids and joining `packs`,
  //    aggregated back to an array per open.
  const feedRows = await db.$queryRaw<RawFeedRow[]>`
    WITH bets AS (
      SELECT
        game_session_id,
        MIN(user_id) AS user_id,
        SUM(amount) AS spent,
        MAX(created_at) AS created_at,
        MAX(COALESCE(jsonb_array_length(metadata -> 'pack_ids'), 0)) AS packs,
        (array_agg(metadata -> 'pack_ids'))[1] AS pack_ids
      FROM coin_transactions
      WHERE type::text = 'coin_pack_bet'
        AND game_session_id IS NOT NULL
        AND created_at >= NOW() - (${days} * INTERVAL '1 day')
      GROUP BY game_session_id
    ),
    pays AS (
      SELECT game_session_id, SUM(amount) AS won
      FROM coin_transactions
      WHERE type::text = 'coin_pack_payout'
        AND game_session_id IS NOT NULL
      GROUP BY game_session_id
    ),
    page AS (
      SELECT b.*, COALESCE(p.won, 0) AS won
      FROM bets b
      LEFT JOIN pays p USING (game_session_id)
      ORDER BY b.created_at DESC
      LIMIT ${safePerPage}
      OFFSET ${offset}
    )
    SELECT
      pg.game_session_id::text AS id,
      pg.user_id,
      u.username,
      u.image,
      pg.spent::text AS spent,
      pg.won::text AS won,
      pg.packs::bigint AS packs,
      (
        SELECT COALESCE(array_agg(pk.name ORDER BY pk.name), ARRAY[]::text[])
        FROM jsonb_array_elements_text(pg.pack_ids) AS pid(pack_id)
        JOIN packs pk ON pk.id = pid.pack_id::uuid
      ) AS pack_names,
      pg.created_at
    FROM page pg
    LEFT JOIN "user" u ON u.id = pg.user_id
    ORDER BY pg.created_at DESC`;

  const feedData: ShardPackOpenRow[] = feedRows.map((r) => {
    const spent = Number(r.spent ?? 0);
    const won = Number(r.won ?? 0);
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      image: r.image,
      spent,
      won,
      netHouse: spent - won,
      packs: Number(r.packs ?? 0),
      packNames: Array.isArray(r.pack_names) ? r.pack_names : [],
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
    };
  });

  const summary: ShardOpensSummary = {
    totalOpens,
    uniqueOpeners: Number(s?.openers ?? 0),
    totalSpent,
    totalWon,
    netHouse: totalSpent - totalWon,
    avgSpentPerOpen: totalOpens > 0 ? totalSpent / totalOpens : 0,
    houseEdgePct: edgePct(totalSpent, totalWon),
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
  ["shard-pack-opens-v1"],
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
  ["shard-pack-opens-all-v1"],
  { revalidate: cacheTtlForPeriod("all"), tags: ["shard-pack-opens"] },
);
