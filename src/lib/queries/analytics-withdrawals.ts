import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

/**
 * Crypto-asset withdrawal breakdown — answers "which coins get withdrawn
 * the most" on the Analytics → Overview tab (moved there when the Revenue
 * tab was deleted, owner 2026-07-23: everything else on it restated the
 * Cost Breakdown waterfall, this card was the one thing it alone owned).
 *
 * Source: `card_withdrawal_requests` filtered to status IN
 * (completed, shipped) — i.e. value that actually left the house. Each
 * row is grouped by `crypto_asset` for `method = 'crypto'` rows;
 * physical card shipments are summed into a single "physical" total
 * shown alongside (since they're real outflows too, just not crypto).
 *
 * Time scope: bucketed by COALESCE(shipped_at, completed_at) — the
 * moment value left the books. Same convention used by
 * creators-pnl.ts so withdrawal totals can be reconciled against the
 * per-creator P&L surface.
 *
 * Staff exclusion: same convention as the rest of analytics —
 * admin/support roles excluded so internal accounts don't skew the
 * numbers.
 */
export type WithdrawalsPeriod = "today" | "7d" | "30d" | "90d" | "all";

export type WithdrawnAsset = {
  /** Asset symbol from the schema, e.g. "SOL", "ETH", "USDT_ERC20". */
  asset: string;
  /** Number of completed/shipped withdrawals of this asset. */
  count: number;
  /** Total USD value paid out in this asset. */
  totalUsd: number;
  /** Total native crypto amount sent (sum of crypto_amount). */
  totalCryptoAmount: number;
};

export type WithdrawnCoinsData = {
  period: WithdrawalsPeriod;
  /** Per-asset breakdown, sorted by USD value descending. */
  assets: WithdrawnAsset[];
  /** Total USD of crypto withdrawals (sum of all assets). */
  totalCryptoUsd: number;
  /** USD of physical card shipments in the same window. */
  physicalUsd: number;
  /** Count of physical card shipments in the same window. */
  physicalCount: number;
};

// Lifetime (`all`) is capped at this lookback rather than an unbounded
// full-history scan — the unbounded-lifetime pattern CLAUDE.md
// ("Performance & Daten-Laden") forbids. Mirrors the reward-side
// `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (365d); covers all currently-relevant
// withdrawal activity.
const LIFETIME_LOOKBACK_DAYS = 365;

function intervalSqlForPeriod(period: WithdrawalsPeriod): string | null {
  switch (period) {
    case "today":
      return "INTERVAL '1 day'";
    case "7d":
      return "INTERVAL '7 days'";
    case "30d":
      return "INTERVAL '30 days'";
    case "90d":
      return "INTERVAL '90 days'";
    case "all":
      return `INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'`;
  }
}

async function computeWithdrawnCoinsBreakdown(
  period: WithdrawalsPeriod,
  excluded: string[],
): Promise<WithdrawnCoinsData> {
  const db = await getDb();
  const interval = intervalSqlForPeriod(period);
  const dateFilter = interval
    ? `AND COALESCE(cwr.shipped_at, cwr.completed_at) >= NOW() - ${interval}`
    : "";
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Single round-trip: per-asset crypto totals + a single physical
  // bucket. Results merged in JS into the WithdrawnCoinsData shape so
  // the UI can render the crypto breakdown table + a physical-cards
  // tile alongside without a second query.
  const rows = await db.$queryRawUnsafe<
    {
      bucket: string;
      asset: string | null;
      n: string;
      total_usd: string;
      total_crypto: string;
    }[]
  >(`
    SELECT
      CASE WHEN cwr.method = 'crypto' THEN 'crypto' ELSE 'physical' END AS bucket,
      cwr.crypto_asset                                                  AS asset,
      COUNT(*)::text                                                    AS n,
      COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text              AS total_usd,
      COALESCE(SUM(cwr.crypto_amount::numeric), 0)::text                AS total_crypto
    FROM card_withdrawal_requests cwr
    JOIN "user" u ON u.id = cwr.user_id
    WHERE cwr.status IN ('completed', 'shipped')
      AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
      ${dateFilter}
    GROUP BY bucket, cwr.crypto_asset
    ORDER BY total_usd DESC
  `);

  const assets: WithdrawnAsset[] = [];
  let totalCryptoUsd = 0;
  let physicalUsd = 0;
  let physicalCount = 0;

  for (const r of rows) {
    const usd = Number(r.total_usd ?? 0);
    const count = Number(r.n ?? 0);
    if (r.bucket === "crypto" && r.asset) {
      assets.push({
        asset: r.asset,
        count,
        totalUsd: usd,
        totalCryptoAmount: Number(r.total_crypto ?? 0),
      });
      totalCryptoUsd += usd;
    } else {
      // method='physical' (or method='crypto' without an asset, which
      // shouldn't happen in practice but we fold defensively into the
      // physical bucket so no row is silently dropped).
      physicalUsd += usd;
      physicalCount += count;
    }
  }

  // Already ordered by total_usd DESC at the SQL layer, but the JS
  // partition above doesn't guarantee that for the assets array
  // alone — re-sort to be safe.
  assets.sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    period,
    assets,
    totalCryptoUsd,
    physicalUsd,
    physicalCount,
  };
}

/**
 * Cross-request cache for the withdrawn-coins breakdown. `/analytics` →
 * Revenue tab re-runs on every 5-minute `AutoRefresh` tick for every
 * viewer; without a shared cache the per-asset `card_withdrawal_requests`
 * scan re-ran per tick per viewer. Two `unstable_cache` layers — 60s for
 * the finite windows, 300s for the unbounded "all" view — both keyed on
 * `(period, sortedBlacklist)`. Logic identical to
 * `computeWithdrawnCoinsBreakdown`; mirrors the `getAnalyticsData` cache
 * idiom in `analytics.ts`.
 *
 * NOTE: the `all` window is still an UNBOUNDED lifetime scan (money-exact
 * "total withdrawn" — capping it would change a displayed number, so it is
 * left for owner sign-off). The cache + the caller's `safeQuery` timeout
 * keep a cold lifetime fill from hanging the segment.
 */
const cachedWithdrawnCoinsBreakdown = unstable_cache(
  computeWithdrawnCoinsBreakdown,
  ["analytics-withdrawals-v1"],
  { revalidate: 60, tags: ["analytics"] },
);

const cachedWithdrawnCoinsBreakdownLifetime = unstable_cache(
  computeWithdrawnCoinsBreakdown,
  ["analytics-withdrawals-lifetime-v1"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getWithdrawnCoinsBreakdown(
  period: WithdrawalsPeriod,
): Promise<WithdrawnCoinsData> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return period === "all"
    ? cachedWithdrawnCoinsBreakdownLifetime(period, sorted)
    : cachedWithdrawnCoinsBreakdown(period, sorted);
}
