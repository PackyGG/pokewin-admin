import "server-only";

import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

/** Hub "all" chip — bounded lookback (matches dashboard GGR cap). */
export const HUB_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Postgres `INTERVAL` literal for the Hub period chips. The "all" chip maps
 * to a 365-day trailing window (never unbounded).
 */
export function hubPeriodToInterval(period: DashboardPeriod): string {
  switch (period) {
    case "1h":
      return "1 hour";
    case "3h":
      return "3 hours";
    case "6h":
      return "6 hours";
    case "12h":
      return "12 hours";
    case "24h":
      return "24 hours";
    case "48h":
      return "48 hours";
    case "3d":
      return "3 days";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "all":
      return `${HUB_LIFETIME_LOOKBACK_DAYS} days`;
  }
}

/** `AND col >= NOW() - INTERVAL '…'` for the active Hub window. */
export function hubSinceClause(col: string, period: DashboardPeriod): string {
  return `AND ${col} >= NOW() - INTERVAL '${hubPeriodToInterval(period)}'`;
}

/** Hour buckets for 24h; day buckets for every other Hub chip. */
export function hubBucketByHour(period: DashboardPeriod): boolean {
  return period === "24h";
}

/** `DATE_TRUNC` expression for chart series bucketing. */
export function hubBucketTrunc(col: string, period: DashboardPeriod): string {
  const unit = hubBucketByHour(period) ? "hour" : "day";
  return `DATE_TRUNC('${unit}', ${col})`;
}

/**
 * Covering-creator lateral — same semantics as `all-creators-net-pnl.ts`
 * (most-recent acu in the 7-day pre-event window wins; creator self-play
 * dropped). `userCol` / `tsCol` are bare unaliased outer columns.
 */
export function hubCoveringLateral(userCol: string, tsCol: string): string {
  return `LEFT JOIN LATERAL (
           SELECT acu.affiliate_user_id AS creator_id
             FROM affiliate_code_usages acu
            WHERE acu.referred_user_id = ${userCol}
              AND acu.referred_user_id <> acu.affiliate_user_id
              AND acu.created_at <= ${tsCol}
              AND acu.created_at >= ${tsCol} - INTERVAL '7 days'
            ORDER BY acu.created_at DESC
            LIMIT 1
         ) cov ON TRUE`;
}
