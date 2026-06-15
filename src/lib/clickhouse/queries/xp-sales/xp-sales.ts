import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { XpSalesPeriod } from "@/lib/queries/insights-xp-sales";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";

/**
 * ClickHouse twin of the /xp-sales window aggregate (Phase 2B comparison-mode).
 *
 * PARITY with the canonical Postgres definition (queries/insights-xp-sales.ts
 * `queryXpSales`):
 *   • sale_count = COUNT(*) of ledger_transactions WHERE type='xp_purchase'
 *                  AND created_at >= cutoff, customer-scoped.
 *   • revenue    = SUM(amount) over the same rows (the withdrawable USD balance
 *                  users gave up to buy XP — a house gain).
 *   • buyers     = distinct user_id over the same rows.
 *   • xp_granted = SUM(metadata.xp_awarded) but ONLY when that JSON value is a
 *                  number (mirrors the PG `jsonb_typeof(...) = 'number'` guard);
 *                  a row whose key is absent or non-numeric contributes 0.
 *   • avgPerSale = revenue / sale_count (derived, identical to PG).
 *
 * SCOPE: the PG twin uses `getMetricsScope()`, whose customer population is the
 * wholesale `role NOT IN ('admin','support','creator')` drop + the
 * excluded-users blacklist (its creator-on-session NOT EXISTS predicate is a
 * documented no-op once creators are dropped wholesale). `customerScopeCte`
 * reproduces that population exactly, so a comparison drift signals a real bug.
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL; drop soft-deleted rows via
 *     `_peerdb_is_deleted = 0`.
 *   • Money stays Decimal end-to-end (`toString(sum(...))` in SQL → `toNumber()`
 *     in TS) — never Float — so revenue is exact to the cent.
 *   • `metadata` is a Nullable(String) JSON blob on the mirror; `ifNull(..,'')`
 *     keeps the JSON helpers total, and the `JSONType ∈ numeric` guard matches
 *     the PG `jsonb_typeof = 'number'` semantics.
 *
 * The blacklist is passed IN by the caller (fetched from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres/Prisma client — it
 * is a pure ClickHouse read.
 */

export type XpSalesAggregatesCh = {
  saleCount: number;
  revenue: number;
  buyers: number;
  avgPerSale: number;
  xpGranted: number;
};

/**
 * Window lookback (days) per period — mirrors `daysForPeriod` /
 * `LIFETIME_LOOKBACK_DAYS` in queries/insights-xp-sales.ts. Kept inline here
 * (rather than imported) because the PG helper lives in a Prisma-coupled module
 * the CH read graph must never reach; the parity script proves the two stay in
 * lock-step.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(period: XpSalesPeriod): number {
  switch (period) {
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

type RawAggRow = {
  sale_count: string;
  revenue: string;
  buyers: string;
  xp_granted: string;
};

export async function getXpSalesFromClickHouse(
  period: XpSalesPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<XpSalesAggregatesCh> {
  const days = daysForPeriod(period);
  const cutoff = chDateTime(new Date(now.getTime() - days * 86_400_000));
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };

  const sql = `
    WITH ${customerScopeCte({ hasBlacklist })}
    SELECT
      toString(count())                  AS sale_count,
      toString(sum(lt.amount))           AS revenue,
      toString(uniqExact(lt.user_id))    AS buyers,
      toString(sum(
        if(
          JSONType(ifNull(lt.metadata, ''), 'xp_awarded') IN ('Int64', 'UInt64', 'Double'),
          JSONExtractFloat(ifNull(lt.metadata, ''), 'xp_awarded'),
          0
        )
      ))                                 AS xp_granted
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.type = 'xp_purchase'
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  const rows = await clickhouseRead.query<RawAggRow>({
    queryName: "xp_sales.window_aggregate",
    sql,
    params,
  });

  const r = rows[0] ?? {
    sale_count: "0",
    revenue: "0",
    buyers: "0",
    xp_granted: "0",
  };
  const saleCount = Number(r.sale_count);
  const revenue = toNumber(r.revenue);
  return {
    saleCount,
    revenue,
    buyers: Number(r.buyers),
    avgPerSale: saleCount > 0 ? revenue / saleCount : 0,
    xpGranted: Number(r.xp_granted),
  };
}
