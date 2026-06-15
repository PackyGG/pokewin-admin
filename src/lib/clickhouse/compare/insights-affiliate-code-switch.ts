import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { CodeSwitchRow } from "@/lib/queries/insights-rewards/affiliate/code-switch";

import { getAffiliateCodeSwitchFromClickHouse } from "../queries/insights-rewards/affiliate/code-switch";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Code-switch tab. No-op unless the
 * `insights_affiliate_code_switch` surface is in `comparison` mode. All fields
 * are integer counts (no money), so every one is diffed for exact equality: the
 * row count + summed cohort size + summed multi-code / switch-away counts.
 * (Top-25 membership is ranked by switch-away share and can shift on a tie; the
 * summed counts are the robust fields.) Swallows every error so the served
 * Postgres payload is never affected.
 */
function flatten(rows: CodeSwitchRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    cohortSizeSum: rows.reduce((a, r) => a + r.cohortSize, 0),
    switchersAnySum: rows.reduce((a, r) => a + r.switchersAny, 0),
    switchersAwaySum: rows.reduce((a, r) => a + r.switchersAway, 0),
  };
}

export async function compareAffiliateCodeSwitch(
  period: InsightsRewardsPeriod,
  pgValues: CodeSwitchRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_code_switch");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateCodeSwitchFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch));
    logComparison(`insights_affiliate_code_switch[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_code_switch",
      "comparison failed (ignored)",
      err,
    );
  }
}
