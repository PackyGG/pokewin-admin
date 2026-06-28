import "server-only";

import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";

/**
 * Per-day CRYPTO FEE PROFIT for the dashboard Daily-P&L hover (informational).
 *
 * Daily breakdown of the same house-side crypto exchange-rate fee that backs
 * the dashboard's "Crypto Fee" KPI tile (see `dashboard-crypto-fee-counter.ts`
 * for the full mechanics + reasoning). The KPI tile shows the anchored,
 * monotonic LIFETIME total since `count_start_at` — this query buckets the
 * same source set by day so the per-day P&L tooltip can surface what the
 * house made on crypto that specific UTC day.
 *
 *   fee(day) = Σ(completed crypto deposit USD that day)  × depositBps/10000
 *            + Σ(completed crypto withdrawal USD that day) × withdrawalBps/10000
 *
 * House-POV: a POSITIVE figure is house GAIN (we netted fee on crypto flows),
 * so the tooltip renders it emerald. Zero on days with no crypto flows.
 *
 * INFORMATIONAL ONLY — NOT added to the P&L total. The crypto fee is an
 * estimated house-side exchange-rate margin that doesn't move on-site
 * balances (the user receives/sends the displayed USD figure), so it isn't
 * a separate term inside the canonical pnl formula. The tooltip surfaces it
 * as context, mirroring how `getDailyCreatorCost` is surfaced.
 *
 * Locked-bps + anchor: the bps midpoints + `count_start_at` are read from the
 * admin counter row so the historical math can't be retroactively moved by a
 * later band change — same lock the lifetime tile uses. Days BEFORE the
 * anchor are simply absent from the result (we never display crypto-fee
 * profit for pre-anchor days, matching the tile's "since Jun 14" semantic).
 *
 * Index-or-ClickHouse (indexed Postgres, EXPLAIN-verified on prod):
 *   • ledger → `idx_ledger_tx_created_at` covers the 30-day created_at scan;
 *     `crypto_asset IS NOT NULL` + `status='completed'` + `type IN (…)` are
 *     enum-safe heap filters on the indexed range. The lifetime counter
 *     issues the same shape of query against the same index.
 *
 * Bounded to the LAST 30 DAYS to align with the Daily-P&L chart window (the
 * chart consumer only renders 30 day-buckets, so 30 days is the maximum the
 * tooltip ever needs). The date key matches `computeDailyPnl` exactly
 * (`new Date(d).toISOString().slice(0, 10)`) so the page-level merge aligns.
 *
 * Cached 5 min keyed on the UTC day (same shape as `dashboard-daily-creator
 * -cost`). Degrades to `[]` when:
 *   • the admin counter row is missing/unavailable (we can't anchor),
 *   • the live ledger lacks the `crypto_asset` column (host swap to partial
 *     schema — runtime drift-guard, same as the lifetime tile).
 * A degraded result hides the tooltip line silently rather than crashing the
 * chart; the lifetime KPI tile surfaces the unavailable state.
 */

const COUNTER_ID = "singleton";

/** Postgres error codes meaning the table/row isn't provisioned (degrade). */
function isMissingObjectError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // P2021 = table does not exist; P2025 = record not found; 42P01 = undefined_table.
  return code === "P2021" || code === "P2025" || code === "42P01";
}

export type DailyCryptoFeeProfitPoint = {
  /** YYYY-MM-DD (UTC) — same key form as DailyPnlPoint.date. */
  date: string;
  /** Estimated house crypto-fee profit that day, >= 0. */
  cryptoFeeProfit: number;
};

async function computeDailyCryptoFeeProfit(): Promise<DailyCryptoFeeProfitPoint[]> {
  return withTiming("dashboard.dailyCryptoFeeProfit", async () => {
    // 1. Read the admin counter row for the locked bps + anchor day. Missing
    //    row → no display (degrade silently).
    let row;
    try {
      row = await adminDb.crypto_fee_profit_counter.findUnique({
        where: { id: COUNTER_ID },
      });
    } catch (err) {
      if (isMissingObjectError(err)) return [];
      throw err;
    }
    if (!row) return [];

    const depositBps = toNumber(row.deposit_fee_bps);
    const withdrawalBps = toNumber(row.withdrawal_fee_bps);
    const countStart = new Date(row.count_start_at);
    const countStartIso = countStart.toISOString();

    // 2. Per-day crypto volume from the GAME DB.
    const db = await getDb();

    // Drift-guard: prove the crypto columns this query needs exist. Same
    // guard the lifetime counter uses — a host swap to a partial schema must
    // not crash the chart; we just hide the per-day line.
    const guard = await db.$queryRaw<
      { has_crypto_asset: boolean; has_amount: boolean }[]
    >`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
            AND column_name = 'crypto_asset'
        ) AS has_crypto_asset,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ledger_transactions'
            AND column_name = 'amount'
        ) AS has_amount
    `;
    const g = guard[0];
    if (!g || !g.has_crypto_asset || !g.has_amount) return [];

    type Row = {
      d: Date;
      deposit_usd: string | null;
      withdrawal_usd: string | null;
    };

    // Bucket by UTC day. Bounded to the chart window (30d) AND the anchor —
    // anything before count_start_at is excluded (the tile starts counting
    // from there, the daily hover stays consistent with that semantic).
    const rows = await db.$queryRaw<Row[]>`
      SELECT DATE(created_at) AS d,
        SUM(amount) FILTER (
          WHERE type::text = 'deposit'
        )::text AS deposit_usd,
        SUM(amount) FILTER (
          WHERE type::text IN ('card_withdrawal', 'balance_withdrawal')
        )::text AS withdrawal_usd
      FROM ledger_transactions
      WHERE crypto_asset IS NOT NULL
        AND status::text = 'completed'
        AND type::text IN ('deposit', 'card_withdrawal', 'balance_withdrawal')
        AND created_at >= NOW() - INTERVAL '30 days'
        AND created_at >= ${countStartIso}::timestamptz
      GROUP BY DATE(created_at)
    `;

    const depositRate = depositBps / 10_000;
    const withdrawalRate = withdrawalBps / 10_000;

    return rows
      .map((r) => {
        const dep = toNumber(r.deposit_usd);
        const wd = toNumber(r.withdrawal_usd);
        return {
          date: new Date(r.d).toISOString().slice(0, 10),
          cryptoFeeProfit: dep * depositRate + wd * withdrawalRate,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  });
}

/**
 * Cached wrapper — keyed on the UTC day string so the 30-day window stays
 * fresh across the 00:00-UTC rollover (mirrors `cachedDailyCreatorCost`).
 * The day key is resolved in request scope and passed in (it only
 * participates in the cache key; the compute reads the live `NOW()` window
 * itself).
 */
const cachedDailyCryptoFeeProfit = unstable_cache(
  async (dayKey: string): Promise<DailyCryptoFeeProfitPoint[]> => {
    void dayKey;
    return computeDailyCryptoFeeProfit();
  },
  ["dashboard-daily-crypto-fee-profit-v1"],
  { revalidate: 300, tags: ["dashboard-crypto-fee-counter"] },
);

export async function getDailyCryptoFeeProfit(): Promise<
  DailyCryptoFeeProfitPoint[]
> {
  const dayKey = new Date().toISOString().slice(0, 10);
  return cachedDailyCryptoFeeProfit(dayKey);
}
