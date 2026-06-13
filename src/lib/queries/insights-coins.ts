import "server-only";
import { unstable_cache } from "next/cache";
import { getDb, getProdDb, getDevDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";

/**
 * Global coin & shard secondary-currency economy — the data layer behind
 * the /insights/coins page.
 *
 * WHAT THIS READS
 * ───────────────
 * Two things, both from the MAIN game DB, both READ-ONLY:
 *
 *   1. SUPPLY (a snapshot, no period): the live secondary-currency
 *      balances held in wallets — `Σ balances.shards` (the wager-earned
 *      shard currency) and `Σ balances.coin_available_balance` (the coin
 *      balance) plus the holder counts. This is "how much currency is
 *      currently out there", independent of any time window.
 *
 *   2. ECONOMY (period-scoped): the FLOW of coins/shards through the
 *      `coin_transactions` ledger over the active window — every coin/shard
 *      bet, payout, refund and admin adjustment lands there with a positive
 *      `amount` magnitude and a `balance_before` / `balance_after` pair (the
 *      canonical audit chain). Direction (earned vs spent) is read from the
 *      SIGN of `balance_after - balance_before` so a future enum member is
 *      classified correctly without a hard-coded type list.
 *
 * This is the GLOBAL economy view. The per-shards-page section
 * (`shard-stats.ts` + `rewards/shards/shard-stats-section.tsx`) shows the
 * SAME `coin_transactions` flow but only as a small panel under the shard
 * pack list; this module reuses that ledger logic and adds the global
 * supply snapshot + a daily earned-vs-spent trend on top.
 *
 * House-POV note: coins/shards are a SECONDARY currency (wager-earned), NOT
 * USD. So balances/counts are presented NEUTRALLY (cyan). The two
 * cash-adjacent signals follow the house rule: coins users SPEND into games
 * (the house takes in) read emerald; coins users EARN / are GRANTED (a house
 * liability / cost) read rose.
 *
 * SCHEMA DRIFT (CRITICAL)
 * ───────────────────────
 * `coin_transactions` (and `balances.shards`) exist on the migrated
 * DEV/sweepstakes schema but NOT on every connected DB — production (the
 * live game DB) may currently have NO `coin_transactions` table, so a query
 * against it throws `42P01 relation does not exist`. This module probes the
 * connected DB once (cached 5 min) and returns an `{ available: false }`
 * result when the table is absent, so the page degrades to a clear "no
 * coin/shard ledger on this database" panel instead of crashing. Same
 * self-healing pattern as `shard-stats.ts`.
 *
 * READ-ONLY. SELECT + `to_regclass` introspection only — no writes, no
 * game-data mutation. Safe against the live production DB.
 */

// ─── Period model ─────────────────────────────────────────────────────

export type CoinsPeriod = "24h" | "7d" | "30d" | "all";

export function parseCoinsPeriod(value: string | undefined): CoinsPeriod {
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

export function coinsPeriodLabel(p: CoinsPeriod): string {
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
 * Daten-Laden" forbids). Mirrors the reward-insights 365d cap and
 * `shard-stats.ts`. The coin ledger is young (launched 2026-06), so 365d
 * covers all activity.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(p: CoinsPeriod): number {
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

function cacheTtlForPeriod(p: CoinsPeriod): number {
  return p === "all" ? 300 : 60;
}

// ─── Result shapes ────────────────────────────────────────────────────

/** Live secondary-currency supply snapshot (no period). */
export type CoinSupply = {
  /** Σ balances.shards across all wallets. */
  totalShards: number;
  /** Wallets holding > 0 shards. */
  shardHolders: number;
  /** Σ balances.coin_available_balance across all wallets. */
  totalCoin: number;
  /** Wallets holding > 0 coin balance. */
  coinHolders: number;
};

/** One `coin_transactions.type` rolled up for the breakdown table. */
export type CoinCategoryRow = {
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
};

/** One day of earned-vs-spent flow for the trend chart. */
export type CoinDailyPoint = {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Coins/shards earned (balance increased) that day. */
  earned: number;
  /** Coins/shards spent (balance decreased) that day. */
  spent: number;
  /** Net house flow that day = spent − earned. */
  netHouse: number;
};

export type CoinsEconomyAvailable = {
  available: true;
  period: CoinsPeriod;
  supply: CoinSupply;
  /** Total coins/shards EARNED by users (balance increases) in the window. */
  earned: number;
  /** Total coins/shards SPENT by users (balance decreases) in the window. */
  spent: number;
  /**
   * Net house flow = spent − earned. Positive ⇒ users net spent (house took
   * in); negative ⇒ users net earned (house paid out).
   */
  netHouse: number;
  /** Total ledger rows in the window. */
  txCount: number;
  /** Distinct users with any coin/shard activity in the window. */
  activeUsers: number;
  /**
   * Coins/shards GRANTED to users by an admin adjustment (positive-delta
   * `coin_admin_adjustment` rows) — the closest analogue to a house cost on
   * this secondary-currency surface.
   */
  grantedToUsers: number;
  /** Per-type breakdown, sorted by total desc. */
  categories: CoinCategoryRow[];
  /** Daily earned-vs-spent trend over the window. */
  daily: CoinDailyPoint[];
};

export type CoinsEconomyResult =
  | CoinsEconomyAvailable
  | { available: false; period: CoinsPeriod };

// ─── Schema probe ─────────────────────────────────────────────────────
//
// The probe is ENV-KEYED. `unstable_cache` runs its callback OUTSIDE the
// request's dynamic scope, so a `cookies()` read inside `getDb()` throws and
// `readDbEnv` falls back to "prod" — meaning a naive cached probe would
// always check the PROD DB and, once a prod request populated the (single)
// cache entry with `false` (prod has no `coin_transactions`), a later DEV
// request on the same server process would wrongly inherit that `false` and
// show the muted "no ledger" panel even though dev HAS the table. (A single
// server serves both prod and dev-toggled admins, so they share the module
// cache.) The fix: resolve the env in REQUEST scope, pass it in as the cache
// key, and select the matching client EXPLICITLY (`getProdDb`/`getDevDb`) so
// the probe never depends on the unreadable cookie inside the cache callback.

async function rawProbeCoinTable(env: DbEnv): Promise<boolean> {
  const db = env === "dev" ? getDevDb() : getProdDb();
  try {
    const r = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.coin_transactions')::text AS exists`;
    return r[0]?.exists != null;
  } catch (err) {
    console.error(
      "[insights-coins] coin_transactions probe failed, treating as absent:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

const probeCoinTableProd = unstable_cache(
  () => rawProbeCoinTable("prod"),
  ["insights-coins-coin-table-probe-prod-v1"],
  { revalidate: 300 },
);

/**
 * Resolve whether `coin_transactions` exists on the env the CURRENT request
 * targets. Prod is cached (300s, the hot path); a dev-toggled admin probes
 * directly so a stale/foreign cache entry can never mask the dev table.
 */
async function probeCoinTable(env: DbEnv): Promise<boolean> {
  if (env === "dev") return rawProbeCoinTable("dev");
  return probeCoinTableProd();
}

// ─── Label mapping ────────────────────────────────────────────────────

/**
 * Friendly label for a `coin_transactions.type`. Falls back to a
 * de-prefixed, title-cased rendering of the raw enum member so a future,
 * not-yet-mapped type still reads cleanly. Mirrors `shard-stats.ts`.
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

type RawSupplyRow = {
  total_shards: string | number | null;
  shard_holders: bigint | number;
  total_coin: string | number | null;
  coin_holders: bigint | number;
};

type RawDailyRow = {
  day: string;
  earned: string | number | null;
  spent: string | number | null;
};

async function queryCoinsEconomy(
  period: CoinsPeriod,
  env: DbEnv,
): Promise<CoinsEconomyResult> {
  const hasTable = await probeCoinTable(env);
  if (!hasTable) return { available: false, period };

  // Data queries use `getDb()` (not the explicit env client): on the DIRECT
  // dev path it runs in request scope and resolves the cookie → dev client;
  // on the cached prod path it runs outside request scope and falls back to
  // prod → prod client. Both are the correct client for their `env`, so the
  // cached prod entry never serves dev data and vice-versa. Only the PROBE
  // needed the explicit env client (its cache callback can't read the cookie).
  const db = await getDb();
  const days = daysForPeriod(period);

  // ── Supply snapshot (no period). TRUE circulating supply — UNSCOPED:
  //    every shard / coin balance in a wallet is real currency in
  //    circulation, including staff/creator-held wallets, so "how much is
  //    out there" must count ALL holders (not the customer-only scope). This
  //    is deliberately different from the economy FLOW below and from the
  //    GGR/NGR metric layer, which DO drop staff + creators — there,
  //    customer scope matters because those are revenue metrics; supply is
  //    a balance-sheet snapshot of the whole economy. Verified against the
  //    dev DB: Σ shards = 11,412,157 across 84 holders.
  const supplyRows = await db.$queryRaw<RawSupplyRow[]>`
    SELECT
      COALESCE(SUM(shards), 0)::text AS total_shards,
      COUNT(*) FILTER (WHERE shards > 0)::bigint AS shard_holders,
      COALESCE(SUM(coin_available_balance), 0)::text AS total_coin,
      COUNT(*) FILTER (WHERE coin_available_balance > 0)::bigint AS coin_holders
    FROM balances`;
  const supplyRaw = supplyRows[0];
  const supply: CoinSupply = {
    totalShards: Number(supplyRaw?.total_shards ?? 0),
    shardHolders: Number(supplyRaw?.shard_holders ?? 0),
    totalCoin: Number(supplyRaw?.total_coin ?? 0),
    coinHolders: Number(supplyRaw?.coin_holders ?? 0),
  };

  // ── Per (type, direction) rollup. Direction is the SIGN of the audited
  //    balance delta — ground truth for earned vs spent that needs no
  //    hard-coded type list and classifies a split type (admin adjustment,
  //    which can be + or −) correctly. `amount` is a positive magnitude, so
  //    |amount| == amount. Parameterised interval → no injection surface.
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

  let earned = 0;
  let spent = 0;
  let grantedToUsers = 0;
  // Merge the two direction-split rows of a type back into one display row
  // (a type rarely spans both directions, but admin adjustments do).
  const byType = new Map<string, CoinCategoryRow>();

  for (const r of rows) {
    const total = Number(r.total ?? 0);
    const count = Number(r.count);
    const users = Number(r.users);
    const direction = r.direction === "spent" ? "spent" : "earned";

    if (direction === "earned") earned += total;
    else spent += total;

    if (r.type === "coin_admin_adjustment" && direction === "earned") {
      grantedToUsers += total;
    }

    const existing = byType.get(r.type);
    if (existing) {
      existing.count += count;
      existing.total += total;
      // Distinct users can't be summed exactly across direction splits;
      // take the max as a safe lower-bound estimate for the display row.
      existing.users = Math.max(existing.users, users);
      // A mixed-direction type is dominated by its larger leg for the badge.
      if (total > existing.total - total) existing.direction = direction;
    } else {
      byType.set(r.type, {
        type: r.type,
        label: labelForType(r.type),
        direction,
        count,
        total,
        users,
      });
    }
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

  // ── Daily earned-vs-spent trend over the window. Direction is again the
  //    sign of the audited balance delta, so the two series sum back to the
  //    window totals above.
  const dailyRows = await db.$queryRaw<RawDailyRow[]>`
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      COALESCE(SUM(amount) FILTER (WHERE balance_after >= balance_before), 0)::text
        AS earned,
      COALESCE(SUM(amount) FILTER (WHERE balance_after <  balance_before), 0)::text
        AS spent
    FROM coin_transactions
    WHERE created_at >= NOW() - (${days} * INTERVAL '1 day')
    GROUP BY 1
    ORDER BY 1`;

  const daily: CoinDailyPoint[] = dailyRows.map((r) => {
    const e = Number(r.earned ?? 0);
    const s = Number(r.spent ?? 0);
    return { date: r.day, earned: e, spent: s, netHouse: s - e };
  });

  return {
    available: true,
    period,
    supply,
    earned,
    spent,
    netHouse: spent - earned,
    txCount,
    activeUsers,
    grantedToUsers,
    categories,
    daily,
  };
}

// ─── Env-keyed cache wrapper ──────────────────────────────────────────
//
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope,
// so `cookies()` (and thus `readDbEnv`) inside `getDb()` falls back to
// "prod". Caching a dev-toggled request would therefore serve PROD data to
// a dev admin (and the prod-keyed entry would be wrong). So: cache ONLY on
// prod (the default + the hot path); a dev-toggled admin runs the query
// directly so they always see live dev data. Identical reasoning to
// `users-detail-cache.ts` and `shard-stats.ts`.

// The cached wrappers ALWAYS run on the prod path (see `getCoinsEconomy`), so
// they pin `env = "prod"` — the cache callback runs outside request scope and
// `getDb()` resolves to prod anyway, so this just makes the probe's env
// explicit and the cache entry unambiguously a prod entry.
const cachedByPeriod: Record<
  CoinsPeriod,
  (p: CoinsPeriod) => Promise<CoinsEconomyResult>
> = {
  "24h": unstable_cache(
    (p: CoinsPeriod) => queryCoinsEconomy(p, "prod"),
    ["insights-coins-24h-v1"],
    { revalidate: cacheTtlForPeriod("24h"), tags: ["insights-coins"] },
  ),
  "7d": unstable_cache(
    (p: CoinsPeriod) => queryCoinsEconomy(p, "prod"),
    ["insights-coins-7d-v1"],
    { revalidate: cacheTtlForPeriod("7d"), tags: ["insights-coins"] },
  ),
  "30d": unstable_cache(
    (p: CoinsPeriod) => queryCoinsEconomy(p, "prod"),
    ["insights-coins-30d-v1"],
    { revalidate: cacheTtlForPeriod("30d"), tags: ["insights-coins"] },
  ),
  all: unstable_cache(
    (p: CoinsPeriod) => queryCoinsEconomy(p, "prod"),
    ["insights-coins-all-v1"],
    { revalidate: cacheTtlForPeriod("all"), tags: ["insights-coins"] },
  ),
};

/**
 * Public entry point. Returns the global coin/shard economy (supply
 * snapshot + period-scoped flow) for ONE window. Cached per-period on prod
 * (60s / 300s); direct (uncached) on a dev-toggled admin so they see live
 * dev data. ACTIVE-TIMEFRAME-ONLY: the caller fetches only the active
 * window — no eager preload of the others.
 */
export async function getCoinsEconomy(
  period: CoinsPeriod,
): Promise<CoinsEconomyResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryCoinsEconomy(period, env);
  return cachedByPeriod[period](period);
}
