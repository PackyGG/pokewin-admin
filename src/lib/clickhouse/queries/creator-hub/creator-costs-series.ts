import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "@/lib/clickhouse/queries/_shared";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

/**
 * Creator Hub dashboard — windowed CREATOR-COST TIME SERIES, ClickHouse twin
 * of the Postgres `creatorCostSeriesFromPg`
 * (src/app/(creator-hub)/creator-hub/_queries/hub-creator-cost-series.ts).
 *
 * Mirrors the SAME three cost legs the PG twin sums, bucketed identically:
 *   • Converted deal payouts   = Σ vouchers.value WHERE
 *                                 origin IN ('creator_fill_conversion',
 *                                            'creator_multiplier_payout')
 *                                 AND created_at >= cutoff,
 *                                 bucketed by toDate / toStartOfHour(created_at).
 *   • Tips                     = Σ |ledger.amount| WHERE
 *                                 type='creator_fill_spend_tip', completed.
 *   • Leaderboard prize gross  = Σ |ledger.amount| WHERE
 *                                 type='affiliate_leaderboard_prize', completed.
 *
 * Window: `[since, now)` where `since` is computed from the Hub period chip
 * (matches `hubPeriodToSinceDate` in the PG path so the two windows align
 * exactly). Bucket unit mirrors `hubBucketByHour(period)` (hour for the 24h
 * chip, day otherwise).
 *
 * Scope: NO user scope, mirroring the PG twin exactly (these are
 * creator-fill / deal / leaderboard spend legs paid by the house — the
 * receiving user is whoever the creator paid/sponsored, so the gross is the
 * honest figure).
 *
 * Currently DORMANT — surface key
 * `creator-hub_dashboard_creator_costs_timeseries` is NOT in
 * CUTOVER_DEFAULT_CLICKHOUSE; this twin only runs in comparison mode (drift
 * log) until parity is proven cent/count-exact (TZ=UTC, twice).
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`; money stays Decimal
 * (toString(sum(...)) → toNumber, never Float); `origin` / `type` mirror as
 * Strings (so PG `::text` comparisons map to string equality, and absent
 * enum members simply match zero rows).
 *
 * CQRS BOUNDARY: this module lives under `src/lib/clickhouse/**`, so it
 * imports only ClickHouse + the DashboardPeriod TYPE — no Postgres helpers,
 * no app-side modules. Small helpers (hourly check + since cutoff) are
 * inlined to keep the import graph Postgres-free.
 */

type CreatorCostSeriesCh = {
  granularity: "day" | "hour";
  buckets: { bucketIso: string; costUsd: number }[];
};

/** Mirrors `hubBucketByHour` in `_queries/hub-period-sql.ts`. */
function hourlyForPeriod(period: DashboardPeriod): boolean {
  return period === "24h";
}

/** Mirrors `hubPeriodToSinceDate` in `_queries/hub-period-sql.ts`. */
function periodToSince(period: DashboardPeriod, now: Date): Date {
  const d = new Date(now);
  switch (period) {
    case "1h":
      d.setHours(d.getHours() - 1);
      return d;
    case "3h":
      d.setHours(d.getHours() - 3);
      return d;
    case "6h":
      d.setHours(d.getHours() - 6);
      return d;
    case "12h":
      d.setHours(d.getHours() - 12);
      return d;
    case "24h":
      d.setHours(d.getHours() - 24);
      return d;
    case "48h":
      d.setHours(d.getHours() - 48);
      return d;
    case "3d":
      d.setDate(d.getDate() - 3);
      return d;
    case "7d":
      d.setDate(d.getDate() - 7);
      return d;
    case "30d":
      d.setDate(d.getDate() - 30);
      return d;
    case "all":
      d.setDate(d.getDate() - 365);
      return d;
  }
}

type VoucherRow = { bucket: string; cost: string };
type LedgerRow = { bucket: string; tips: string; lb: string };

export async function getCreatorCostSeriesFromClickHouse(
  period: DashboardPeriod,
  now: Date = new Date(),
): Promise<CreatorCostSeriesCh> {
  const since = periodToSince(period, now);
  const hourly = hourlyForPeriod(period);
  const cutoff = chDateTime(since);
  const params: Record<string, unknown> = { cutoff };

  // Bucket expression — toStartOfHour for the hourly chip, toDate (UTC day)
  // otherwise. Serialized as an ISO string so the TS merge sees the same
  // shape as the PG path's DATE_TRUNC bucket.
  const voucherBucket = hourly
    ? `formatDateTime(toStartOfHour(v.created_at), '%Y-%m-%dT%H:%M:%S.000Z')`
    : `concat(toString(toDate(v.created_at)), 'T00:00:00.000Z')`;
  const ledgerBucket = hourly
    ? `formatDateTime(toStartOfHour(lt.created_at), '%Y-%m-%dT%H:%M:%S.000Z')`
    : `concat(toString(toDate(lt.created_at)), 'T00:00:00.000Z')`;

  const voucherSql = `
    SELECT ${voucherBucket} AS bucket,
           toString(sum(v.value)) AS cost
      FROM ${CH_DB}.public_vouchers AS v FINAL
     WHERE v._peerdb_is_deleted = 0
       AND v.created_at >= {cutoff:DateTime64(6)}
       AND v.origin IN ('creator_fill_conversion','creator_multiplier_payout')
     GROUP BY bucket`;

  const ledgerSql = `
    SELECT ${ledgerBucket} AS bucket,
           toString(sumIf(abs(lt.amount), lt.type = 'creator_fill_spend_tip'))     AS tips,
           toString(sumIf(abs(lt.amount), lt.type = 'affiliate_leaderboard_prize')) AS lb
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
     WHERE lt._peerdb_is_deleted = 0
       AND lt.status = 'completed'
       AND lt.created_at >= {cutoff:DateTime64(6)}
       AND lt.type IN ('creator_fill_spend_tip','affiliate_leaderboard_prize')
     GROUP BY bucket`;

  const [vch, led] = await Promise.all([
    clickhouseRead.query<VoucherRow>({
      queryName: "creatorHub.creatorCostSeries.vouchers",
      sql: voucherSql,
      params,
    }),
    clickhouseRead.query<LedgerRow>({
      queryName: "creatorHub.creatorCostSeries.ledger",
      sql: ledgerSql,
      params,
    }),
  ]);

  const byBucket = new Map<string, number>();
  const add = (bucket: string, amount: number) => {
    if (amount === 0) return;
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + amount);
  };
  for (const r of vch) add(r.bucket, toNumber(r.cost));
  for (const r of led) add(r.bucket, toNumber(r.tips) + toNumber(r.lb));

  const buckets = [...byBucket.entries()]
    .map(([bucketIso, costUsd]) => ({ bucketIso, costUsd }))
    .sort((a, b) => a.bucketIso.localeCompare(b.bucketIso));

  return { granularity: hourly ? "hour" : "day", buckets };
}
