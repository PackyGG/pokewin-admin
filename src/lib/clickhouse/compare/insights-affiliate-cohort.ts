import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { AffiliateCohortRow } from "@/lib/queries/insights-rewards/affiliate/cohort";

import { getAffiliateCohortFromClickHouse } from "../queries/insights-rewards/affiliate/cohort";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Cohort tab. No-op unless the
 * `insights_affiliate_cohort` surface is in `comparison` mode. The summed cohort
 * wager + summed avg-first-deposit are diffed within half a cent; the row count
 * + summed referred / depositor / repeat counts exactly. (Top-15 membership can
 * shift on a wager tie; the summed aggregates are the robust fields.) Swallows
 * every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["cohortWagerSum", "avgFirstDepositSum"] as const;

function flatten(rows: AffiliateCohortRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    referredActiveSum: rows.reduce((a, r) => a + r.referredActive, 0),
    cohortWagerSum: rows.reduce((a, r) => a + r.cohortWager, 0),
    depositorsSum: rows.reduce((a, r) => a + r.depositors, 0),
    repeatDepositorsSum: rows.reduce((a, r) => a + r.repeatDepositors, 0),
    avgFirstDepositSum: rows.reduce((a, r) => a + r.avgFirstDepositUsd, 0),
  };
}

export async function compareAffiliateCohort(
  period: InsightsRewardsPeriod,
  pgValues: AffiliateCohortRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_cohort");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateCohortFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_cohort[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_cohort",
      "comparison failed (ignored)",
      err,
    );
  }
}
