import "server-only";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  buildCacheKey,
  cacheGetOrSetStale,
  hashString,
} from "@/lib/cache/redis";
import {
  REWARD_QUERY_TIMEOUT_MS,
  safeQuery,
  withTimeout,
} from "@/lib/errors/safe-query";
import { runWithConcurrency } from "@/lib/promise-pool";
import { blacklistNotInClause } from "./_blacklist";
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
import {
  fiatRefundAttributionTimestampSql,
  fiatRefundCreditUsdSql,
} from "./fiat-refund-credits";
import { WAGER_LEG_FILTER } from "@/lib/metrics/gaming-sql";

const LIFETIME_LOOKBACK_DAYS = 365;

export type DashboardTrendSeries = {
  dailyWagers: {
    date: string;
    packs: number;
    battles: number;
    keno: number;
    upgrader: number;
    doubleDown: number;
  }[];
  dailyDeposits: { date: string; amount: number }[];
  dailySignups: { date: string; count: number }[];
  dailyFtds: { date: string; count: number; total: number; avg: number }[];
  dailyActiveDepositors: { date: string; count: number }[];
  dailyWagerAttribution: { date: string; organic: number; creatorCoded: number }[];
  chartHourlyBuckets: boolean;
  capturedAtIso: string;
  servedAtIso: string;
  availability: {
    wagers: boolean;
    deposits: boolean;
    signups: boolean;
    ftds: boolean;
    activeDepositors: boolean;
    wagerAttribution: boolean;
  };
};

type LedgerBucketRow = {
  bucket: Date | string;
  packs: string;
  battles: string;
  keno: string;
  deposits: string;
  active_depositors: string;
};

type CountBucketRow = { bucket: Date | string; value: string };
type UpgraderBucketRow = { bucket: Date | string; upgrader: string };
type DoubleDownBucketRow = { bucket: Date | string; double_down: string };
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
  doubleDownRows: DoubleDownBucketRow[],
  period: DashboardPeriod,
): Pick<
  DashboardTrendSeries,
  "dailyWagers" | "dailyDeposits" | "dailyActiveDepositors"
