import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { RakebackLapsed } from "@/lib/queries/insights-rewards/rakeback/lapsed";

import { getRakebackLapsedFromClickHouse } from "../queries/insights-rewards/rakeback/lapsed";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the rakeback Lapsed-claimants tab. No-op
 * unless the `insights_rakeback_lapsed` surface is in `comparison` mode. The
 * lapsed-user count + the three reason-class counts must match exactly; the
 * total lost rakeback is diffed within half a cent. Lifetime (`all`) has no
 * prior frame → both engines return null and the call no-ops. Swallows every
 * error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["totalLostRakeback"] as const;

function flatten(d: RakebackLapsed): Record<string, number> {
  return {
    totalLapsedUsers: d.totalLapsedUsers,
    totalLostRakeback: d.totalLostRakeback,
    churned: d.reasons.churned,
    lessActive: d.reasons.lessActive,
    stillActive: d.reasons.stillActive,
  };
}

export async function compareRakebackLapsed(
  period: InsightsRewardsPeriod,
  pgValues: RakebackLapsed | null,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rakeback_lapsed");
    if (mode !== "comparison") return;
    if (pgValues == null) return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackLapsedFromClickHouse(period, blacklist, now);
    });
    if (ch == null) return;

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_rakeback_lapsed[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rakeback_lapsed",
      "comparison failed (ignored)",
      err,
    );
  }
}
