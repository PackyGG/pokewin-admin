import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { SignupFunnel } from "@/lib/queries/insights-rewards/signup/funnel";

import { getSignupFunnelFromClickHouse } from "../queries/insights-rewards/signup/funnel";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup → repeat-wager funnel. No-op unless
 * the `insights_signup_funnel` surface is in `comparison` mode. Every stage is a
 * distinct-user count, diffed exactly. Swallows every error so the served
 * Postgres payload is never affected.
 */
export async function compareSignupFunnel(
  period: InsightsRewardsPeriod,
  pgValues: SignupFunnel,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_funnel");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupFunnelFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(
      {
        signups: pgValues.signups,
        claimed: pgValues.claimed,
        firstDeposit: pgValues.firstDeposit,
        firstWager: pgValues.firstWager,
        repeatDeposit: pgValues.repeatDeposit,
      },
      {
        signups: ch.signups,
        claimed: ch.claimed,
        firstDeposit: ch.firstDeposit,
        firstWager: ch.firstWager,
        repeatDeposit: ch.repeatDeposit,
      },
    );
    logComparison(`insights_signup_funnel[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_funnel",
      "comparison failed (ignored)",
      err,
    );
  }
}
