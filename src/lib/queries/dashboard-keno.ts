import "server-only";

import { unstable_cache } from "next/cache";

import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { queryRows } from "@/lib/drizzle-query";
import {
  deriveKenoWindowMetrics,
  type KenoWindowMetrics,
} from "@/lib/keno/window-metrics";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { withTransientPostgresReadRetry } from "@/lib/postgres-read-retry";
import { excludeStaffCreatorsAndBlacklistedSqlFromIds } from "./_blacklist";
import { kpiWindowToCutoff, type DashboardKpiWindow } from "./dashboard-period";

type RawKenoWindow = {
  games: string;
  players: string;
  wager: string;
  payout: string;
};

/**
 * Settled Keno performance for one dashboard window.
 *
 * This reads `keno_games` because it is the settlement source carrying both
 * the accepted stake and final player payout. The dashboard customer scope
 * excludes staff, creators, and the admin blacklist, matching the headline
 * customer wagering metrics beside this card. Read-only production
 * `EXPLAIN (ANALYZE, BUFFERS)` on 2026-07-27 used
 * `idx_keno_games_user_id_created_at` plus `user_pkey` and completed in
 * 0.428 ms; no MAIN index change is required.
 */
async function computeDashboardKeno(
  env: DbEnv,
  cutoff: Date,
  blacklist: string[],
): Promise<KenoWindowMetrics> {
  return withTiming("dashboard.keno", async () => {
    const db = readDrizzleForEnv(env);
    const customerScope = excludeStaffCreatorsAndBlacklistedSqlFromIds(
      blacklist,
    ).replace(/^user_id\b/, "kg.user_id");
    const rows = await withTransientPostgresReadRetry(
      () =>
        queryRows<RawKenoWindow[]>(
          db,
          `SELECT
             COUNT(*)::text AS games,
             COUNT(DISTINCT kg.user_id)::text AS players,
             COALESCE(SUM(kg.bet_amount::numeric), 0)::text AS wager,
             COALESCE(SUM(kg.won_amount::numeric), 0)::text AS payout
           FROM keno_games kg
           WHERE kg.created_at >= $1
             AND ${customerScope}`,
          cutoff,
        ),
      { context: "dashboard.keno" },
    );
    const row = rows[0];

    return deriveKenoWindowMetrics({
      games: Number(row?.games ?? 0),
      players: Number(row?.players ?? 0),
      wager: toNumber(row?.wager),
      payout: toNumber(row?.payout),
    });
  });
}

const cachedDashboardKeno = unstable_cache(
  async (
    env: DbEnv,
    _window: DashboardKpiWindow,
    cutoffIso: string,
    blacklist: string[],
  ): Promise<KenoWindowMetrics> => {
    void _window;
    return computeDashboardKeno(env, new Date(cutoffIso), blacklist);
  },
  ["dashboard-keno-v1"],
  { revalidate: 60, tags: ["dashboard-activity", "keno-dashboard"] },
);

/**
 * Active-window-only Keno read for the dashboard KPI strip.
 *
 * Production is cached for the dashboard's 60-second refresh cadence. The
 * selected MAIN environment, resolved cutoff, and blacklist all participate
 * in the cache key; development remains live for environment-toggle honesty.
 */
export async function getDashboardKenoMetrics(
  window: DashboardKpiWindow,
  now: Date = new Date(),
): Promise<KenoWindowMetrics> {
  const env = await readDbEnv();
  const cutoff = kpiWindowToCutoff(window, now);
  const blacklist = await getExcludedUserIds();

  if (env !== "prod") {
    return computeDashboardKeno(env, cutoff, blacklist);
  }

  return cachedDashboardKeno(env, window, cutoff.toISOString(), blacklist);
}
