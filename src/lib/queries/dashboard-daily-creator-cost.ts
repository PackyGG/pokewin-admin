import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { withTiming } from "@/lib/observability/query-timings";
import { filterVoucherOriginsLive } from "@/lib/queries/_voucher-origins";

/**
 * Per-day CREATOR COST for the dashboard Daily-P&L hover (informational).
 *
 * Creator cost = converted creator payouts + leaderboard prizes, bucketed by
 * event day over the last 30 days — the SAME two definitions the
 * "Creators Costs (today)" box uses, just per-day instead of today-only, and
 * WITHOUT tips (owner: "converted payouts and leaderboard prizes ... count as
 * creator cost on the graph, nothing else"):
 *   • Converted payouts = vouchers minted that day with origin
 *     `creator_fill_conversion` (fill program) or `creator_multiplier_payout`
 *     (multiplier deals) — Σ value, the house cost recognized at mint (same
 *     source as `/creators` "Converted" + the Creators Costs box).
 *   • Leaderboard prizes = `affiliate_leaderboard_prize` ledger payouts that
 *     day at FULL gross (Σ |amount|) — every affiliate leaderboard is a
 *     creator-run event (owner, 2026-06-04).
 *
 * INFORMATIONAL ONLY — NOT added to the P&L total. These costs are already
 * inside the daily balance / voucher deltas that build P&L; the hover surfaces
 * them as context, it does not re-subtract them. House-POV: money paid out →
 * house cost → rose in the UI.
 *
 * Index-or-ClickHouse (indexed Postgres, EXPLAIN-verified on prod):
 *   • vouchers → `idx_vouchers_origin_created_at` (Bitmap Index Scan, ~1.4ms)
 *     via the NATIVE enum `origin IN (…::voucher_origin)` form — the `::text`
 *     cast forces a Seq Scan. `filterVoucherOriginsLive` keeps the native form
 *     drift-safe (only emits members the live enum actually has).
 *   • ledger → `idx_ledger_tx_created_at` (the same created_at index the
 *     Daily-P&L scan already uses); `type::text =` is an enum-safe heap filter
 *     on the indexed created_at range.
 * Bounded to 30 days. The date key matches `computeDailyPnl` exactly
 * (`new Date(d).toISOString().slice(0, 10)`) so the page-level merge aligns.
 *
 * Gross house spend — NOT customer-scoped (mirrors the Creators Costs box:
 * the receiving user is whoever the creator paid, so the gross is the honest
 * figure). Cached 5 min keyed on the UTC day (same shape as `cachedDailyPnl`).
 */

const WINDOW_DAYS = 30;

const CONVERTED_PAYOUT_ORIGINS = [
  "creator_fill_conversion",
  "creator_multiplier_payout",
] as const;

export type DailyCreatorCostPoint = {
  /** YYYY-MM-DD (UTC) — same key form as DailyPnlPoint.date. */
  date: string;
  /** Creator cost that day (converted payouts + leaderboard gross), >= 0. */
  creatorCost: number;
};

async function computeDailyCreatorCost(): Promise<DailyCreatorCostPoint[]> {
  return withTiming("dashboard.dailyCreatorCost", async () => {
    const db = await getDb();

    // Native-enum, drift-safe origin list (keeps the index path; never throws
    // 22P02 if a member is absent from the live enum).
    const liveOrigins = await filterVoucherOriginsLive(CONVERTED_PAYOUT_ORIGINS);

    type Row = { d: Date; amt: number };

    const voucherPromise =
      liveOrigins.length > 0
        ? db.$queryRawUnsafe<Row[]>(
            `SELECT DATE(created_at) AS d, COALESCE(SUM(value::numeric), 0)::float8 AS amt
             FROM vouchers
             WHERE origin IN (${liveOrigins
               .map((o) => `'${o}'::voucher_origin`)
               .join(", ")})
               AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'
             GROUP BY DATE(created_at)`,
          )
        : Promise.resolve([] as Row[]);

    const ledgerPromise = db.$queryRawUnsafe<Row[]>(
      `SELECT DATE(created_at) AS d, COALESCE(SUM(ABS(amount::numeric)), 0)::float8 AS amt
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text = 'affiliate_leaderboard_prize'
         AND created_at >= NOW() - INTERVAL '${WINDOW_DAYS} days'
       GROUP BY DATE(created_at)`,
    );

    const [vouchers, ledger] = await Promise.all([voucherPromise, ledgerPromise]);

    const byDay = new Map<string, number>();
    const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);
    for (const r of vouchers) {
      const k = dayKey(r.d);
      byDay.set(k, (byDay.get(k) ?? 0) + Number(r.amt));
    }
    for (const r of ledger) {
      const k = dayKey(r.d);
      byDay.set(k, (byDay.get(k) ?? 0) + Number(r.amt));
    }

    return [...byDay.entries()]
      .map(([date, creatorCost]) => ({ date, creatorCost }))
      .sort((a, b) => a.date.localeCompare(b.date));
  });
}

/**
 * Cached wrapper — keyed on the UTC day string so the 30-day window stays
 * fresh across the 00:00-UTC rollover (mirrors `cachedDailyPnl`). The day key
 * is resolved in request scope and passed in (it only participates in the
 * cache key; the compute reads the live `NOW()` window itself).
 */
const cachedDailyCreatorCost = unstable_cache(
  async (dayKey: string): Promise<DailyCreatorCostPoint[]> => {
    void dayKey;
    return computeDailyCreatorCost();
  },
  ["dashboard-daily-creator-cost-v1"],
  { revalidate: 300, tags: ["dashboard-activity"] },
);

export async function getDailyCreatorCost(): Promise<DailyCreatorCostPoint[]> {
  const dayKey = new Date().toISOString().slice(0, 10);
  return cachedDailyCreatorCost(dayKey);
}
