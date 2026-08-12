import "server-only";

import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import { getMetricsScope } from "@/lib/metrics/scope";
import { WAGER_LEG_FILTER } from "@/lib/metrics/gaming-sql";
import {
  hubBucketTrunc,
  hubCoveringLateral,
  hubPeriodToSinceDate,
  HUB_CHART_PERIOD,
} from "./hub-period-sql";
import {
  chartDateForBucket,
  padHubDepositChartSeries,
  padHubSignupsFtdsChartSeries,
  padHubWagerChartSeries,
} from "./hub-chart-series";
import {
  type HubDepositChartRow,
  type HubSignupsFtdsChartRow,
  type HubWagerChartRow,
} from "./hub-types";

/**
 * Split cache design (active-timeframe-only):
 *
 *   • KPI scalars (signups / FTDs / deposits) are PERIOD-scoped — one cheap
 *     cached entry per period chip, so a chip flip only pays the three
 *     scalar scans for the new window.
 *   • Chart series are ALWAYS fixed 30 daily buckets (HUB_CHART_PERIOD) —
 *     one single cached entry, consumed only by the Trends band. A chip
 *     flip never re-runs the five chart scans.
 */

export type HubCohortKpis = {
  period: DashboardPeriod;
  signups: number;
  ftds: number;
  depositsUsd: number;
};

export type HubCohortCharts = {
  dailyWagers: HubWagerChartRow[];
  dailyDeposits: HubDepositChartRow[];
  dailySignupsFtds: HubSignupsFtdsChartRow[];
};

// `bucket` is a Date from the Postgres leg and a 'YYYY-MM-DD' string from the
type BucketRow = { bucket: Date | string; amount: string };
type CountBucketRow = { bucket: Date | string; value: string };
type WagerBucketRow = { bucket: Date | string; packs: string; battles: string };
type CountRow = { value: string };

function mergeWagerBucketRows(
  ledgerRows: WagerBucketRow[],
  upgraderRows: BucketRow[],
  period: DashboardPeriod,
): HubWagerChartRow[] {
  const byBucket = new Map<number, HubWagerChartRow>();

  for (const r of ledgerRows) {
    const d = new Date(r.bucket);
    const ts = d.getTime();
    const date = chartDateForBucket(d, period);
    const prev = byBucket.get(ts);
    byBucket.set(ts, {
      date,
      packs: (prev?.packs ?? 0) + toNumber(r.packs),
      battles: (prev?.battles ?? 0) + toNumber(r.battles),
      upgrader: prev?.upgrader ?? 0,
    });
  }

  for (const r of upgraderRows) {
    const d = new Date(r.bucket);
    const ts = d.getTime();
    const date = chartDateForBucket(d, period);
    const prev = byBucket.get(ts);
    byBucket.set(ts, {
      date,
      packs: prev?.packs ?? 0,
      battles: prev?.battles ?? 0,
      upgrader: (prev?.upgrader ?? 0) + toNumber(r.amount),
    });
  }

  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
}

function mergeSignupsFtdsBucketRows(
  signupRows: CountBucketRow[],
  ftdRows: CountBucketRow[],
  period: DashboardPeriod,
): HubSignupsFtdsChartRow[] {
  const byBucket = new Map<number, HubSignupsFtdsChartRow>();

  for (const r of signupRows) {
    const d = new Date(r.bucket);
    const ts = d.getTime();
    const date = chartDateForBucket(d, period);
    const prev = byBucket.get(ts);
    byBucket.set(ts, {
      date,
      signups: (prev?.signups ?? 0) + toNumber(r.value),
      ftds: prev?.ftds ?? 0,
    });
  }

  for (const r of ftdRows) {
    const d = new Date(r.bucket);
    const ts = d.getTime();
    const date = chartDateForBucket(d, period);
    const prev = byBucket.get(ts);
    byBucket.set(ts, {
      date,
      signups: prev?.signups ?? 0,
      ftds: (prev?.ftds ?? 0) + toNumber(r.value),
    });
  }

  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
}

