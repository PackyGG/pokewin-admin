import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { MapData, Period } from "@/lib/queries/map";

import { getUsersByCountryFromClickHouse } from "../queries/analytics/map";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics MAP tab. No-op unless the
 * `analytics_map` surface is in `comparison` mode. Diffs the platform-wide
 * aggregate signals (total users, without-location, country count, and the
 * rolled-up per-country user/deposit/wager totals) — per-country exactness is
 * proven by the parity harness. Money fields pass within half a cent; counts
 * must match exactly.
 */
function signals(d: MapData): Record<string, number> {
  let sumUserCount = 0;
  let sumDeposits = 0;
  let sumDepositCount = 0;
  let sumWager = 0;
  for (const c of d.byCountry) {
    sumUserCount += c.user_count;
    sumDeposits += c.total_deposits;
    sumDepositCount += c.deposit_count;
    sumWager += c.total_wager;
  }
  return {
    totalUsers: d.totalUsers,
    withoutLocation: d.withoutLocation,
    countryCount: d.byCountry.length,
    sumUserCount,
    sumDeposits,
    sumDepositCount,
    sumWager,
  };
}

export async function compareAnalyticsMap(
  period: Period,
  pg: MapData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_map");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getUsersByCountryFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(signals(pg), signals(ch), [
      "sumDeposits",
      "sumWager",
    ]);
    logComparison(`analytics.map[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_map",
      "comparison failed (ignored)",
      err,
    );
  }
}
