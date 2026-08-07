import "server-only";

import { sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getWindowMetrics, type WindowMetrics } from "@/lib/metrics/queries";
import { toNumber } from "@/lib/utils/decimal";
import { blacklistNotInClause } from "./_blacklist";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  parsePeriodWindowRow,
  runPeriodWindowQuery,
} from "./period-window-kpis";

export type HouseMoneyKpis = {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  wager: number;
  wagerOrganic: number;
  wagerCreatorCoded: number;
  upgraderOrganic: number;
  organicCustomerStake: number;
  ggr: number;
};

const EMPTY_WINDOW_METRICS: WindowMetrics = {
  wager: 0,
  organicWager: 0,
  gamingPayout: 0,
  ggr: 0,
  ngr: 0,
  rtp: null,
  houseEdge: null,
  bets: 0,
  rainWinTotal: 0,
  rainTipTotal: 0,
  rainHouseCost: 0,
};

async function getOrganicUpgraderStake(
  cutoff: Date,
  excludedIds: readonly string[],
): Promise<number> {
  const db = await getReadDrizzleDb();
  const probe = await db.execute<{ exists: string | null }>(sql`
    SELECT to_regclass('public.upgrader_games')::text AS exists
  `);
  if (probe.rows[0]?.exists == null) return 0;

  const blacklistFilter =
    excludedIds.length === 0
      ? sql``
      : sql`AND u.id NOT IN (${sql.join(
          excludedIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const result = await db.execute<{ upgrader_organic: string }>(sql`
    WITH real_users AS (
      SELECT u.id,
             EXISTS (
               SELECT 1 FROM "user" ref
               WHERE ref.id = u.referred_by AND ref.role = 'creator'
             ) AS under_creator
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistFilter}
    )
    SELECT
      COALESCE(SUM(ug.bet_amount::numeric), 0)::text AS upgrader_organic
    FROM upgrader_games ug
    JOIN real_users ru ON ru.id = ug.user_id
    WHERE NOT ru.under_creator
      AND ug.created_at >= ${cutoff}
  `);
  return toNumber(result.rows[0]?.upgrader_organic);
}

/** Canonical house money KPIs for an explicit rolling cutoff. */
export async function getCanonicalMoneyKpis(
  cutoff: Date,
): Promise<HouseMoneyKpis> {
  const [excluded, sessionWindowsCte] = await Promise.all([
    getExcludedUserIds(),
    getCreatorSessionWindowsCte(),
  ]);
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  const [windowRows, windowRes, upgraderOrganic] = await Promise.all([
    runPeriodWindowQuery({
      currentCutoff: cutoff,
      previousStart: null,
      previousEnd: null,
      blacklistIdNotIn,
      sessionWindowsCte,
    }),
    safeQuery(
      () => getWindowMetrics({ window: { since: cutoff } }),
      EMPTY_WINDOW_METRICS,
      "house-kpis.windowMetrics",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    getOrganicUpgraderStake(cutoff, [...excluded]),
  ]);

  const parsed = parsePeriodWindowRow(windowRows.current);
  return {
    deposits: parsed.deposits,
    depositCount: parsed.depositCount,
    withdrawals: parsed.withdrawals,
    wager: parsed.wager,
    wagerOrganic: parsed.wagerOrganic,
    wagerCreatorCoded: parsed.wagerCreatorCoded,
    upgraderOrganic,
    organicCustomerStake: parsed.wagerOrganic + upgraderOrganic,
    ggr: windowRes.data?.ggr ?? 0,
  };
}
