import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import { getDepositBonusRoiFromClickHouse } from "../queries/insights-rewards/deposit-bonus/roi";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the deposit-bonus ROI lens. No-op unless the
 * `insights_deposit_bonus_roi` surface is in `comparison` mode. Swallows every
 * error — the served Postgres payload is never affected. `lookbackDays`
 * mirrors the PG default (14) so the forward window is identical.
 */
export async function compareDepositBonusRoi(
  period: InsightsRewardsPeriod,
  pgValues: {
    cost: number;
    claimants: number;
    wager: number;
    payouts: number;
    subsequentGgr: number;
  },
  lookbackDays = 14,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_deposit_bonus_roi");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDepositBonusRoiFromClickHouse(period, lookbackDays, blacklist);
    });

    const drift = computeDrift(
      {
        cost: pgValues.cost,
        claimants: pgValues.claimants,
        wager: pgValues.wager,
        payouts: pgValues.payouts,
        subsequentGgr: pgValues.subsequentGgr,
      },
      {
        cost: ch.cost,
        claimants: ch.claimants,
        wager: ch.wager,
        payouts: ch.payouts,
        subsequentGgr: ch.subsequentGgr,
      },
      ["cost", "wager", "payouts", "subsequentGgr"],
    );
    logComparison(`insights.deposit_bonus.roi[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_deposit_bonus_roi",
      "comparison failed (ignored)",
      err,
    );
  }
}
