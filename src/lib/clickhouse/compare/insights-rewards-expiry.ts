import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackExpiryData,
  RakebackForfeited,
} from "@/lib/queries/insights-rewards/expiry";

import { getRakebackExpiryFromClickHouse } from "../queries/insights-rewards/expiry";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /insights/rewards/expiry surface
 * (rakeback-scoped MVP). No-op unless the `insights_rewards_expiry` surface is
 * in `comparison` mode (forced off whenever ClickHouse is dormant). Diffs the
 * "forfeited by lapsing" aggregate — the only numeric part of the page — money
 * within half a cent, counts exact. Swallows every error so the served Postgres
 * payload is never affected.
 *
 * The lifetime (`all`) window has no prior frame → `forfeited = null` on both
 * engines, so there is nothing to compare and the call no-ops.
 */
const MONEY_FIELDS = [
  "totalForfeitedValue",
  "dailyForfeited",
  "weeklyForfeited",
  "monthlyForfeited",
] as const;

function flattenForfeited(f: RakebackForfeited): Record<string, number> {
  const rec: Record<string, number> = {
    totalLapsedUsers: f.totalLapsedUsers,
    totalForfeitedValue: f.totalForfeitedValue,
  };
  for (const type of ["daily", "weekly", "monthly"] as const) {
    const row = f.byType.find((b) => b.type === type);
    rec[`${type}Forfeited`] = row?.forfeitedValue ?? 0;
    rec[`${type}Claims`] = row?.lapsedClaims ?? 0;
  }
  return rec;
}

export async function compareRewardsExpiry(
  period: InsightsRewardsPeriod,
  pgValues: RakebackExpiryData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_rewards_expiry");
    if (mode !== "comparison") return;

    // Lifetime / null-forfeited windows have no numeric cohort to diff.
    if (pgValues.forfeited == null) return;
    const pgForfeited = pgValues.forfeited;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRakebackExpiryFromClickHouse(period, blacklist, now);
    });

    if (ch.forfeited == null) return;

    const drift = computeDrift(
      flattenForfeited(pgForfeited),
      flattenForfeited(ch.forfeited),
      MONEY_FIELDS,
    );
    logComparison(`insights_rewards_expiry[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_rewards_expiry",
      "comparison failed (ignored)",
      err,
    );
  }
}
