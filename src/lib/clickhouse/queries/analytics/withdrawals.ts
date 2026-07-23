import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type {
  WithdrawalsPeriod,
  WithdrawnCoinsData,
  WithdrawnAsset,
} from "@/lib/queries/analytics-withdrawals";

import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of `getWithdrawnCoinsBreakdown`
 * (`src/lib/queries/analytics-withdrawals.ts`) — the /analytics → Overview tab
 * "Cash out, by rail" card.
 *
 * PARITY: `card_withdrawal_requests` filtered to status IN ('completed',
 * 'shipped'), bucketed crypto vs physical (`method = 'crypto'` → crypto, else
 * physical), per-asset crypto totals (count + Σ total_value_usd + Σ
 * crypto_amount), and a single physical bucket. Time scope is COALESCE(
 * shipped_at, completed_at) — the moment value left the books.
 *
 * SCOPE (mirrors the PG twin EXACTLY): `role NOT IN ('admin','support')` —
 * creators are KEPT (2-role) — plus the excluded-users blacklist. This is NOT
 * the wholesale `customerScopeCte` 3-role scope, so it is written inline.
 *
 * Periods: today (24h) / 7d / 30d / 90d / all (lifetime, capped at 365d).
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`; money/quantity stays Decimal
 * (`toString(sum(...))` → `toNumber`), never Float. The blacklist is passed in
 * by the caller (no Postgres client imported here).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Lifetime (`all`) capped at 365d to match the PG twin (analytics-withdrawals.ts
// LIFETIME_LOOKBACK_DAYS) and the house INSIGHTS_LIFETIME_LOOKBACK_DAYS
// convention, so cutover/comparison stays bounded and consistent.
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(period: WithdrawalsPeriod): number | null {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

function scopeCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

export async function getWithdrawnCoinsBreakdownFromClickHouse(
  period: WithdrawalsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<WithdrawnCoinsData> {
  const hasBlacklist = blacklist.length > 0;
  const days = daysForPeriod(period);
  const params: Record<string, unknown> = { blacklist };
  let dateFilter = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateFilter =
      "AND coalesce(cwr.shipped_at, cwr.completed_at) >= {cutoff:DateTime64(6)}";
  }

  type Row = {
    bucket: string;
    asset: string | null;
    n: string;
    total_usd: string;
    total_crypto: string;
  };

  const rows = await clickhouseRead.query<Row>({
    queryName: "analytics.revenue.withdrawnCoins",
    sql: `
      WITH ${scopeCte(hasBlacklist)}
      SELECT
        if(cwr.method = 'crypto', 'crypto', 'physical') AS bucket,
        cwr.crypto_asset                                AS asset,
        toString(count())                               AS n,
        toString(sum(cwr.total_value_usd))              AS total_usd,
        toString(sum(cwr.crypto_amount))                AS total_crypto
      FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
      WHERE cwr._peerdb_is_deleted = 0
        AND cwr.status IN ('completed', 'shipped')
        AND cwr.user_id IN (SELECT id FROM real_users)
        ${dateFilter}
      GROUP BY bucket, cwr.crypto_asset
      ORDER BY sum(cwr.total_value_usd) DESC`,
    params,
  });

  const assets: WithdrawnAsset[] = [];
  let totalCryptoUsd = 0;
  let physicalUsd = 0;
  let physicalCount = 0;

  for (const r of rows) {
    const usd = toNumber(r.total_usd);
    const count = Number(r.n ?? 0);
    if (r.bucket === "crypto" && r.asset) {
      assets.push({
        asset: r.asset,
        count,
        totalUsd: usd,
        totalCryptoAmount: toNumber(r.total_crypto),
      });
      totalCryptoUsd += usd;
    } else {
      physicalUsd += usd;
      physicalCount += count;
    }
  }

  assets.sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    period,
    assets,
    totalCryptoUsd,
    physicalUsd,
    physicalCount,
  };
}
