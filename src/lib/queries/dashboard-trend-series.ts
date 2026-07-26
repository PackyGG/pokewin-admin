import "server-only";

import { unstable_cache } from "next/cache";
import { drizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { type DbEnv } from "@/lib/db-env";
import { type DashboardPeriod } from "./dashboard-period";
import {
  dashboardChartBucketExpr,
  dashboardChartCutoff,
  dashboardChartDateLabel,
  dashboardChartHourlyBuckets,
  padDashboardAttributionSeries,
  padDashboardCountSeries,
  padDashboardDepositSeries,
  padDashboardFtdSeries,
  padDashboardWagerSeries,
} from "./dashboard-chart-series";

const LIFETIME_LOOKBACK_DAYS = 365;

export type DashboardTrendSeries = {
  dailyWagers: { date: string; packs: number; battles: number; upgrader: number }[];
  dailyDeposits: { date: string; amount: number }[];
  dailySignups: { date: string; count: number }[];
  dailyFtds: { date: string; count: number; total: number; avg: number }[];
  dailyActiveDepositors: { date: string; count: number }[];
  dailyWagerAttribution: { date: string; organic: number; creatorCoded: number }[];
  chartHourlyBuckets: boolean;
};

type LedgerBucketRow = {
  bucket: Date | string;
  packs: string;
  battles: string;
  deposits: string;
  active_depositors: string;
};

type CountBucketRow = { bucket: Date | string; value: string };
type UpgraderBucketRow = { bucket: Date | string; upgrader: string };
type AttributionBucketRow = {
  bucket: Date | string;
  organic: string;
  creator_attributed: string;
};
type FtdBucketRow = { bucket: Date | string; count: string; total: string };

function bucketKey(d: Date | string, period: DashboardPeriod): string {
  return dashboardChartDateLabel(new Date(d), period);
}

function mergeLedgerRows(
  rows: LedgerBucketRow[],
  upgraderRows: UpgraderBucketRow[],
  period: DashboardPeriod,
): Pick<
  DashboardTrendSeries,
  "dailyWagers" | "dailyDeposits" | "dailyActiveDepositors"
> {
  const upgraderByBucket = new Map(
    upgraderRows.map((r) => [bucketKey(r.bucket, period), Number(r.upgrader)]),
  );

  const wagerRows = rows.map((d) => {
    const date = bucketKey(d.bucket, period);
    return {
      date,
      packs: Number(d.packs),
      battles: Number(d.battles),
      upgrader: upgraderByBucket.get(date) ?? 0,
    };
  });

  return {
    dailyWagers: padDashboardWagerSeries(wagerRows, period),
    dailyDeposits: padDashboardDepositSeries(
      rows.map((d) => ({
        date: bucketKey(d.bucket, period),
        amount: Math.abs(Number(d.deposits)),
      })),
      period,
    ),
    dailyActiveDepositors: padDashboardCountSeries(
      rows.map((d) => ({
        date: bucketKey(d.bucket, period),
        count: Number(d.active_depositors),
      })),
      period,
    ),
  };
}

async function fetchTrendSeriesPg(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
): Promise<DashboardTrendSeries> {
  const db = drizzleForEnv(env);
  const now = new Date();
  const cutoff = dashboardChartCutoff(period, now, LIFETIME_LOOKBACK_DAYS);
  const bucketLedger = dashboardChartBucketExpr("created_at", period);
  const bucketUpg = dashboardChartBucketExpr("upgrader_games.created_at", period);
  const bucketUser = dashboardChartBucketExpr("created_at", period);
  const bucketFtd = dashboardChartBucketExpr("fd.created_at", period);

  const upgProbe = await queryRows<{ exists: string | null }[]>(
    db,
    `SELECT to_regclass('public.upgrader_games')::text AS exists`,
  );
  const hasUpgrader = upgProbe[0]?.exists != null;

  const [
    ledgerRows,
    upgraderRows,
    signupRows,
    attributionRows,
    ftdRows,
  ] = await Promise.all([
    queryRows<LedgerBucketRow[]>(db, `
      SELECT ${bucketLedger} AS bucket,
             COALESCE(SUM(CASE WHEN type::text = 'pack_opening'
                               THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS packs,
             COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship')
                               THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battles,
             COALESCE(SUM(CASE WHEN type::text = 'deposit'
                               THEN amount::numeric ELSE 0 END), 0)::text AS deposits,
             COUNT(DISTINCT CASE WHEN type::text = 'deposit' THEN user_id END)::text AS active_depositors
        FROM ledger_transactions
       WHERE type::text IN ('pack_opening','battle_bet','battle_sponsorship','deposit')
         AND status = 'completed'
         AND created_at >= $1
         AND user_id IN (
           SELECT id FROM "user"
           WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
         )
       GROUP BY 1
       ORDER BY 1`, cutoff),

    hasUpgrader
      ? queryRows<UpgraderBucketRow[]>(db, `
          SELECT ${bucketUpg} AS bucket,
                 COALESCE(SUM(bet_amount::numeric), 0)::text AS upgrader
            FROM upgrader_games
           WHERE created_at >= $1
             AND user_id IN (
               SELECT id FROM "user"
               WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
             )
           GROUP BY 1
           ORDER BY 1`, cutoff)
      : Promise.resolve([] as UpgraderBucketRow[]),

    // Bot-prevention drop (`is_locked = true` with `locked_reason = 'bot prevention'`):
    // the signup pipeline locks automated registrations server-side. Jun 11 had
    // 4,141 of 4,205 same-day signups locked as bots — without this filter the
    // chart shows the raw spike instead of the ~75/day real-customer baseline.
    queryRows<CountBucketRow[]>(db, `
      SELECT ${bucketUser} AS bucket, COUNT(*)::text AS value
        FROM "user"
       WHERE created_at >= $1
         AND role NOT IN ('admin', 'support') ${blacklistIdNotIn}
         AND is_locked = false
       GROUP BY 1
       ORDER BY 1`, cutoff),

    queryRows<AttributionBucketRow[]>(db, `
      WITH customers AS (
        SELECT u.id,
               EXISTS (
                 SELECT 1 FROM "user" ref
                 WHERE ref.id = u.referred_by AND ref.role = 'creator'
               ) AS under_creator
          FROM "user" u
         WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
      )
      SELECT ${dashboardChartBucketExpr("lt.created_at", period)} AS bucket,
             COALESCE(SUM(CASE WHEN NOT c.under_creator THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS organic,
             COALESCE(SUM(CASE WHEN c.under_creator THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS creator_attributed
        FROM ledger_transactions lt
        JOIN customers c ON c.id = lt.user_id
       WHERE lt.status = 'completed'
         AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
         AND lt.created_at >= $1
       GROUP BY 1
       ORDER BY 1`, cutoff),

    queryRows<FtdBucketRow[]>(db, `
      WITH first_deposits AS (
        SELECT DISTINCT ON (user_id)
               user_id, amount::numeric AS amount, created_at
          FROM ledger_transactions
         WHERE type::text = 'deposit' AND status = 'completed'
           AND user_id IN (
             SELECT id FROM "user"
             WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
           )
         ORDER BY user_id, created_at ASC
      )
      SELECT ${bucketFtd} AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
        FROM first_deposits fd
       WHERE fd.created_at >= $1
       GROUP BY 1
       ORDER BY 1`, cutoff),
  ]);

  const ledgerMerged = mergeLedgerRows(ledgerRows, upgraderRows, period);

  const dailySignups = padDashboardCountSeries(
    signupRows.map((r) => ({
      date: bucketKey(r.bucket, period),
      count: Number(r.value),
    })),
    period,
  );

  const dailyWagerAttribution = padDashboardAttributionSeries(
    attributionRows.map((r) => ({
      date: bucketKey(r.bucket, period),
      organic: Number(r.organic),
      creatorCoded: Number(r.creator_attributed),
    })),
    period,
  );

  const dailyFtds = padDashboardFtdSeries(
    ftdRows.map((r) => {
      const count = Number(r.count);
      const total = Number(r.total);
      return {
        date: bucketKey(r.bucket, period),
        count,
        total,
        avg: count > 0 ? total / count : 0,
      };
    }),
    period,
  );

  return {
    ...ledgerMerged,
    dailySignups,
    dailyFtds,
    dailyWagerAttribution,
    chartHourlyBuckets: dashboardChartHourlyBuckets(period),
  };
}

/** Uncached PostgreSQL computation wrapped by cachedDashboardTrendSeries. */
async function fetchDashboardTrendSeriesInner(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
): Promise<DashboardTrendSeries> {
  return fetchTrendSeriesPg(period, blacklistIdNotIn, env);
}

const cachedDashboardTrendSeries = unstable_cache(
  fetchDashboardTrendSeriesInner,
  ["dashboard-trend-series-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

export function getDashboardTrendSeries(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
): Promise<DashboardTrendSeries> {
  // The env-scoped Drizzle client bypasses cross-request cache on dev so charts
  // match the toggled DB (same pattern as cachedWindowMetricsForPeriod).
  if (env !== "prod") {
    return fetchDashboardTrendSeriesInner(period, blacklistIdNotIn, env);
  }
  return cachedDashboardTrendSeries(period, blacklistIdNotIn, env);
}
