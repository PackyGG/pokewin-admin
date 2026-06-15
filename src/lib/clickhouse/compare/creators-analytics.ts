import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { AffiliateAnalyticsData } from "@/lib/queries/creators-types";

import { getAffiliateAnalyticsFromClickHouse } from "../queries/creators/analytics";
import { computeDrift, logComparison, timeCh } from "./_core";

type CreatorsAnalyticsPeriod = "today" | "7d" | "30d" | "90d" | "all";

/**
 * Fire-and-forget comparison for the /creators/analytics headline scalars
 * (Phase 2B). No-op unless the `creators_analytics` surface is in `comparison`
 * mode (which is itself forced off whenever ClickHouse is dormant). The
 * ClickHouse twin is fed the SAME excluded-users blacklist and replicates the
 * SAME 2-role referred scope + window the Postgres path uses, so logged drift
 * reflects engine / CDC-lag only, never a window or scope change.
 *
 * Three of the six compared fields are money (half-cent tolerance); the three
 * counts (`totalSignups`, `totalClicks`, `activeCreators`) must match exactly.
 * The per-day `daily` series is not part of this scalar comparison. Swallows
 * every error via `logError` so the served Postgres payload is never affected.
 */
export async function compareCreatorsAnalytics(
  period: CreatorsAnalyticsPeriod,
  pgValues: AffiliateAnalyticsData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("creators_analytics");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateAnalyticsFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(
      {
        totalSignups: pgValues.totalSignups,
        totalCommissionPaid: pgValues.totalCommissionPaid,
        totalWagerVolume: pgValues.totalWagerVolume,
        totalDepositVolume: pgValues.totalDepositVolume,
        totalClicks: pgValues.totalClicks,
        activeCreators: pgValues.activeCreators,
      },
      {
        totalSignups: ch.totalSignups,
        totalCommissionPaid: ch.totalCommissionPaid,
        totalWagerVolume: ch.totalWagerVolume,
        totalDepositVolume: ch.totalDepositVolume,
        totalClicks: ch.totalClicks,
        activeCreators: ch.activeCreators,
      },
      ["totalCommissionPaid", "totalWagerVolume", "totalDepositVolume"],
    );

    logComparison(`creators.analytics[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.creators_analytics",
      "comparison failed (ignored)",
      err,
    );
  }
}
