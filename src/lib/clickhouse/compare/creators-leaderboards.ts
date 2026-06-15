import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { LeaderboardRanking } from "@/lib/queries/creators-leaderboards";

import { getAffiliateLeaderboardRankingsFromClickHouse } from "../queries/creators/leaderboards";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Phase 2B per-surface compare module — affiliate-leaderboard live standings.
 *
 * Fire-and-forget comparison for the `/creators/leaderboards/[id]` standings
 * (`getAffiliateLeaderboardRankings`). No-op unless the `creators_leaderboards`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Runs the dedicated ClickHouse twin with the SAME leaderboard opts + the SAME
 * excluded-users blacklist (so it replicates the EXACT 2-role + blacklist scope
 * the Postgres twin uses), then diffs the settled standings aggregates:
 *   • rowCount        — number of standing rows (COUNT — must match EXACTLY).
 *   • totalWageredSum — Σ totalWageredUsd over the standings (money, half-cent).
 *   • housePnlSum     — Σ housePnlUsd over the standings (money, half-cent).
 *   • prizeSum        — Σ prizeUsd over the standings (money, half-cent).
 *
 * The per-row `positionReachedAt` timestamp is NOT part of this comparison (the
 * CH twin scopes it out — it is a non-scalar-diffable per-row enrichment; see
 * the query module header). Swallows every error via `logError` so the served
 * Postgres payload is NEVER affected.
 */
export async function compareCreatorsLeaderboards(
  leaderboardId: string,
  opts: {
    creatorUserId: string;
    coCreatorUserIds?: string[];
    affiliateCodes: string[];
    startDate: Date;
    endDate: Date;
    prizeTiers: { position: number; prize_amount_usd: string }[];
    limit?: number;
  },
  pgRankings: LeaderboardRanking[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("creators_leaderboards");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateLeaderboardRankingsFromClickHouse(opts, blacklist);
    });

    const drift = computeDrift(
      aggregateStandings(pgRankings),
      aggregateStandings(ch),
      ["totalWageredSum", "housePnlSum", "prizeSum"],
    );
    logComparison(`creators.leaderboards[${leaderboardId}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.creators_leaderboards",
      "comparison failed (ignored)",
      err,
    );
  }
}

/** Flatten standings rows into the scalar record the drift primitive diffs. */
function aggregateStandings(
  rankings: LeaderboardRanking[],
): Record<string, number> {
  let totalWageredSum = 0;
  let housePnlSum = 0;
  let prizeSum = 0;
  for (const r of rankings) {
    totalWageredSum += r.totalWageredUsd;
    housePnlSum += r.housePnlUsd;
    prizeSum += r.prizeUsd ?? 0;
  }
  return {
    rowCount: rankings.length,
    totalWageredSum,
    housePnlSum,
    prizeSum,
  };
}
