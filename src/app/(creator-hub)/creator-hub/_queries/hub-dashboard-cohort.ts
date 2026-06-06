import "server-only";

import { unstable_cache } from "next/cache";
import { getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import { getMetricsScope } from "@/lib/metrics/scope";
import { WAGER_TYPES_SQL } from "@/lib/metrics/ledger-sets";
import { WAGER_LEG_FILTER } from "@/lib/metrics/gaming-sql";
import {
  hubSinceClause,
  hubBucketTrunc,
  hubCoveringLateral,
} from "./hub-period-sql";
import { padHubChartSeries } from "./hub-chart-series";
import { type HubChartPoint } from "./hub-types";

export type { HubChartPoint };

export type HubCohortWindowed = {
  period: DashboardPeriod;
  signups: number;
  ftds: number;
  depositsUsd: number;
  wagerSeries: HubChartPoint[];
  depositSeries: HubChartPoint[];
};

type BucketRow = { bucket: Date; amount: string };

function formatBucketLabel(bucket: Date, period: DashboardPeriod): string {
  if (period === "24h") {
    return bucket.toISOString().slice(11, 16);
  }
  return bucket.toISOString().slice(5, 10);
}

function mergeBucketRows(
  rows: BucketRow[],
  period: DashboardPeriod,
): HubChartPoint[] {
  const byBucket = new Map<number, { label: string; value: number }>();
  for (const r of rows) {
    const d = new Date(r.bucket);
    const ts = d.getTime();
    const label = formatBucketLabel(d, period);
    const prev = byBucket.get(ts);
    byBucket.set(ts, {
      label,
      value: (prev?.value ?? 0) + toNumber(r.amount),
    });
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, point]) => point);
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
      const db = env === "dev" ? getDevDb() : getProdDb();
      const sinceSignup = hubSinceClause("u.created_at", period);
      const sinceAcu = hubSinceClause("acu.created_at", period);
      const sinceLt = hubSinceClause("lt.created_at", period);
      const sinceLedger = hubSinceClause("ledger_transactions.created_at", period);
      const sinceUpg = hubSinceClause("upgrader_games.created_at", period);
      const bucketDeposit = hubBucketTrunc("cd.created_at", period);
      const bucketLedger = hubBucketTrunc("ledger_transactions.created_at", period);
      const bucketUpg = hubBucketTrunc("upgrader_games.created_at", period);
      const covering = hubCoveringLateral;

      type CountRow = { value: string };

      const [
        signupRows,
        ftdRows,
        depositTotalRows,
        depositSeriesRows,
        ledgerWagerSeriesRows,
        upgraderWagerSeriesRows,
      ] = await Promise.all([
        db.$queryRawUnsafe<CountRow[]>(
          `SELECT COUNT(*)::text AS value
             FROM "user" u
             JOIN "user" c ON c.id = u.referred_by AND c.role = 'creator'
            WHERE u.role NOT IN ('admin', 'support', 'creator')
              AND u.referred_by IS NOT NULL
              ${sinceSignup}
              ${blacklistAnd}`,
        ),

        db.$queryRawUnsafe<CountRow[]>(
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

        db.$queryRawUnsafe<CountRow[]>(
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

        db.$queryRawUnsafe<BucketRow[]>(
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
                ${sinceLt}
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

        db.$queryRawUnsafe<BucketRow[]>(
          `SELECT ${bucketLedger} AS bucket,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type IN ${WAGER_TYPES_SQL}
                                    THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS amount
             FROM ledger_transactions
             ${covering("user_id", "created_at")}
            WHERE status = 'completed'
              ${sinceLedger}
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
          ? db.$queryRawUnsafe<BucketRow[]>(
              `SELECT ${bucketUpg} AS bucket,
                      COALESCE(SUM(upgrader_games.bet_amount::numeric), 0)::text AS amount
                 FROM upgrader_games
                 ${covering("user_id", "created_at")}
                WHERE user_id IN (
                    SELECT u_ug.id FROM "user" u_ug
                     WHERE u_ug.role NOT IN ('admin', 'support', 'creator') ${upgBlacklist}
                  )
                  ${sinceUpg}
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

      const wagerSeries = padHubChartSeries(
        mergeBucketRows(
          [...ledgerWagerSeriesRows, ...upgraderWagerSeriesRows],
          period,
        ),
        period,
      );

      return {
        period,
        signups: toNumber(signupRows[0]?.value),
        ftds: toNumber(ftdRows[0]?.value),
        depositsUsd: toNumber(depositTotalRows[0]?.value),
        wagerSeries,
        depositSeries: padHubChartSeries(
          mergeBucketRows(depositSeriesRows, period),
          period,
        ),
      };
    },
    [
      "hub-cohort-windowed-v3-padded-charts",
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
    const probeDb = env === "dev" ? getDevDb() : getProdDb();
    const scope = await getMetricsScope();
    const excluded = await getExcludedUserIds();

    const blacklistAnd =
      excluded.length > 0
        ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
        : "";

    const exclLedger = scope.exclStaffSessionFrag({ tsCol: "created_at" });
    const upgBlacklist = blacklistNotInClause("u_ug.id", excluded);

    const upgProbe = await probeDb.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = upgProbe[0]?.exists != null;

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
