import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { FirstDepositCohort } from "@/lib/queries/insights-rewards/signup/first-deposit";

import { getSignupFirstDepositFromClickHouse } from "../queries/insights-rewards/signup/first-deposit";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the signup first-deposit cohort tab. No-op
 * unless the `insights_signup_first_deposit` surface is in `comparison` mode.
 * Diffs the claimer / non-claimer first-deposit totals within half a cent, and
 * the user + amount-band counts exactly. (Avg + median are derived / interpolated
 * and out of scope.) Swallows every error so the served Postgres payload is never
 * affected.
 */
const MONEY_FIELDS = ["claimerTotal", "nonClaimerTotal"] as const;

function pgFlatten(d: FirstDepositCohort): Record<string, number> {
  const rec: Record<string, number> = {
    claimerUsers: d.claimers.users,
    claimerTotal: d.claimers.total,
    nonClaimerUsers: d.nonClaimers.users,
    nonClaimerTotal: d.nonClaimers.total,
  };
  d.buckets.forEach((b, i) => {
    rec[`c${i}`] = b.claimerCount;
    rec[`n${i}`] = b.nonClaimerCount;
  });
  return rec;
}

export async function compareSignupFirstDeposit(
  period: InsightsRewardsPeriod,
  pgValues: FirstDepositCohort,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_signup_first_deposit");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getSignupFirstDepositFromClickHouse(period, blacklist, now);
    });

    const chRec: Record<string, number> = {
      claimerUsers: ch.claimerUsers,
      claimerTotal: ch.claimerTotal,
      nonClaimerUsers: ch.nonClaimerUsers,
      nonClaimerTotal: ch.nonClaimerTotal,
    };
    ch.bucketClaimer.forEach((v, i) => (chRec[`c${i}`] = v));
    ch.bucketNonClaimer.forEach((v, i) => (chRec[`n${i}`] = v));

    const drift = computeDrift(pgFlatten(pgValues), chRec, MONEY_FIELDS);
    logComparison(`insights_signup_first_deposit[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_signup_first_deposit",
      "comparison failed (ignored)",
      err,
    );
  }
}
