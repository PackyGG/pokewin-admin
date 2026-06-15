import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { TopAffiliateByWager } from "@/lib/queries/insights-rewards/affiliate/leaderboards";

import { getTopAffiliatesByWagerFromClickHouse } from "../queries/insights-rewards/affiliate/leaderboards";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Top-by-wager leaderboard. No-op
 * unless the `insights_affiliate_top_wager` surface is in `comparison` mode. The
 * summed downstream wager + commission are diffed within half a cent; the row
 * count + summed referred-user count exactly. (Top-25 membership can shift on a
 * wager tie at the cut line; the summed aggregates are the robust fields.)
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["referredWagerSum", "commissionPaidSum"] as const;

function flatten(rows: TopAffiliateByWager[]): Record<string, number> {
  return {
    rowCount: rows.length,
    referredWagerSum: rows.reduce((a, r) => a + r.referredWager, 0),
    commissionPaidSum: rows.reduce((a, r) => a + r.commissionPaid, 0),
    referredCountSum: rows.reduce((a, r) => a + r.referredCount, 0),
  };
}

export async function compareAffiliateTopWager(
  period: InsightsRewardsPeriod,
  pgValues: TopAffiliateByWager[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_top_wager");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getTopAffiliatesByWagerFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_top_wager[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_top_wager",
      "comparison failed (ignored)",
      err,
    );
  }
}