function mergeDepositBucketRows(
  rows: BucketRow[],
  period: DashboardPeriod,
): HubDepositChartRow[] {
  const byBucket = new Map<number, HubDepositChartRow>();
  for (const r of rows) {
    const d = new Date(r.bucket);
    const ts = d.getTime();
    const date = chartDateForBucket(d, period);
    const prev = byBucket.get(ts);
    byBucket.set(ts, {
      date,
      amount: (prev?.amount ?? 0) + toNumber(r.amount),
    });
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
}

// ─── KPI scalars (period-scoped) ────────────────────────────────────

const cachedHubCohortKpiScans = (
  period: DashboardPeriod,
  env: DbEnv,
  blacklistAnd: string,
) =>
  unstable_cache(
    async (): Promise<HubCohortKpis> => {
      const db = readDrizzleForEnv(env);
      // The anchor is fixed per unstable_cache entry (revalidate 300s) so
      // buckets are deterministically comparable (mirrors crm / top-creators).
      const now = new Date();
      const sinceKpiDate = hubPeriodToSinceDate(period, now);
      const kpiIso = sinceKpiDate.toISOString();
      const sinceSignup = `AND u.created_at >= '${kpiIso}'::timestamptz`;
      const sinceAcu = `AND acu.created_at >= '${kpiIso}'::timestamptz`;
      const sinceLt = `AND lt.created_at >= '${kpiIso}'::timestamptz`;

      const [signupRows, ftdRows, depositTotalRows] = await Promise.all([
        queryRows<CountRow[]>(db,
          `SELECT COUNT(*)::text AS value
             FROM "user" u
             JOIN "user" c ON c.id = u.referred_by AND c.role = 'creator'
            WHERE u.role NOT IN ('admin', 'support', 'creator')
              AND u.referred_by IS NOT NULL
              ${sinceSignup}
              ${blacklistAnd}`,
        ),

        queryRows<CountRow[]>(db,
          `SELECT COUNT(DISTINCT acu.referred_user_id)::text AS value
             FROM affiliate_code_usages acu
             JOIN "user" c ON c.id = acu.affiliate_user_id AND c.role = 'creator'
             JOIN "user" u ON u.id = acu.referred_user_id
            WHERE acu.usage_type::text = 'deposit'
              AND acu.referred_user_id <> acu.affiliate_user_id
              AND u.role NOT IN ('admin', 'support', 'creator')
              ${sinceAcu}
              ${blacklistAnd}`,
        ),

        queryRows<CountRow[]>(db,
          `WITH covered_deposits AS (
             SELECT DISTINCT ON (lt.id)
                    lt.amount::numeric AS amount,
                    acu.affiliate_user_id AS creator_id
               FROM ledger_transactions lt
               JOIN "user" u ON u.id = lt.user_id
               LEFT JOIN affiliate_code_usages acu
                      ON acu.referred_user_id = lt.user_id
                     AND acu.created_at <= lt.created_at
                     AND acu.created_at >= lt.created_at - INTERVAL '7 days'
                     AND acu.referred_user_id <> acu.affiliate_user_id
              WHERE lt.type = 'deposit'
                AND lt.status = 'completed'
                AND u.role NOT IN ('admin', 'support', 'creator')
                ${sinceLt}
                ${blacklistAnd}
              ORDER BY lt.id, acu.created_at DESC
           )
           SELECT COALESCE(SUM(cd.amount), 0)::text AS value
             FROM covered_deposits cd
             JOIN "user" c ON c.id = cd.creator_id AND c.role = 'creator'
            WHERE cd.creator_id IS NOT NULL`,
        ),
      ]);

      return {
        period,
        signups: toNumber(signupRows[0]?.value),
        ftds: toNumber(ftdRows[0]?.value),
        depositsUsd: toNumber(depositTotalRows[0]?.value),
      };
    },
    ["hub-cohort-kpis-v1", period, env, blacklistAnd],
    { revalidate: 300, tags: ["creator-hub"] },
  );

/**
 * Period-scoped KPI scalars only (signups / FTDs / deposits) — the Overview
 * band's cohort leg. Deliberately does NOT touch the fixed-30d chart scans,
 * so a period-chip flip never pays for chart series it doesn't render.
 */
export async function getHubCohortKpis(
  period: DashboardPeriod,
): Promise<HubCohortKpis> {
  return withTiming("creator-hub.cohort-kpis", async () => {
    const env = await readDbEnv();
    const excluded = await getExcludedUserIds();

    const blacklistAnd =
      excluded.length > 0
        ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
        : "";

    return cachedHubCohortKpiScans(period, env, blacklistAnd)();
  });
}

// ─── Chart series (fixed 30 daily buckets, single cache entry) ──────

const cachedHubChartScans = (
  env: DbEnv,
  blacklistAnd: string,
  exclLedger: string,
  upgBlacklist: string,
  hasUpgrader: boolean,
) =>
  unstable_cache(
    async (): Promise<HubCohortCharts> => {
      const db = readDrizzleForEnv(env);
      // Chart series always roll 30 daily buckets — independent of the KPI
      // chip (HUB_CHART_PERIOD). Anchor fixed per cache entry (300s).
      const chartPeriod = HUB_CHART_PERIOD;
      const now = new Date();
      const sinceChartDate = hubPeriodToSinceDate(chartPeriod, now);
      const chartIso = sinceChartDate.toISOString();
      const sinceChartLt = `AND lt.created_at >= '${chartIso}'::timestamptz`;
      const sinceChartLedger = `AND ledger_transactions.created_at >= '${chartIso}'::timestamptz`;
      const sinceChartUpg = `AND upgrader_games.created_at >= '${chartIso}'::timestamptz`;
      const bucketDeposit = hubBucketTrunc("cd.created_at", chartPeriod);
      const bucketLedger = hubBucketTrunc(
        "ledger_transactions.created_at",
        chartPeriod,
      );
      const bucketUpg = hubBucketTrunc("upgrader_games.created_at", chartPeriod);
      const covering = hubCoveringLateral;

      const bucketSignup = hubBucketTrunc("u.created_at", chartPeriod);
      const bucketFtd = hubBucketTrunc("acu.created_at", chartPeriod);
      const sinceChartSignup = `AND u.created_at >= '${chartIso}'::timestamptz`;
      const sinceChartAcu = `AND acu.created_at >= '${chartIso}'::timestamptz`;

      const [
        signupSeriesRows,
        ftdSeriesRows,
        depositSeriesRows,
        ledgerWagerSeriesRows,
        upgraderWagerSeriesRows,
      ] = await Promise.all([
        queryRows<CountBucketRow[]>(db,
          `SELECT ${bucketSignup} AS bucket, COUNT(*)::text AS value
             FROM "user" u
             JOIN "user" c ON c.id = u.referred_by AND c.role = 'creator'
            WHERE u.role NOT IN ('admin', 'support', 'creator')
              AND u.referred_by IS NOT NULL
              ${sinceChartSignup}
              ${blacklistAnd}
            GROUP BY 1
            ORDER BY 1`,
        ),

        queryRows<CountBucketRow[]>(db,
          `SELECT ${bucketFtd} AS bucket,
                  COUNT(DISTINCT acu.referred_user_id)::text AS value
             FROM affiliate_code_usages acu
             JOIN "user" c ON c.id = acu.affiliate_user_id AND c.role = 'creator'
             JOIN "user" u ON u.id = acu.referred_user_id
            WHERE acu.usage_type::text = 'deposit'
              AND acu.referred_user_id <> acu.affiliate_user_id
              AND u.role NOT IN ('admin', 'support', 'creator')
              ${sinceChartAcu}
              ${blacklistAnd}
            GROUP BY 1
            ORDER BY 1`,
        ),

        queryRows<BucketRow[]>(db,
          `WITH covered_deposits AS (
             SELECT DISTINCT ON (lt.id)
                    lt.amount::numeric AS amount,
                    lt.created_at,
                    acu.affiliate_user_id AS creator_id
               FROM ledger_transactions lt
               JOIN "user" u ON u.id = lt.user_id
               LEFT JOIN affiliate_code_usages acu
                      ON acu.referred_user_id = lt.user_id
                     AND acu.created_at <= lt.created_at
                     AND acu.created_at >= lt.created_at - INTERVAL '7 days'
                     AND acu.referred_user_id <> acu.affiliate_user_id
              WHERE lt.type = 'deposit'
                AND lt.status = 'completed'
                AND u.role NOT IN ('admin', 'support', 'creator')
                ${sinceChartLt}
                ${blacklistAnd}
              ORDER BY lt.id, acu.created_at DESC
           )
           SELECT ${bucketDeposit} AS bucket,
                  COALESCE(SUM(cd.amount), 0)::text AS amount
             FROM covered_deposits cd
             JOIN "user" c ON c.id = cd.creator_id AND c.role = 'creator'
            WHERE cd.creator_id IS NOT NULL
            GROUP BY 1
            ORDER BY 1`,
        ),

        queryRows<WagerBucketRow[]>(db,
          `SELECT ${bucketLedger} AS bucket,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type::text = 'pack_opening'
                                    THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS packs,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type::text IN ('battle_bet','battle_sponsorship')
                                    THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS battles
             FROM ledger_transactions
             ${covering("user_id", "created_at")}
            WHERE status = 'completed'
              ${sinceChartLedger}
              AND ${WAGER_LEG_FILTER}
              ${exclLedger}
              AND cov.creator_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM "user" c
                 WHERE c.id = cov.creator_id AND c.role = 'creator'
              )
            GROUP BY 1
            ORDER BY 1`,
        ),

        hasUpgrader
          ? queryRows<BucketRow[]>(db,
              `SELECT ${bucketUpg} AS bucket,
                      COALESCE(SUM(upgrader_games.bet_amount::numeric), 0)::text AS amount
                 FROM upgrader_games
                 ${covering("user_id", "created_at")}
                WHERE user_id IN (
                    SELECT u_ug.id FROM "user" u_ug
                     WHERE u_ug.role NOT IN ('admin', 'support', 'creator') ${upgBlacklist}
                  )
                  ${sinceChartUpg}
                  AND cov.creator_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM "user" c
                     WHERE c.id = cov.creator_id AND c.role = 'creator'
                  )
                GROUP BY 1
                ORDER BY 1`,
            )
          : Promise.resolve([] as BucketRow[]),
      ]);

      const dailyWagers = padHubWagerChartSeries(
        mergeWagerBucketRows(
          ledgerWagerSeriesRows,
          upgraderWagerSeriesRows,
          chartPeriod,
        ),
        chartPeriod,
      );

      return {
        dailyWagers,
        dailyDeposits: padHubDepositChartSeries(
          mergeDepositBucketRows(depositSeriesRows, chartPeriod),
          chartPeriod,
        ),
        dailySignupsFtds: padHubSignupsFtdsChartSeries(
          mergeSignupsFtdsBucketRows(
            signupSeriesRows,
            ftdSeriesRows,
            chartPeriod,
          ),
          chartPeriod,
        ),
      };
    },
    [
      "hub-cohort-charts-30d-v1",
      env,
      blacklistAnd,
      exclLedger,
      upgBlacklist,
      String(hasUpgrader),
    ],
    { revalidate: 300, tags: ["creator-hub"] },
  );

/**
 * Does this database carry `upgrader_games`?
 *
 * It has to be resolved OUTSIDE `cachedHubChartScans` because it is part of
 * that entry's cache key. Un-memoized it was therefore a full extra MAIN read
 * on EVERY Creator Hub dashboard render — and under the mirror pool's
 * `maxUses: 1` a "trivial" `to_regclass` still costs a permit plus a fresh
 * connection handshake, on the busiest page in the Hub.
 *
 * Whether a table exists changes only on a deploy/migration, so an hour-long
 * entry is generous and still self-heals. Keyed on `env` so the prod and dev
 * mirrors are probed independently, and pinned to the env-resolved client
 * (never the request-scoped resolver, which would fall back to "prod" inside
 * the cache scope). `to_regclass` returns NULL rather than erroring for a
 * missing relation, so the probe cannot throw on a pre-upgrader DB.
 */
const cachedUpgraderTableProbe = (env: DbEnv) =>
  unstable_cache(
    async (): Promise<boolean> => {
      const probe = await readDrizzleForEnv(env).execute<{
        exists: string | null;
      }>(sql`SELECT to_regclass('public.upgrader_games')::text AS exists`);
      return probe.rows[0]?.exists != null;
    },
    ["hub-upgrader-table-probe-v1", env],
    { revalidate: 3600, tags: ["creator-hub"] },
  );

/**
 * Fixed-30d chart series (wagers / deposits / sign-ups & FTDs) — the Trends
 * band's only data source. Single cache entry: a period-chip flip elsewhere
 * on the page never invalidates or re-runs these scans.
 */
export async function getHubCohortCharts(): Promise<HubCohortCharts> {
  return withTiming("creator-hub.cohort-charts", async () => {
    const env = await readDbEnv();
    const scope = await getMetricsScope();
    const excluded = await getExcludedUserIds();

    const blacklistAnd =
      excluded.length > 0
        ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
        : "";

    const exclLedger = scope.exclStaffSessionFrag({ tsCol: "created_at" });
    const upgBlacklist = blacklistNotInClause("u_ug.id", excluded);

    const hasUpgrader = await cachedUpgraderTableProbe(env)();

    return cachedHubChartScans(
      env,
      blacklistAnd,
      exclLedger,
      upgBlacklist,
      hasUpgrader,
    )();
  });
}
