import "server-only";

import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getWindowMetrics, type WindowMetrics } from "@/lib/metrics/queries";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { MS_PER_MINUTE } from "@/lib/utils/time";
import {
  periodToCutoff,
  type DashboardPeriod,
} from "./dashboard-period";
import {
  runPeriodWindowQuery,
  parsePeriodWindowRow,
} from "./period-window-kpis";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";

/**
 * Canonical house money KPIs for a rolling window — single source of truth
 * for deposits / withdrawals / customer wager across the admin top bar,
 * Analytics Insights overview, and Edge Plan 2 baseline.
 *
 *   • deposits / withdrawals / wager / organic split ← `runPeriodWindowQuery`
 *     (ledger + card_withdrawal_requests; matches Analytics Insights Wager
 *     tile — customer stake ex creator on-stream, no borrow-leg filter)
 *   • GGR ← `getWindowMetrics` (canonical gaming legs incl. upgrader,
 *     borrow-corrected scope)
 */
export const TOPBAR_HOUSE_PERIOD: DashboardPeriod = "30d";

export type HouseMoneyKpis = {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  /** Customer wager (ledger pack/battle, ex creator on-stream — Insights Wager tile). */
  wager: number;
  /** Ledger organic stake (no creator code; on-stream excluded; borrow incl.). */
  wagerOrganic: number;
  wagerCreatorCoded: number;
  /** Upgrader stake from non-creator-coded users in the window. */
  upgraderOrganic: number;
  /** wagerOrganic + upgraderOrganic — headline organic customer stake. */
  organicCustomerStake: number;
  ggr: number;
};

const EMPTY_WINDOW_METRICS: WindowMetrics = {
  wager: 0,
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

function bucketedNow(): Date {
  return new Date(Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

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

export async function getCanonicalMoneyKpis(cutoff: Date): Promise<HouseMoneyKpis> {
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
  const organicCustomerStake = parsed.wagerOrganic + upgraderOrganic;

  return {
    deposits: parsed.deposits,
    depositCount: parsed.depositCount,
    withdrawals: parsed.withdrawals,
    wager: parsed.wager,
    wagerOrganic: parsed.wagerOrganic,
    wagerCreatorCoded: parsed.wagerCreatorCoded,
    upgraderOrganic,
    organicCustomerStake,
    ggr: windowRes.data?.ggr ?? 0,
  };
}

const cachedTopbarHouseKpis = unstable_cache(
  async (cutoffIso: string, blacklistIdNotIn: string) => {
    void blacklistIdNotIn;
    return getCanonicalMoneyKpis(new Date(cutoffIso));
  },
  // v2 → v3-dd: pulls GGR which now folds Double Down (see getGamingLegs).
  ["topbar-house-kpis-v3-dd"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/** 30d rolling house KPIs for the admin top-bar pills. */
export async function getTopbarHouseKpis(): Promise<HouseMoneyKpis> {
  const now = bucketedNow();
  const cutoff = periodToCutoff(TOPBAR_HOUSE_PERIOD, now);
  const blacklistIdNotIn = blacklistNotInClause(
    "id",
    await getExcludedUserIds(),
  );
  return cachedTopbarHouseKpis(cutoff.toISOString(), blacklistIdNotIn);
}
