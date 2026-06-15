import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { getDepositBonusCapHitRateFromClickHouse } from "../queries/insights-rewards/deposit-bonus/cap-hit-rate";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the deposit-bonus cap-hit-rate KPI. No-op
 * unless the `insights_deposit_bonus_cap_hit_rate` surface is in `comparison`
 * mode. Swallows every error — the served Postgres payload is never affected.
 */
export async function compareDepositBonusCapHitRate(
  period: InsightsRewardsPeriod,
  pgValues: {
    capValue: number;
    capHits: number;
    totalCount: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_cap_hit_rate");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusCapHitRateFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(
      {
        capValue: pgValues.capValue,
        capHits: pgValues.capHits,
        totalCount: pgValues.totalCount,
      },
      {
        capValue: ch.capValue,
        capHits: ch.capHits,
        totalCount: ch.totalCount,
      },
      ["capValue"],
    );
    logComparison(
      `insights.deposit_bonus.cap_hit_rate[${period}]`,
      drift,
      durationMs,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.insights_deposit_bonus_cap_hit_rate",
      "comparison failed (ignored)",
      err,
    );
  }
}
