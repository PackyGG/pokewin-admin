import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { SignupTopRecipientRow } from "@/lib/queries/insights-rewards/signup/top-recipients";

import { getSignupTopRecipientsFromClickHouse } from "../queries/insights-rewards/signup/top-recipients";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup top-25 recipients leaderboard. No-op
 * unless the `insights_signup_top_recipients` surface is in `comparison` mode.
 * Diffs the leaderboard aggregate — Σ claim volume + Σ deposit total within half
 * a cent; row count + Σ claim count exactly. (See the twin's top-N tie note; the
 * parity harness pins the tie-break on both sides.) Swallows every error so the
 * served Postgres payload is never affected.
 */
const MONEY_FIELDS = ["claimVolumeSum", "depositTotalSum"] as const;

export async function compareSignupTopRecipients(
  period: InsightsRewardsPeriod,
  pgValues: SignupTopRecipientRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_top_recipients");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupTopRecipientsFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        rowCount: pgValues.length,
        claimVolumeSum: pgValues.reduce((a, r) => a + r.claimVolume, 0),
        claimCountSum: pgValues.reduce((a, r) => a + r.claimCount, 0),
        depositTotalSum: pgValues.reduce((a, r) => a + r.depositTotal, 0),
      },
      {
        rowCount: ch.rowCount,
        claimVolumeSum: ch.claimVolumeSum,
        claimCountSum: ch.claimCountSum,
        depositTotalSum: ch.depositTotalSum,
      },
      MONEY_FIELDS,
    );
    logComparison(`insights_signup_top_recipients[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_top_recipients",
      "comparison failed (ignored)",
      err,
    );
  }
}
