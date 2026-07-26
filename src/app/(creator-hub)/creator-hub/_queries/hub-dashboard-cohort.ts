import "server-only";

import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { drizzleForEnv } from "@/lib/db";
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

export type HubCohortWindowed = {
  period: DashboardPeriod;
  signups: number;
  ftds: number;
  depositsUsd: number;
  dailyWagers: HubWagerChartRow[];
  dailyDeposits: HubDepositChartRow[];
  dailySignupsFtds: HubSignupsFtdsChartRow[];
};

// `bucket` is a Date from the Postgres leg and a 'YYYY-MM-DD' string from the
type BucketRow = { bucket: Date | string; amount: string };
type CountBucketRow = { bucket: Date | string; value: string };
type WagerBucketRow = { bucket: Date | string; packs: string; battles: string };
type CountRow = { value: string };

type HubCohortScanBundle = {
  signupRows: CountRow[];
  ftdRows: CountRow[];
  depositTotalRows: CountRow[];
  signupSeriesRows: CountBucketRow[];
  ftdSeriesRows: CountBucketRow[];
  depositSeriesRows: BucketRow[];
  ledgerWagerSeriesRows: WagerBucketRow[];
  upgraderWagerSeriesRows: BucketRow[];
};

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

const cachedHubCohortScans = (
  period: DashboardPeriod,
  env: DbEnv,
  blacklistAnd: string,
  exclLedger: string,
  upgBlacklist: string,
  hasUpgrader: boolean,
) =>
  unstable_cache(
    async (): Promise<HubCohortWindowed> => {
      const db = drizzleForEnv(env);
      // Chart series always roll 30 daily buckets — independent of the KPI chip.
      const chartPeriod = HUB_CHART_PERIOD;
      // are deterministically comparable (mirrors crm / top-creators). The
      // anchor is fixed per unstable_cache entry (revalidate 300s).
      const now = new Date();
      const sinceKpiDate = hubPeriodToSinceDate(period, now);
      const sinceChartDate = hubPeriodToSinceDate(chartPeriod, now);
      const kpiIso = sinceKpiDate.toISOString();
      const chartIso = sinceChartDate.toISOString();
      const sinceSignup = `AND u.created_at >= '${kpiIso}'::timestamptz`;
      const sinceAcu = `AND acu.created_at >= '${kpiIso}'::timestamptz`;
      const sinceLt = `AND lt.created_at >= '${kpiIso}'::timestamptz`;
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

      const {
        signupRows,
        ftdRows,
        depositTotalRows,
        signupSeriesRows,
        ftdSeriesRows,
        depositSeriesRows,
        ledgerWagerSeriesRows,
        upgraderWagerSeriesRows,
      } = await (async (): Promise<HubCohortScanBundle> => {
          const [
            signupRows,
            ftdRows,
            depositTotalRows,
            signupSeriesRows,
            ftdSeriesRows,
            depositSeriesRows,
            ledgerWagerSeriesRows,
            upgraderWagerSeriesRows,
          ] = await Promise.all([
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
          return {
            signupRows,
            ftdRows,
            depositTotalRows,
            signupSeriesRows,
            ftdSeriesRows,
            depositSeriesRows,
            ledgerWagerSeriesRows,
            upgraderWagerSeriesRows,
          };
      })();

      const dailyWagers = padHubWagerChartSeries(
        mergeWagerBucketRows(
          ledgerWagerSeriesRows,
          upgraderWagerSeriesRows,
          chartPeriod,
        ),
        chartPeriod,
      );

      return {
        period,
        signups: toNumber(signupRows[0]?.value),
        ftds: toNumber(ftdRows[0]?.value),
        depositsUsd: toNumber(depositTotalRows[0]?.value),
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
      "hub-cohort-windowed-v6-signups-ftds-chart",
      period,
      env,
      blacklistAnd,
      exclLedger,
      upgBlacklist,
      String(hasUpgrader),
    ],
    { revalidate: 300, tags: ["creator-hub"] },
  );

export async function getHubCohortWindowed(
  period: DashboardPeriod,
): Promise<HubCohortWindowed> {
  return withTiming("creator-hub.cohort", async () => {
    const env = await readDbEnv();
    const probeDb = drizzleForEnv(env);
    const scope = await getMetricsScope();
    const excluded = await getExcludedUserIds();

    const blacklistAnd =
      excluded.length > 0
        ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
        : "";

    const exclLedger = scope.exclStaffSessionFrag({ tsCol: "created_at" });
    const upgBlacklist = blacklistNotInClause("u_ug.id", excluded);

    const upgProbe = await probeDb.execute<{ exists: string | null }>(sql`
      SELECT to_regclass('public.upgrader_games')::text AS exists
    `);
    const hasUpgrader = upgProbe.rows[0]?.exists != null;

    return cachedHubCohortScans(
      period,
      env,
      blacklistAnd,
      exclLedger,
      upgBlacklist,
      hasUpgrader,
    )();
  });
}
