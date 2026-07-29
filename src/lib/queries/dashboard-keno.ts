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

type RawKenoLifetime = {
  games: string;
  players: string;
  wager: string;
  payout: string;
};

/**
 * Exact lifetime settled Keno performance for the dashboard.
 *
 * This reads `keno_games` because it is the settlement source carrying both
 * the accepted stake and final player payout. The dashboard customer scope
 * excludes staff, creators, and the admin blacklist, matching the headline
 * customer wagering metrics beside this card. This exact lifetime contract
 * necessarily visits every customer Keno settlement. Read-only production
 * `EXPLAIN (ANALYZE, BUFFERS)` on 2026-07-29 scanned 2,702 tiny game rows,
 * joined users through `user_pkey`, and completed in 7.534 ms. The result is
 * cached for five minutes, matching the lifetime Upgrader aggregate beside it.
 */
async function computeDashboardKeno(
  env: DbEnv,
  blacklist: string[],
): Promise<KenoWindowMetrics> {
  return withTiming("dashboard.keno", async () => {
    const db = readDrizzleForEnv(env);
    const customerScope = excludeStaffCreatorsAndBlacklistedSqlFromIds(
      blacklist,
    ).replace(/^user_id\b/, "kg.user_id");
    const rows = await withTransientPostgresReadRetry(
      () =>
        queryRows<RawKenoLifetime[]>(
          db,
          `SELECT
             COUNT(*)::text AS games,
             COUNT(DISTINCT kg.user_id)::text AS players,
             COALESCE(SUM(kg.bet_amount::numeric), 0)::text AS wager,
             COALESCE(SUM(kg.won_amount::numeric), 0)::text AS payout
           FROM keno_games kg
           WHERE ${customerScope}`,
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

const cachedDashboardKenoLifetime = unstable_cache(
  async (
    env: DbEnv,
    blacklist: string[],
  ): Promise<KenoWindowMetrics> => {
    return computeDashboardKeno(env, blacklist);
  },
  ["dashboard-keno-lifetime-v1"],
  { revalidate: 300, tags: ["dashboard-activity", "keno-dashboard"] },
);

/**
 * Lifetime Keno read for the dashboard KPI strip.
 *
 * Production is cached for five minutes. The selected MAIN environment and
 * blacklist participate in the cache key; development remains live for
 * environment-toggle honesty.
 */
export async function getDashboardKenoLifetimeMetrics(): Promise<KenoWindowMetrics> {
  const env = await readDbEnv();
  const blacklist = await getExcludedUserIds();

  if (env !== "prod") {
    return computeDashboardKeno(env, blacklist);
  }

  return cachedDashboardKenoLifetime(env, blacklist);
}
