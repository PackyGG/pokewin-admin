import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

import { getCreatorDetailAggregatesFromClickHouse } from "../queries/creators-detail/aggregates";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Phase 2B per-surface compare module — /creators/[userId] detail-page
 * aggregates (`getCreatorDetail`).
 *
 * Fire-and-forget comparison: no-op unless the `creators_detail_aggregates`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Fetches the SAME excluded-users blacklist the PG path uses, runs the dedicated
 * ClickHouse twin for the SAME creator, diffs the settled scalar fields (money
 * within half a cent; counts exact), logs drift, and swallows every error via
 * `logError` — the served Postgres payload is NEVER affected.
 *
 * The blacklist applies only to the realAffiliateAgg leg in the twin (mirroring
 * PG); the signups / clicks / ftdByPeriod / account / pending legs carry no
 * blacklist there, exactly as Postgres.
 */
export async function compareCreatorsDetailAggregates(
  userId: string,
  pgValues: {
    clicks: { total: number; last24h: number; last7d: number; last14d: number; last30d: number };
    signups: {
      total: number;
      last24h: number;
      last7d: number;
      last14d: number;
      last30d: number;
      pending: number;
    };
    totalWagerVolumeUsd: number;
    wagerBreakdown: { packs: number; battles: number; upgrader: number };
    totalEarnedUsd: number;
    ftdCount: number;
    activeReferrals7d: number;
    activeReferrals24h: number;
    availableUsd: number;
    totalPaidOutUsd: number;
    totalBonusDistributedUsd: number;
    ftdByPeriod: Record<string, number>;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("creators_detail_aggregates");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getCreatorDetailAggregatesFromClickHouse(userId, blacklist);
    });

    const pgRecord: Record<string, number> = {
      clicksTotal: pgValues.clicks.total,
      clicks24h: pgValues.clicks.last24h,
      clicks7d: pgValues.clicks.last7d,
      clicks14d: pgValues.clicks.last14d,
      clicks30d: pgValues.clicks.last30d,
      signupsTotal: pgValues.signups.total,
      signups24h: pgValues.signups.last24h,
      signups7d: pgValues.signups.last7d,
      signups14d: pgValues.signups.last14d,
      signups30d: pgValues.signups.last30d,
      signupsPending: pgValues.signups.pending,
      totalWagerVolumeUsd: pgValues.totalWagerVolumeUsd,
      wagerPacks: pgValues.wagerBreakdown.packs,
      wagerBattles: pgValues.wagerBreakdown.battles,
      wagerUpgrader: pgValues.wagerBreakdown.upgrader,
      totalEarnedUsd: pgValues.totalEarnedUsd,
      ftdCount: pgValues.ftdCount,
      activeReferrals7d: pgValues.activeReferrals7d,
      activeReferrals24h: pgValues.activeReferrals24h,
      availableUsd: pgValues.availableUsd,
      totalPaidOutUsd: pgValues.totalPaidOutUsd,
      totalBonusDistributedUsd: pgValues.totalBonusDistributedUsd,
      ftd1d: pgValues.ftdByPeriod["1d"] ?? 0,
      ftd3d: pgValues.ftdByPeriod["3d"] ?? 0,
      ftd7d: pgValues.ftdByPeriod["7d"] ?? 0,
      ftd14d: pgValues.ftdByPeriod["14d"] ?? 0,
      ftd30d: pgValues.ftdByPeriod["30d"] ?? 0,
      ftdAll: pgValues.ftdByPeriod["all"] ?? 0,
    };

    const chRecord: Record<string, number> = {
      clicksTotal: ch.clicksTotal,
      clicks24h: ch.clicks24h,
      clicks7d: ch.clicks7d,
      clicks14d: ch.clicks14d,
      clicks30d: ch.clicks30d,
      signupsTotal: ch.signupsTotal,
      signups24h: ch.signups24h,
      signups7d: ch.signups7d,
      signups14d: ch.signups14d,
      signups30d: ch.signups30d,
      signupsPending: ch.signupsPending,
      totalWagerVolumeUsd: ch.totalWagerVolumeUsd,
      wagerPacks: ch.wagerPacks,
      wagerBattles: ch.wagerBattles,
      wagerUpgrader: ch.wagerUpgrader,
      totalEarnedUsd: ch.totalEarnedUsd,
      ftdCount: ch.ftdCount,
      activeReferrals7d: ch.activeReferrals7d,
      activeReferrals24h: ch.activeReferrals24h,
      availableUsd: ch.availableUsd,
      totalPaidOutUsd: ch.totalPaidOutUsd,
      totalBonusDistributedUsd: ch.totalBonusDistributedUsd,
      ftd1d: ch.ftd1d,
      ftd3d: ch.ftd3d,
      ftd7d: ch.ftd7d,
      ftd14d: ch.ftd14d,
      ftd30d: ch.ftd30d,
      ftdAll: ch.ftdAll,
    };

    const drift = computeDrift(pgRecord, chRecord, [
      "totalWagerVolumeUsd",
      "wagerPacks",
      "wagerBattles",
      "wagerUpgrader",
      "totalEarnedUsd",
      "availableUsd",
      "totalPaidOutUsd",
      "totalBonusDistributedUsd",
    ]);
    logComparison(`creators.detailAggregates[${userId}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.creators_detail_aggregates",
      "comparison failed (ignored)",
      err,
    );
  }
}
