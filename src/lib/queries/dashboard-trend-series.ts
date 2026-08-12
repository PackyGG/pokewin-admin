import "server-only";

import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  buildCacheKey,
  cacheGetOrSet,
  cacheGetOrSetStale,
  hashString,
} from "@/lib/cache/redis";
import {
  REWARD_QUERY_TIMEOUT_MS,
  safeQuery,
  withTimeout,
  type SafeQueryResult,
} from "@/lib/errors/safe-query";
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

/**
 * Wall-clock bound for the whole two-leg trend computation.
 *
 * This MUST stay above `REWARD_QUERY_TIMEOUT_MS` (the per-leg cap applied by
 * each `safeQuery` below). It previously sat at 10s — BELOW the 15s per-leg
 * cap — which silently disabled the per-leg degradation this module is built
 * around: a single leg that ran 10–15s tripped the outer race before its own
 * `safeQuery` could degrade it, so `fetchTrendSeriesPg` never returned at all
 * and every chart fell back to "Live data is temporarily unavailable"
 * (including the Wager-attribution tile) even though five legs had succeeded.
 *
 * Both consolidated legs run concurrently. We deliberately keep a larger
 * outer budget than either leg's query budget so `safeQuery` can publish the
 * successful group when the other group fails or times out.
 */
const TREND_SNAPSHOT_TIMEOUT_MS = 25_000;

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
  dailyWagerAttribution: {
    date: string;
    organic: number;
    creatorCoded: number;
  }[];
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

type MoneyBucketRow = {
  bucket: Date | string;
  packs: string;
  battles: string;
  keno: string;
  upgrader: string;
  double_down: string;
  deposits: string;
  active_depositors: string;
  organic: string;
  creator_attributed: string;
};

type AcquisitionBucketRow = {
  kind: "signup" | "ftd";
  bucket: Date | string;
  count: string;
  total: string;
};

function bucketKey(d: Date | string, period: DashboardPeriod): string {
  return dashboardChartDateLabel(new Date(d), period);
}

function mergeLedgerRows(
  rows: MoneyBucketRow[],
  period: DashboardPeriod,
): Pick<
  DashboardTrendSeries,
  "dailyWagers" | "dailyDeposits" | "dailyActiveDepositors"
