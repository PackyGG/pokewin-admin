import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackTopClaimer,
  RakebackTopClaimerScope,
} from "@/lib/queries/insights-rewards/rakeback/top-claimers";

import { getRakebackTopClaimersFromClickHouse } from "../queries/insights-rewards/rakeback/top-claimers";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback Top-claimers tab. No-op unless
 * the `insights_rakeback_top` surface is in `comparison` mode. Diffs the
 * leaderboard aggregate — the summed rakeback + summed lifetime rakeback within
 * half a cent, the row count + summed claim count exactly. (The aggregate is
 * stable whenever the top-25 sums are distinct; a tie straddling the 25th slot
 * is the only edge that can perturb the row set — see the query twin note.)
 * The SAME scope the PG path used is forwarded. Swallows every error so the
 * served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["totalRakebackSum", "lifetimeRakebackSum"] as const;

function flatten(rows: RakebackTopClaimer[]): Record<string, number> {
  return {
    rowCount: rows.length,
    totalRakebackSum: rows.reduce((a, r) => a + r.totalRakeback, 0),
    claimCountSum: rows.reduce((a, r) => a + r.claimCount, 0),
    lifetimeRakebackSum: rows.reduce((a, r) => a + r.lifetimeRakeback, 0),
  };
}

export async function compareRakebackTop(
  period: InsightsRewardsPeriod,
  scope: RakebackTopClaimerScope,
  pgValues: RakebackTopClaimer[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_top");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackTopClaimersFromClickHouse(period, scope, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(
      `insights_rakeback_top[${period}:${scope}]`,
      drift,
      durationMs,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_top",
      "comparison failed (ignored)",
      err,
    );
  }
}
