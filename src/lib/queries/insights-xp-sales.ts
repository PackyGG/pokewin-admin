import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";
import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getMetricsScope } from "@/lib/metrics/scope";
import { isLiveLedgerTxType } from "@/lib/queries/_ledger-tx-types";

/**
 * Global XP-sales economy — the data layer behind the /xp-sales page.
 *
 * WHAT AN `xp_purchase` ROW MEANS (verified read-only against dev, 2026-06-14)
 * ──────────────────────────────────────────────────────────────────────────
 * `ledger_transactions.type = 'xp_purchase'` is the user spending their own
 * (withdrawable) USD balance to BUY XP. It is a DEBIT: every sampled row has
 * `balance_after = balance_before − amount` (e.g. 71941.74 → 71940.74, a $1.00
 * spend). `amount` is therefore the USD balance the user GAVE UP — our
 * "XP revenue" — NOT the XP granted. The XP granted is carried in
 * `metadata.xp_awarded` (an integer; e.g. 200 XP for $1). 178 rows on dev,
 * total $28,224.88 spent, range $1.00–$1000.00.
 *
 * HOUSE-POV (CLAUDE.md "Finanz-Farben")
 * ─────────────────────────────────────
 * A user spending withdrawable balance to buy XP gives up a dollar we owed
 * them → a house GAIN → emerald for the revenue figure. Counts (sales,
 * buyers) are neutral signals → cyan/blue. XP granted is a non-USD secondary
 * unit → neutral.
 *
 * SCOPE: customer-only via `getMetricsScope()` (staff + creators + blacklist
 * dropped wholesale), exactly like every other money-metric surface, so a
 * creator buying XP "for content" never inflates XP revenue.
 *
 * DRIFT GUARD: `xp_purchase` is present on the committed schema enum (synced
 * 2026-06-14) AND on both live DBs, but the read still goes through
 * `isLiveLedgerTxType` so a DB that lacks the member degrades to a clean
 * empty result instead of throwing `22P02`. The `upgrader_*` runtime drift
 * guards are untouched.
 *
 * READ-ONLY. SELECT only — no writes, no game-data mutation. Safe against the
 * live production DB.
 */

// ─── Period model ─────────────────────────────────────────────────────

export type XpSalesPeriod = "24h" | "7d" | "30d" | "all";