> {
  const wagerRows = rows.map((d) => {
    const date = bucketKey(d.bucket, period);
    return {
      date,
      packs: Number(d.packs),
      battles: Number(d.battles),
      keno: Number(d.keno),
      upgrader: Number(d.upgrader),
      doubleDown: Number(d.double_down),
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

/**
 * Mutable per-group result slots. Each query writes its own slot the moment it
 * settles, so a caller that gives up waiting (see `TREND_SNAPSHOT_TIMEOUT_MS`)
 * can still build a snapshot from the legs that DID finish. A `null` slot is
 * simply an unavailable series — exactly the same shape a failed leg produces.
 */
type TrendLegSlots = {
  money: SafeQueryResult<MoneyBucketRow[]> | null;
  acquisition: SafeQueryResult<AcquisitionBucketRow[]> | null;
  schemaProbeOk: boolean;
};

function emptyTrendLegSlots(): TrendLegSlots {
  return {
    money: null,
    acquisition: null,
    schemaProbeOk: false,
  };
}

/**
 * Build a snapshot from whichever consolidated query groups have settled.
 */
function buildTrendSnapshot(
  slots: TrendLegSlots,
  period: DashboardPeriod,
): DashboardTrendSeries {
  const ledgerMerged = mergeLedgerRows(slots.money?.data ?? [], period);

  const acquisitionRows = slots.acquisition?.data ?? [];

  const dailySignups = padDashboardCountSeries(
    acquisitionRows
      .filter((r) => r.kind === "signup")
      .map((r) => ({
        date: bucketKey(r.bucket, period),
        count: Number(r.count),
      })),
    period,
  );

  const dailyWagerAttribution = padDashboardAttributionSeries(
    (slots.money?.data ?? []).map((r) => ({
      date: bucketKey(r.bucket, period),
      organic: Number(r.organic),
      creatorCoded: Number(r.creator_attributed),
    })),
    period,
  );

  const dailyFtds = padDashboardFtdSeries(
    acquisitionRows
      .filter((r) => r.kind === "ftd")
      .map((r) => {
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

  const nowIso = new Date().toISOString();
  const moneyOk = slots.money?.error === null;
  const acquisitionOk = slots.acquisition?.error === null;
  return {
    ...ledgerMerged,
    dailySignups,
    dailyFtds,
    dailyWagerAttribution,
    chartHourlyBuckets: dashboardChartHourlyBuckets(period),
    capturedAtIso: nowIso,
    servedAtIso: nowIso,
    availability: {
      wagers: moneyOk && slots.schemaProbeOk,
      deposits: moneyOk,
      signups: acquisitionOk,
      ftds: acquisitionOk,
      activeDepositors: moneyOk,
      wagerAttribution: moneyOk && slots.schemaProbeOk,
    },
  };
}

export function isCompleteTrendSnapshot(
  snapshot: DashboardTrendSeries,
): boolean {
  return Object.values(snapshot.availability).every(Boolean);
}

async function fetchTrendSeriesPg(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
  slots: TrendLegSlots = emptyTrendLegSlots(),
): Promise<DashboardTrendSeries> {
  const db = readDrizzleForEnv(env);
  const now = new Date();
  const cutoff = dashboardChartCutoff(period, now, LIFETIME_LOOKBACK_DAYS);
  const cutoffBind = cutoff.toISOString();
  const bucketEvent = dashboardChartBucketExpr("e.created_at", period);
  const bucketUser = dashboardChartBucketExpr("created_at", period);
  const bucketFtd = dashboardChartBucketExpr("fd.created_at", period);

  // One catalog round trip replaces the former pair of probes. Optional game
  // tables differ between local/dev snapshots, so their SQL arms remain
  // conditional without making the common production path pay two checkouts.
  const schemaProbe = await safeQuery(
    () =>
      queryRows<
        {
          upgrader: string | null;
          double_down: string | null;
        }[]
      >(
        db,
        `
      SELECT to_regclass('public.upgrader_games')::text AS upgrader,
             to_regclass('public.battle_double_down_offers')::text AS double_down`,
      ),
    [],
    "dashboard.trends.schemaProbe",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const hasUpgrader = schemaProbe.data[0]?.upgrader != null;
  const hasDoubleDown = schemaProbe.data[0]?.double_down != null;
  slots.schemaProbeOk = schemaProbe.error === null;

  const upgraderUnion = hasUpgrader
    ? `UNION ALL
       SELECT ug.user_id, 'upgrader'::text AS type,
              ug.bet_amount::numeric AS amount, ug.created_at
       FROM upgrader_games ug
       WHERE ug.created_at >= $1`
    : "";
  const doubleDownUnion = hasDoubleDown
    ? `UNION ALL
       SELECT o.user_id, 'double_down'::text AS type,
              o.won_amount_usd::numeric AS amount,
              o.resolved_at AS created_at
       FROM battle_double_down_offers o
       WHERE o.result IS NOT NULL AND o.resolved_at >= $1`
    : "";

  // The old money path ran four independent queries: ledger, upgrader,
  // double-down, and then a second full scan of all wager events solely for
  // creator attribution. This normalized event stream scans each source once,
  // joins customer scope once, and derives all six money series in one GROUP.
  const moneyPromise = safeQuery(
    () =>
      queryRows<MoneyBucketRow[]>(
        db,
        `
      WITH customers AS MATERIALIZED (
        SELECT u.id, (ref.id IS NOT NULL) AS under_creator
          FROM (
            SELECT id, referred_by
              FROM "user"
             WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
          ) u
          LEFT JOIN "user" ref
            ON ref.id = u.referred_by AND ref.role = 'creator'
      ), events AS (
        SELECT user_id, type::text AS type, amount::numeric AS amount, created_at
          FROM ledger_transactions
         WHERE type::text IN ('pack_opening','battle_bet','battle_sponsorship','keno_bet','deposit')
           AND status = 'completed'
           AND created_at >= $1
           AND ${WAGER_LEG_FILTER}
        UNION ALL
        SELECT i.user_id, 'deposit_refund'::text,
               -${fiatRefundCreditUsdSql("i")},
               ${fiatRefundAttributionTimestampSql("i")}
          FROM fiat_deposit_intents i
         WHERE i.status IN ('partially_refunded', 'refunded')
           AND ${fiatRefundAttributionTimestampSql("i")} >= $1
        ${upgraderUnion}
        ${doubleDownUnion}
      )
      SELECT ${bucketEvent} AS bucket,
             COALESCE(SUM(ABS(e.amount)) FILTER (WHERE e.type = 'pack_opening'), 0)::text AS packs,
             COALESCE(SUM(ABS(e.amount)) FILTER (WHERE e.type IN ('battle_bet','battle_sponsorship')), 0)::text AS battles,
             COALESCE(SUM(ABS(e.amount)) FILTER (WHERE e.type = 'keno_bet'), 0)::text AS keno,
             COALESCE(SUM(e.amount) FILTER (WHERE e.type = 'upgrader'), 0)::text AS upgrader,
             COALESCE(SUM(e.amount) FILTER (WHERE e.type = 'double_down'), 0)::text AS double_down,
             COALESCE(SUM(e.amount) FILTER (WHERE e.type IN ('deposit','deposit_refund')), 0)::text AS deposits,
             (COUNT(DISTINCT e.user_id) FILTER (WHERE e.type = 'deposit'))::text AS active_depositors,
             COALESCE(SUM(ABS(e.amount)) FILTER (
               WHERE e.type IN ('pack_opening','battle_bet','battle_sponsorship','keno_bet','upgrader','double_down')
                 AND NOT c.under_creator
             ), 0)::text AS organic,
             COALESCE(SUM(ABS(e.amount)) FILTER (
               WHERE e.type IN ('pack_opening','battle_bet','battle_sponsorship','keno_bet','upgrader','double_down')
                 AND c.under_creator
             ), 0)::text AS creator_attributed
        FROM events e
        JOIN customers c ON c.id = e.user_id
       GROUP BY 1
       ORDER BY 1`,
        cutoffBind,
      ),
    [],
    "dashboard.trends.money",
    REWARD_QUERY_TIMEOUT_MS,
  ).then((result) => (slots.money = result));

  // Signups and FTDs touch different base relations, but share one checkout
  // and one wire response. Keeping this separate from money preserves useful
  // partial rendering if either broad workload times out.
  const acquisitionPromise = safeQuery(
    () =>
      queryRows<AcquisitionBucketRow[]>(
        db,
        `
      WITH signup_buckets AS (
        SELECT ${bucketUser} AS bucket, COUNT(*)::text AS count
          FROM "user"
         WHERE created_at >= $1
           AND role NOT IN ('admin', 'support') ${blacklistIdNotIn}
           AND is_locked = false
         GROUP BY 1
      ), first_deposits AS (
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
      ), ftd_buckets AS (
        SELECT ${bucketFtd} AS bucket,
               COUNT(*)::text AS count,
               COALESCE(SUM(amount), 0)::text AS total
          FROM first_deposits fd
         WHERE fd.created_at >= $1
         GROUP BY 1
      )
      SELECT 'signup'::text AS kind, bucket, count, '0'::text AS total
        FROM signup_buckets
      UNION ALL
      SELECT 'ftd'::text AS kind, bucket, count, total
        FROM ftd_buckets
      ORDER BY bucket, kind`,
        cutoffBind,
      ),
    [],
    "dashboard.trends.acquisition",
    REWARD_QUERY_TIMEOUT_MS,
  ).then((result) => (slots.acquisition = result));

  await Promise.all([moneyPromise, acquisitionPromise]);

  return buildTrendSnapshot(slots, period);
}

/** Uncached PostgreSQL computation wrapped by cachedDashboardTrendSeries. */
async function fetchDashboardTrendSeriesInner(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
  slots?: TrendLegSlots,
): Promise<DashboardTrendSeries> {
  return fetchTrendSeriesPg(period, blacklistIdNotIn, env, slots);
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

/**
 * Fresh window for the snapshot that a request actually served, degraded or
 * not.
 *
 * A snapshot with any unavailable leg is deliberately refused a main-cache
 * entry (see below), so while one leg stays slow NOTHING is ever cached and
 * every single request re-pays the whole aggregate fan-out — which is precisely
 * what keeps the mirror pool saturated and that leg slow. This short window
 * breaks the feedback loop without weakening the invariant it protects: a
 * partial snapshot lives under its own key and can never replace the
 * last-known-good complete value the main key retains.
 */
const TREND_SERVED_SNAPSHOT_TTL_SECONDS = 15;

export async function getDashboardTrendSeries(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
): Promise<DashboardTrendSeries> {
  if (env !== "prod") {
    return fetchDashboardTrendSeriesInner(period, blacklistIdNotIn, env);
  }

  const key = buildCacheKey("dashboard-trends-v6-consolidated", [
    env,
    period,
    hashString(blacklistIdNotIn),
  ]);
  const snapshot = await cacheGetOrSet(
    `${key}:served`,
    TREND_SERVED_SNAPSHOT_TTL_SECONDS,
    () => loadDashboardTrendSnapshot(period, blacklistIdNotIn, env, key),
  );
  // `servedAtIso` is stamped after the cache so it always reports THIS render.
  return { ...snapshot, servedAtIso: new Date().toISOString() };
}

async function loadDashboardTrendSnapshot(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
  env: DbEnv,
  key: string,
): Promise<DashboardTrendSeries> {
  // Query groups publish into `slots` as they settle, so this stays populated
  // even when the outer race below gives up.
  const slots = emptyTrendLegSlots();
  try {
    return await cacheGetOrSetStale(key, 60, 24 * 60 * 60, async () => {
      const result = await withTimeout(
        () =>
          fetchDashboardTrendSeriesInner(period, blacklistIdNotIn, env, slots),
        TREND_SNAPSHOT_TIMEOUT_MS,
      );
      // Only a COMPLETE snapshot earns a cache entry: caching a degraded one
      // would pin a half-empty grid for the full 60s fresh window and hide a
      // recovery. `cacheGetOrSetStale` serves the last good retained value
      // when this throws, so a degraded refresh never blanks a healthy cache.
      if (!isCompleteTrendSnapshot(result)) {
        throw new Error("dashboard trend snapshot was incomplete");
      }
      return result;
    });
  } catch {
    // Serve whatever legs finished. Previously this returned the all-false
    // empty snapshot whenever the outer timeout fired (the assignment never
    // ran), which is what surfaced "Live data is temporarily unavailable" on
    // every tile — Wager attribution included — despite most legs succeeding.
    return buildTrendSnapshot(slots, period);
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
