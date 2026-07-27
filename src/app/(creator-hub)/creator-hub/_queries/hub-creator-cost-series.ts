import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  hubBucketByHour,
  hubPeriodToInterval,
} from "./hub-period-sql";

/**
 * Creator Hub dashboard — windowed CREATOR-COST TIME SERIES.
 *
 * Per-bucket (day or hour) total of every house cost on creators in the active
 * period chip — the SAME three legs the dashboard KPI box and Audit Spend
 * route sum, just bucketed for charting:
 *
 *   • Converted deal payouts — `creator_fill_conversion` + `creator_multiplier_payout`
 *     vouchers minted in the bucket (`vouchers.created_at`).
 *   • House-funded creator tips — `creator_fill_spend_tip` ledger rows
 *     (status='completed', Σ |amount|).
 *   • Full affiliate leaderboard prize gross — `affiliate_leaderboard_prize`
 *     ledger rows (status='completed', Σ |amount|).
 *
 * House-POV per CLAUDE.md: every leg is money the house PAID OUT → a cost →
 * the chart renders ROSE.
 *
 * ─── INDEXING (verified read-only, EXPLAIN ANALYZE against prod 2026-06-23) ─
 *
 *   • vouchers leg uses `idx_vouchers_origin_created_at`
 *     (Bitmap Index Scan, ~5ms over a 7d window).
 *   • ledger leg uses `idx_ledger_tx_created_at`
 *     (Index Scan, ~90ms over a 7d window — same plan the
 *     `dashboard-creator-costs-today` canonical query uses).
 *
 * no seq scan on MAIN.
 *
 * ─── PERFORMANCE / SCOPE ────────────────────────────────────────────────
 *
 * Active-Timeframe-Only: only the active period is computed; `unstable_cache`
 * keyed on the period label (revalidate 60s, same cadence as the dashboard
 * KPI box). `safeQueryOrNull`-friendly (the page wraps the await). Three
 * windowed aggregates running in parallel (Promise.all). No staff/blacklist
 * filter — the underlying cost legs are house spend on creator activity, so
 * the gross figure is the honest one (matches `dashboard-creator-costs-today`
 * and `getHubCreatorCostBreakdown`).
 */

export type CreatorCostBucket = {
  /** ISO bucket start in UTC. */
  bucketIso: string;
  /** Decimal-safe total cost for this bucket. */
  costUsd: number;
};

export type CreatorCostSeries = {
  /** Bucket granularity used by the SQL `DATE_TRUNC` call. */
  granularity: "day" | "hour";
  /** Sorted ASC by bucket. */
  buckets: CreatorCostBucket[];
};

/** Bucket unit for the active Hub period — hour for 24h, day otherwise. */
function bucketUnit(period: DashboardPeriod): "day" | "hour" {
  return hubBucketByHour(period) ? "hour" : "day";
}

const cachedCreatorCostSeries = unstable_cache(
  async (period: DashboardPeriod): Promise<CreatorCostSeries> => {
    return withTiming("creator-hub.creatorCostSeries", async () => {
      return creatorCostSeriesFromPg(period);
    });
  },
  ["hub-creator-cost-series-v1"],
  { revalidate: 60, tags: ["creator-hub"] },
);

export async function getHubCreatorCostSeries(
  period: DashboardPeriod,
): Promise<CreatorCostSeries> {
  return cachedCreatorCostSeries(period);
}

async function creatorCostSeriesFromPg(
  period: DashboardPeriod,
): Promise<CreatorCostSeries> {
  const db = await getReadDrizzleDb();
  const unit = bucketUnit(period);
  const interval = hubPeriodToInterval(period);
  const since = `NOW() - INTERVAL '${interval}'`;

  type VoucherRow = { bucket: Date; cost: string };
  type LedgerRow = { bucket: Date; tips: string; lb: string };

  // Converted deal payouts (fill conversion + multiplier payout vouchers).
  const voucherSql = `
    SELECT DATE_TRUNC('${unit}', v.created_at) AS bucket,
           COALESCE(SUM(v.value::numeric), 0)::text AS cost
      FROM vouchers v
     WHERE v.origin::text IN ('creator_fill_conversion','creator_multiplier_payout')
       AND v.created_at >= ${since}
     GROUP BY DATE_TRUNC('${unit}', v.created_at)`;

  // Tips + leaderboard gross (combined one-pass aggregate on the ledger).
  const ledgerSql = `
    SELECT DATE_TRUNC('${unit}', created_at) AS bucket,
           COALESCE(SUM(CASE WHEN type::text = 'creator_fill_spend_tip'      THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS tips,
           COALESCE(SUM(CASE WHEN type::text = 'affiliate_leaderboard_prize' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS lb
      FROM ledger_transactions
     WHERE status = 'completed'
       AND type::text IN ('creator_fill_spend_tip','affiliate_leaderboard_prize')
       AND created_at >= ${since}
     GROUP BY DATE_TRUNC('${unit}', created_at)`;

  const [voucherRows, ledgerRows] = await Promise.all([
    queryRows<VoucherRow[]>(db, voucherSql),
    queryRows<LedgerRow[]>(db, ledgerSql),
  ]);

  const byBucket = new Map<string, number>();
  const addBucket = (d: Date, amount: number) => {
    if (amount === 0) return;
    const key = new Date(d).toISOString();
    byBucket.set(key, (byBucket.get(key) ?? 0) + amount);
  };

  for (const r of voucherRows) addBucket(r.bucket, toNumber(r.cost));
  for (const r of ledgerRows) {
    addBucket(r.bucket, toNumber(r.tips) + toNumber(r.lb));
  }

  const buckets: CreatorCostBucket[] = [...byBucket.entries()]
    .map(([bucketIso, costUsd]) => ({ bucketIso, costUsd }))
    .sort((a, b) => a.bucketIso.localeCompare(b.bucketIso));

  return { granularity: unit, buckets };
}

/**
 * Pad a sparse series with zero-cost buckets so the chart draws a continuous
 * window. Mirrors the bucket-count rules in `hub-chart-series.ts` (24 hourly
 * buckets for the 24h chip, day buckets for everything else).
 */
export function padCreatorCostSeries(
  series: CreatorCostSeries,
  period: DashboardPeriod,
): CreatorCostBucket[] {
  const hourly = hubBucketByHour(period);
  const count = bucketCountForPeriod(period);
  const byKey = new Map(series.buckets.map((b) => [bucketKey(b.bucketIso, hourly), b.costUsd]));
  const out: CreatorCostBucket[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (hourly) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
    }
    const key = bucketKey(d.toISOString(), hourly);
    out.push({ bucketIso: d.toISOString(), costUsd: byKey.get(key) ?? 0 });
  }
  return out;
}

function bucketKey(iso: string, hourly: boolean): string {
  return hourly ? iso.slice(0, 13) : iso.slice(0, 10);
}

const HUB_LIFETIME_BUCKET_DAYS = 365;

function bucketCountForPeriod(period: DashboardPeriod): number {
  if (hubBucketByHour(period)) return 24;
  switch (period) {
    case "1h":
    case "3h":
    case "6h":
    case "12h":
      return 1;
    case "48h":
      return 2;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return HUB_LIFETIME_BUCKET_DAYS;
    case "24h":
      return 24;
  }
}
