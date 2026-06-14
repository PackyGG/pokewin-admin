import "server-only";
import { unstable_cache } from "next/cache";
import { getDb, getProdDb, getDevDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";

/**
 * Secondary-currency (coin/shard) economy data layer. The standalone
 * /insights/coins page was removed; the surviving consumer is the
 * /rewards/shards panel via `shard-stats.ts`, which projects the
 * period-scoped FLOW (earned/spent/netHouse/issued/categories) out of
 * `getCoinsEconomy`. The free-to-play coin BALANCE wallet number was removed
 * everywhere; only the shard supply snapshot + the coin_transactions flow
 * remain.
 *
 * WHAT THIS READS
 * ───────────────
 * Two things, both from the MAIN game DB, both READ-ONLY:
 *
 *   1. SUPPLY (a snapshot, no period): the live `Σ balances.shards`
 *      (the wager-earned shard currency) plus the holder count. This is
 *      "how many shards are currently out there", independent of any time
 *      window.
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
};

/**
 * Currency-ISSUANCE types — coins/shards the HOUSE MINTED INTO existence and
 * handed to users, NOT coins a game paid out. These are house-funded issuance
 * (a liability the house created), not bets-vs-payouts game flow, so they must
 * be kept OUT of the `earned`/`netHouse` game-flow math and surfaced as a
 * separate ISSUANCE line. Mirrors the grant-vs-winning split in
 * `users-shard-winnings.ts` (which excludes exactly these from "winnings").
 *
 *   • coin_deposit_grant            — coins granted on a deposit (always +).
 *   • coin_admin_adjustment (+ leg) — an admin crediting coins to a user.
 *
 * `coin_admin_adjustment` is direction-split: its POSITIVE leg is issuance
 * (house mints coins to the user); its NEGATIVE leg is a claw-back (house
 * removes coins) which is NOT issuance and stays in the spent/game side. So
 * the exclusion is "this type AND earned direction", never the whole type.
 */
const ISSUANCE_TYPES: ReadonlySet<string> = new Set([
  "coin_deposit_grant",
  "coin_admin_adjustment",
]);

/**
 * True when a ledger row is house→user currency ISSUANCE (minted coins), not a
 * game payout. Only the EARNED leg of an issuance type counts (a negative
 * `coin_admin_adjustment` claw-back is not issuance).
 */
function isIssuance(type: string, direction: "earned" | "spent"): boolean {
  return direction === "earned" && ISSUANCE_TYPES.has(type);
}

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
  /**
   * True when this row is house→user currency ISSUANCE (a minted grant), not
   * game flow. Issuance is EXCLUDED from the earned/netHouse game-flow totals
   * and shown as a separate line, so the UI can flag it instead of folding it
   * into "earned".
   */
  isIssuance: boolean;
};

/** One day of game-flow earned-vs-spent for the trend chart. */
export type CoinDailyPoint = {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /**
   * Coins/shards a GAME paid out to users that day (balance increased),
   * EXCLUDING house-funded issuance (grants) — so this is true game flow and
   * the two series sum back to the window's game-flow totals.
   */
  earned: number;
  /** Coins/shards spent (balance decreased) that day. */
  spent: number;
  /** Net house GAME flow that day = spent − earned (issuance excluded). */
  netHouse: number;
};

export type CoinsEconomyAvailable = {
  available: true;
  period: CoinsPeriod;
  supply: CoinSupply;
  /**
   * Coins/shards a GAME paid out to users (balance increases) in the window —
   * i.e. game WINS only. EXCLUDES house-funded issuance (`coin_deposit_grant`
   * and the positive leg of `coin_admin_adjustment`); that is surfaced
   * separately as `issuedToUsers`. This is what feeds `netHouse`, so netHouse
   * reflects ONLY bets-vs-payouts game flow.
   */
  earned: number;
  /** Total coins/shards SPENT by users (balance decreases) in the window. */
  spent: number;
  /**
   * Net house GAME flow = spent − earned (issuance EXCLUDED). Positive ⇒ users
   * net lost coins into games (house took in / the economy is self-funding);
   * negative ⇒ games paid out more than users wagered. This is a pure
   * game-flow read — a healthy economy is no longer dragged negative just
   * because the house MINTED coins (issuance), which lands in `issuedToUsers`.
   */
  netHouse: number;
  /** Total ledger rows in the window. */
  txCount: number;
  /** Distinct users with any coin/shard activity in the window. */
  activeUsers: number;
  /**
   * Coins/shards the HOUSE ISSUED to users in the window — minted grants, NOT
   * game payouts: `coin_deposit_grant` + the positive leg of
   * `coin_admin_adjustment`. This is house-funded issuance (a created
   * liability), shown as its OWN line so it is never mistaken for game flow.
   */
  issuedToUsers: number;
  /** Per-type breakdown, sorted by total desc. */
  categories: CoinCategoryRow[];
  /** Daily game-flow earned-vs-spent trend over the window. */
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
      COUNT(*) FILTER (WHERE shards > 0)::bigint AS shard_holders
    FROM balances`;
  const supplyRaw = supplyRows[0];
  const supply: CoinSupply = {
    totalShards: Number(supplyRaw?.total_shards ?? 0),
    shardHolders: Number(supplyRaw?.shard_holders ?? 0),
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

  // GAME-FLOW totals (issuance excluded). `earned` here is ONLY coins a game
  // paid out (wins); house-funded issuance (deposit grants + positive admin
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
  const byType = new Map<string, CoinCategoryRow>();

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

  // ── Daily GAME-FLOW earned-vs-spent trend over the window. The `earned`
  //    series is game payouts ONLY — house-funded issuance (the earned leg of
  //    an ISSUANCE_TYPES row) is EXCLUDED, exactly as in the window totals
  //    above, so the daily series sum back to those totals and the daily
  //    netHouse matches the window netHouse (no grant drags a day negative).
  //    The issuance type list is bound as a parameterised text array (no
  //    interpolation → no injection surface). `spent` is the balance-decrease
  //    leg (a negative admin claw-back stays here, same as the totals).
  const issuanceTypes: string[] = [...ISSUANCE_TYPES];
  const dailyRows = await db.$queryRaw<RawDailyRow[]>`
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      COALESCE(SUM(amount) FILTER (
        WHERE balance_after >= balance_before
          AND NOT (type::text = ANY(${issuanceTypes}))
      ), 0)::text AS earned,
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
    issuedToUsers,
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
