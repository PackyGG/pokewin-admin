import "server-only";

import { unstable_cache } from "next/cache";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateWindowedPnl } from "./pnl";

/**
 * Rolling 7-day house P&L for the dashboard snapshot row.
 *
 * Uses the canonical windowed-delta formula (`calculateWindowedPnl`) over
 * [now − 7d, now), same real-customer scope as P&L Today (staff + blacklist
 * dropped). `avgDailyPnl` = total ÷ 7 for a per-day average comparable to
 * the Deposits/Hour tile's 24h vs 7d pattern.
 */

export type AvgPnl7d = {
  /** Total realized house P&L over the rolling 7d window. */
  totalPnl7d: number;
  /** totalPnl7d ÷ 7 — average per calendar day in the window. */
  avgDailyPnl: number;
};

const ROLLING_7D_MS = 7 * 24 * 60 * 60 * 1000;

const cachedAvgPnl7d = unstable_cache(
  async (blacklistKey: string): Promise<Omit<AvgPnl7d, never>> => {
    void blacklistKey;
    return withTiming("dashboard.avgPnl7d", async () => {
      const excludeUserIds = await getExcludedUserIds();
      const since = new Date(Date.now() - ROLLING_7D_MS);
      const { pnl } = await calculateWindowedPnl({ since, excludeUserIds });
      return {
        totalPnl7d: pnl,
        avgDailyPnl: pnl / 7,
      };
    });
  },
  ["dashboard-avg-pnl-7d-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

export async function getAvgPnl7d(): Promise<AvgPnl7d> {
  const blacklist = await getExcludedUserIds();
  const blacklistKey = [...blacklist].sort().join(",");
  return cachedAvgPnl7d(blacklistKey);
}