export function parseXpSalesPeriod(value: string | undefined): XpSalesPeriod {
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

export function xpSalesPeriodLabel(p: XpSalesPeriod): string {
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
 * unbounded full-history scan (CLAUDE.md "Performance & Daten-Laden"). The XP
 * shop is young, so 365d covers all activity. Mirrors the reward-insights /
 * coins 365d cap.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(p: XpSalesPeriod): number {
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

function cacheTtlForPeriod(p: XpSalesPeriod): number {
  return p === "all" ? 300 : 60;
}

// ─── Result shapes ────────────────────────────────────────────────────

/** One recent XP sale for the recent-sales list. */
type XpSaleRow = {
  id: string;
  userId: string;
  username: string | null;
  /** USD balance the user spent to buy XP (a house gain). */
  amount: number;
  /** XP granted (from metadata.xp_awarded); null when not present. */
  xpAwarded: number | null;
  createdAt: string;
};

/** One day of XP-sales flow for the trend chart. */
export type XpSalesDailyPoint = {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** USD spent on XP that day (house revenue). */
  revenue: number;
  /** Number of XP sales that day. */
  sales: number;
};

export type XpSalesResult = {
  period: XpSalesPeriod;
  /** Total number of `xp_purchase` rows in the window. */
  saleCount: number;
  /** Total USD spent on XP in the window = our XP revenue (house gain). */
  revenue: number;
  /** Distinct buyers in the window. */
  buyers: number;
  /** Average USD per sale (revenue / saleCount). */
  avgPerSale: number;
  /** Total XP granted in the window (Σ metadata.xp_awarded), 0 when absent. */
  xpGranted: number;
  /** Recent sales, newest first (capped). */
  recent: XpSaleRow[];
  /** Daily revenue + sales trend over the window. */
  daily: XpSalesDailyPoint[];
};

const EMPTY_RESULT = (period: XpSalesPeriod): XpSalesResult => ({
  period,
  saleCount: 0,
  revenue: 0,
  buyers: 0,
  avgPerSale: 0,
  xpGranted: 0,
  recent: [],
  daily: [],
});

/** Cap on the recent-sales list — enough to scan, bounded for payload size. */
const RECENT_LIMIT = 25;

// ─── Core query (uncached) ────────────────────────────────────────────

type RawAggRow = {
  sale_count: bigint | number;
  revenue: string | number | null;
  buyers: bigint | number;
  xp_granted: string | number | null;
};

type RawRecentRow = {
  id: string;
  user_id: string;
  username: string | null;
  amount: string | number | null;
  xp_awarded: string | number | null;
  created_at: Date | string;
};

type RawDailyRow = {
  day: string;
  revenue: string | number | null;
  sales: bigint | number;
};

async function queryXpSales(period: XpSalesPeriod): Promise<XpSalesResult> {
  // Drift guard: skip the whole read if the connected enum lacks the member
  // (degrade to empty instead of throwing 22P02). Same posture as the coins
  // table probe — a clean empty result, never a crash.
  if (!(await isLiveLedgerTxType("xp_purchase"))) {
    return EMPTY_RESULT(period);
  }

  const days = daysForPeriod(period);
  const scope = await getMetricsScope();
  // Customer scope as a flat fragment (no CTE needed for these aggregates) —
  // staff + creators + blacklist + creator-on-session rows dropped, exactly
  // like every other money-metric surface. The fragment inlines only
  // hardcoded identifiers (see scope.ts contract). `days` is a number literal
  // (numeric switch above), `'xp_purchase'` and `RECENT_LIMIT` are constants —
  // no injection surface, so legacy raw query matches the house pattern in
  // analytics.ts (which composes the same scope fragment into raw SQL).
  const scopeFrag = scope.exclStaffSessionFrag({
    userCol: "lt.user_id",
    tsCol: "lt.created_at",
  });
  const sinceFrag = `lt.created_at >= NOW() - (${days} * INTERVAL '1 day')`;

  // ── Window aggregate: count, revenue (Σ amount), distinct buyers, and XP
  //    granted (Σ metadata.xp_awarded — guarded to a numeric cast so a row
  //    without the key contributes 0 rather than erroring).
  const aggRows = await queryMainRows<RawAggRow[]>(`
    SELECT
      COUNT(*)::bigint AS sale_count,
      COALESCE(SUM(lt.amount), 0)::text AS revenue,
      COUNT(DISTINCT lt.user_id)::bigint AS buyers,
      COALESCE(SUM(
        CASE WHEN jsonb_typeof(lt.metadata -> 'xp_awarded') = 'number'
             THEN (lt.metadata ->> 'xp_awarded')::numeric
             ELSE 0 END
      ), 0)::text AS xp_granted
    FROM ledger_transactions lt
    WHERE lt.type = 'xp_purchase'
      AND ${sinceFrag}
      ${scopeFrag}
  `);
  const agg = aggRows[0];
  const saleCount = Number(agg?.sale_count ?? 0);
  const revenue = Number(agg?.revenue ?? 0);
  const buyers = Number(agg?.buyers ?? 0);
  const xpGranted = Number(agg?.xp_granted ?? 0);

  // Early-out: nothing in the window → skip the recent + daily reads.
  if (saleCount === 0) return EMPTY_RESULT(period);

  // The recent-sales list and the daily-trend aggregate are independent
  // (distinct shapes, no cross-reference) and always run together once the
  // window is non-empty, so fire them concurrently. This removes one full
  // ledger scan of serial latency while keeping the EXACT same SQL, output
  // shape, and numbers — purely a scheduling change. The window aggregate
  // above stays sequential because its `saleCount` gates whether these run.
  const [recentRows, dailyRows] = await Promise.all([
    // ── Recent sales (newest first), joined to the username for display.
    queryMainRows<RawRecentRow[]>(`
      SELECT
        lt.id::text AS id,
        lt.user_id::text AS user_id,
        u.username AS username,
        lt.amount::text AS amount,
        CASE WHEN jsonb_typeof(lt.metadata -> 'xp_awarded') = 'number'
             THEN (lt.metadata ->> 'xp_awarded')
             ELSE NULL END AS xp_awarded,
        lt.created_at AS created_at
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.type = 'xp_purchase'
        AND ${sinceFrag}
        ${scopeFrag}
      ORDER BY lt.created_at DESC
      LIMIT ${RECENT_LIMIT}
    `),
    // ── Daily revenue + sales trend over the window.
    queryMainRows<RawDailyRow[]>(`
      SELECT
        to_char(date_trunc('day', lt.created_at), 'YYYY-MM-DD') AS day,
        COALESCE(SUM(lt.amount), 0)::text AS revenue,
        COUNT(*)::bigint AS sales
      FROM ledger_transactions lt
      WHERE lt.type = 'xp_purchase'
        AND ${sinceFrag}
        ${scopeFrag}
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const recent: XpSaleRow[] = recentRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    amount: Number(r.amount ?? 0),
    xpAwarded: r.xp_awarded != null ? Number(r.xp_awarded) : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));

  const daily: XpSalesDailyPoint[] = dailyRows.map((r) => ({
    date: r.day,
    revenue: Number(r.revenue ?? 0),
    sales: Number(r.sales ?? 0),
  }));

  return {
    period,
    saleCount,
    revenue,
    buyers,
    avgPerSale: saleCount > 0 ? revenue / saleCount : 0,
    xpGranted,
    recent,
    daily,
  };
}

// ─── Env-keyed cache wrapper ──────────────────────────────────────────
//
// Identical reasoning to `insights-coins.ts` / `users-detail-cache.ts`:
// `unstable_cache` runs its callback OUTSIDE request scope, so `cookies()`
// (and `readDbEnv`) inside the MAIN client resolver falls back to "prod". Caching a
// dev-toggled request would serve PROD data to a dev admin. So: cache ONLY on
// prod (the default + hot path); a dev-toggled admin runs the query directly
// so they always see live dev data.

const cachedByPeriod: Record<
  XpSalesPeriod,
  (p: XpSalesPeriod) => Promise<XpSalesResult>
> = {
  "24h": unstable_cache(
    (p: XpSalesPeriod) => queryXpSales(p),
    ["insights-xp-sales-24h-v1"],
    { revalidate: cacheTtlForPeriod("24h"), tags: ["insights-xp-sales"] },
  ),
  "7d": unstable_cache(
    (p: XpSalesPeriod) => queryXpSales(p),
    ["insights-xp-sales-7d-v1"],
    { revalidate: cacheTtlForPeriod("7d"), tags: ["insights-xp-sales"] },
  ),
  "30d": unstable_cache(
    (p: XpSalesPeriod) => queryXpSales(p),
    ["insights-xp-sales-30d-v1"],
    { revalidate: cacheTtlForPeriod("30d"), tags: ["insights-xp-sales"] },
  ),
  all: unstable_cache(
    (p: XpSalesPeriod) => queryXpSales(p),
    ["insights-xp-sales-all-v1"],
    { revalidate: cacheTtlForPeriod("all"), tags: ["insights-xp-sales"] },
  ),
};

/**
 * Public entry point. Returns the global XP-sales economy for ONE window.
 * Cached per-period on prod (60s / 300s); direct (uncached) on a dev-toggled
 * admin so they see live dev data. ACTIVE-TIMEFRAME-ONLY: the caller fetches
 * only the active window — no eager preload of the others.
 */
export async function getXpSales(period: XpSalesPeriod): Promise<XpSalesResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryXpSales(period);
  return cachedByPeriod[period](period);
}