> {
  const upgraderByBucket = new Map(
    upgraderRows.map((r) => [bucketKey(r.bucket, period), Number(r.upgrader)]),
  );
  const doubleDownByBucket = new Map(
    doubleDownRows.map((r) => [
      bucketKey(r.bucket, period),
      Number(r.double_down),
    ]),
  );

  const wagerRows = rows.map((d) => {
    const date = bucketKey(d.bucket, period);
    return {
      date,
      packs: Number(d.packs),
      battles: Number(d.battles),
      keno: Number(d.keno),
      upgrader: upgraderByBucket.get(date) ?? 0,
      doubleDown: doubleDownByBucket.get(date) ?? 0,
    };
  });

  return {
    dailyWagers: padDashboardWagerSeries(wagerRows, period),
    dailyDeposits: padDashboardDepositSeries(
      rows.map((d) => ({
        date: bucketKey(d.bucket, period),
        amount: Number(d.deposits),
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
  const db = readDrizzleForEnv(env);
  const now = new Date();
  const cutoff = dashboardChartCutoff(period, now, LIFETIME_LOOKBACK_DAYS);
  const cutoffBind = cutoff.toISOString();
  const bucketLedger = dashboardChartBucketExpr("created_at", period);
  const bucketUpg = dashboardChartBucketExpr("upgrader_games.created_at", period);
  const bucketDd = dashboardChartBucketExpr("o.resolved_at", period);
  const bucketUser = dashboardChartBucketExpr("created_at", period);
  const bucketFtd = dashboardChartBucketExpr("fd.created_at", period);

  const [upgProbe, ddProbe] = await Promise.all([
    safeQuery(
      () =>
        queryRows<{ exists: string | null }[]>(
          db,
          `SELECT to_regclass('public.upgrader_games')::text AS exists`,
        ),
      [],
      "dashboard.trends.upgraderProbe",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        queryRows<{ exists: string | null }[]>(
          db,
          `SELECT to_regclass('public.battle_double_down_offers')::text AS exists`,
        ),
      [],
      "dashboard.trends.doubleDownProbe",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  const hasUpgrader = upgProbe.data[0]?.exists != null;
  const hasDoubleDown = ddProbe.data[0]?.exists != null;
  const attributionUpgraderUnion = hasUpgrader
    ? `UNION ALL
       SELECT ug.user_id, ug.bet_amount::numeric AS amount, ug.created_at
       FROM upgrader_games ug
       WHERE ug.created_at >= $1`
    : "";
  const attributionDoubleDownUnion = hasDoubleDown
    ? `UNION ALL
       SELECT o.user_id, o.won_amount_usd::numeric AS amount,
              o.resolved_at AS created_at
       FROM battle_double_down_offers o
       WHERE o.result IS NOT NULL AND o.resolved_at >= $1`
    : "";

  const [
    ledgerResult,
    upgraderResult,
    doubleDownResult,
    signupResult,
    attributionResult,
    ftdResult,
  ] = await runWithConcurrency([
    // CUSTOMER scope on BOTH legs = `CUSTOMER_EXCLUDED_ROLES`
    // (`src/lib/metrics/scope.ts`): admin + support + creator, plus the
    // blacklist. This leg used to stop at ('admin','support') while the
    // attribution leg below already dropped creators, so on /dashboard
    // `organic + creatorCoded` did NOT add up to `packs + battles` and
    // neither reconciled with the Total Wager KPI. Creators are dropped
    // WHOLESALE from customer analytics (house-funded "for content" play is
    // not customer revenue), so the wager/deposit legs must match.
    () => safeQuery(
      () => queryRows<LedgerBucketRow[]>(db, `
      WITH events AS (
        SELECT user_id, type::text AS type, amount::numeric AS amount, created_at
        FROM ledger_transactions
        WHERE type::text IN ('pack_opening','battle_bet','battle_sponsorship','keno_bet','deposit')
          AND status = 'completed'
          AND created_at >= $1
          AND ${WAGER_LEG_FILTER}
          AND user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
          )
        UNION ALL
        SELECT i.user_id, 'deposit_refund'::text AS type,
               -${fiatRefundCreditUsdSql("i")} AS amount,
               ${fiatRefundAttributionTimestampSql("i")} AS created_at
        FROM fiat_deposit_intents i
        WHERE i.status IN ('partially_refunded', 'refunded')
          AND ${fiatRefundAttributionTimestampSql("i")} >= $1
          AND i.user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
          )
      )
      SELECT ${bucketLedger} AS bucket,
             COALESCE(SUM(CASE WHEN type::text = 'pack_opening'
                               THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS packs,
             COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship')
                               THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battles,
             COALESCE(SUM(CASE WHEN type::text = 'keno_bet'
                               THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS keno,
             COALESCE(SUM(CASE WHEN type::text IN ('deposit','deposit_refund')
                               THEN amount::numeric ELSE 0 END), 0)::text AS deposits,
             COUNT(DISTINCT CASE WHEN type::text = 'deposit' THEN user_id END)::text AS active_depositors
        FROM events
       GROUP BY 1
       ORDER BY 1`, cutoffBind),
      [],
      "dashboard.trends.ledger",
      REWARD_QUERY_TIMEOUT_MS,
    ),

    () => safeQuery(
      () => hasUpgrader
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
           ORDER BY 1`, cutoffBind)
        : Promise.resolve([] as UpgraderBucketRow[]),
      [],
      "dashboard.trends.upgrader",
      REWARD_QUERY_TIMEOUT_MS,
    ),

    () => safeQuery(
      () => hasDoubleDown
        ? queryRows<DoubleDownBucketRow[]>(db, `
          SELECT ${bucketDd} AS bucket,
                 COALESCE(SUM(o.won_amount_usd::numeric), 0)::text AS double_down
            FROM battle_double_down_offers o
           WHERE o.result IS NOT NULL
             AND o.resolved_at >= $1
             AND o.user_id IN (
               SELECT id FROM "user"
               WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
             )
           GROUP BY 1
           ORDER BY 1`, cutoffBind)
        : Promise.resolve([] as DoubleDownBucketRow[]),
      [],
      "dashboard.trends.doubleDown",
      REWARD_QUERY_TIMEOUT_MS,
    ),

    // Bot-prevention drop (`is_locked = true` with `locked_reason = 'bot prevention'`):
    // the signup pipeline locks automated registrations server-side. Jun 11 had
    // 4,141 of 4,205 same-day signups locked as bots — without this filter the
    // chart shows the raw spike instead of the ~75/day real-customer baseline.
    () => safeQuery(
      () => queryRows<CountBucketRow[]>(db, `
      SELECT ${bucketUser} AS bucket, COUNT(*)::text AS value
        FROM "user"
       WHERE created_at >= $1
         AND role NOT IN ('admin', 'support') ${blacklistIdNotIn}
         AND is_locked = false
       GROUP BY 1
       ORDER BY 1`, cutoffBind),
      [],
      "dashboard.trends.signups",
      REWARD_QUERY_TIMEOUT_MS,
    ),

    () => safeQuery(
      () => queryRows<AttributionBucketRow[]>(db, `
      WITH customers AS (
        SELECT u.id,
               EXISTS (
                 SELECT 1 FROM "user" ref
                 WHERE ref.id = u.referred_by AND ref.role = 'creator'
               ) AS under_creator
          FROM "user" u
         WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
      ), wager_events AS (
        SELECT lt.user_id, ABS(lt.amount::numeric) AS amount, lt.created_at
          FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship','keno_bet')
           AND lt.created_at >= $1
           AND ${WAGER_LEG_FILTER}
        ${attributionUpgraderUnion}
        ${attributionDoubleDownUnion}
      )
      SELECT ${dashboardChartBucketExpr("e.created_at", period)} AS bucket,
             COALESCE(SUM(CASE WHEN NOT c.under_creator THEN e.amount ELSE 0 END), 0)::text AS organic,
             COALESCE(SUM(CASE WHEN c.under_creator THEN e.amount ELSE 0 END), 0)::text AS creator_attributed
        FROM wager_events e
        JOIN customers c ON c.id = e.user_id
       GROUP BY 1
       ORDER BY 1`, cutoffBind),
      [],
      "dashboard.trends.attribution",
      REWARD_QUERY_TIMEOUT_MS,
    ),

    () => safeQuery(
      () => queryRows<FtdBucketRow[]>(db, `
      WITH first_deposits AS (
        SELECT DISTINCT ON (lt.user_id)
               lt.user_id,
               (lt.amount::numeric - COALESCE(${fiatRefundCreditUsdSql("i")}, 0)) AS amount,
               lt.created_at
          FROM ledger_transactions lt
          LEFT JOIN fiat_deposit_intents i
            ON i.completed_ledger_id = lt.id
           AND i.status IN ('partially_refunded', 'refunded')
         WHERE lt.type::text = 'deposit' AND lt.status = 'completed'
           AND lt.user_id IN (
             SELECT id FROM "user"
             WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
           )
         ORDER BY lt.user_id, lt.created_at ASC
      )
      SELECT ${bucketFtd} AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
        FROM first_deposits fd
       WHERE fd.created_at >= $1
       GROUP BY 1
       ORDER BY 1`, cutoffBind),
      [],
      "dashboard.trends.ftds",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ] as const, 2);

  const ledgerRows = ledgerResult.data;
  const upgraderRows = upgraderResult.data;
  const doubleDownRows = doubleDownResult.data;
  const signupRows = signupResult.data;
  const attributionRows = attributionResult.data;
  const ftdRows = ftdResult.data;

  const ledgerMerged = mergeLedgerRows(
    ledgerRows,
    upgraderRows,
    doubleDownRows,
    period,
  );

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
    capturedAtIso: new Date().toISOString(),
    servedAtIso: new Date().toISOString(),
    availability: {
      wagers:
        ledgerResult.error === null &&
        upgProbe.error === null &&
        upgraderResult.error === null &&
        ddProbe.error === null &&
        doubleDownResult.error === null,
      deposits: ledgerResult.error === null,
      signups: signupResult.error === null,
      ftds: ftdResult.error === null,
      activeDepositors: ledgerResult.error === null,
      wagerAttribution: attributionResult.error === null,
    },
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

export function emptyDashboardTrendSeries(
  period: DashboardPeriod,
): DashboardTrendSeries {
  const nowIso = new Date().toISOString();
  return {
    dailyWagers: padDashboardWagerSeries([], period),
    dailyDeposits: padDashboardDepositSeries([], period),
    dailySignups: padDashboardCountSeries([], period),
    dailyFtds: padDashboardFtdSeries([], period),
    dailyActiveDepositors: padDashboardCountSeries([], period),
    dailyWagerAttribution: padDashboardAttributionSeries([], period),
    chartHourlyBuckets: dashboardChartHourlyBuckets(period),
    capturedAtIso: nowIso,
    servedAtIso: nowIso,
    availability: {
      wagers: false,
      deposits: false,
      signups: false,
      ftds: false,
      activeDepositors: false,
      wagerAttribution: false,
    },
  };
}

export async function getDashboardTrendSeries(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
): Promise<DashboardTrendSeries> {
  if (env !== "prod") {
    return fetchDashboardTrendSeriesInner(period, blacklistIdNotIn, env);
  }

  let partial: DashboardTrendSeries | null = null;
  try {
    const key = buildCacheKey("dashboard-trends-v5-all-games-attribution", [
      env,
      period,
      hashString(blacklistIdNotIn),
    ]);
    const snapshot = await cacheGetOrSetStale(
      key,
      60,
      24 * 60 * 60,
      async () => {
        partial = await withTimeout(
          () =>
            fetchDashboardTrendSeriesInner(
              period,
              blacklistIdNotIn,
              env,
            ),
          10_000,
        );
        if (Object.values(partial.availability).some((available) => !available)) {
          throw new Error("dashboard trend snapshot was incomplete");
        }
        return partial;
      },
    );
    return { ...snapshot, servedAtIso: new Date().toISOString() };
  } catch {
    return partial ?? emptyDashboardTrendSeries(period);
  }
}

export async function getScopedDashboardTrendSeries(
  period: DashboardPeriod,
): Promise<DashboardTrendSeries> {
  const [env, excluded] = await Promise.all([
    readDbEnv(),
    getExcludedUserIds(),
  ]);
  return getDashboardTrendSeries(
    period,
    blacklistNotInClause("id", excluded),
    env,
  );
}
