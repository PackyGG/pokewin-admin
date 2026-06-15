import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getCodeAnalyticsFromClickHouse } from "../queries/creators/code-analytics";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Phase 2B per-surface compare module — creator code-analytics KPIs.
 *
 * Fire-and-forget comparison for the `/creators/codes/[code]` per-code aggregate
 * (`getCodeAnalytics`). No-op unless the `creators_code_analytics` surface is in
 * `comparison` mode (forced off whenever ClickHouse is dormant). Runs the
 * dedicated ClickHouse twin with the SAME code, diffs the settled scalar KPIs
 * against the Postgres values (money fields within half a cent; counts exact),
 * logs drift, and swallows every error via `logError` — the served Postgres
 * payload is NEVER affected.
 *
 * NO blacklist / role scope is fetched or applied: the PG twin `getCodeAnalytics`
 * applies none (it is a per-code aggregate over the whole referred population),
 * so the CH twin mirrors that exactly (see the query module header).
 */
export async function compareCreatorCodeAnalytics(
  code: string,
  pgValues: {
    totalReferrals: number;
    activeReferrals: number;
    totalDeposits: number;
    codeDepositTotal: number;
    codeDepositEventCount: number;
    codeUniqueDepositors: number;
    totalWagers: number;
    totalCommission: number;
    totalClicks: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("creators_code_analytics");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () =>
      getCodeAnalyticsFromClickHouse(code),
    );

    const pgRecord = {
      totalReferrals: pgValues.totalReferrals,
      activeReferrals: pgValues.activeReferrals,
      totalDeposits: pgValues.totalDeposits,
      codeDepositTotal: pgValues.codeDepositTotal,
      codeDepositEventCount: pgValues.codeDepositEventCount,
      codeUniqueDepositors: pgValues.codeUniqueDepositors,
      totalWagers: pgValues.totalWagers,
      totalCommission: pgValues.totalCommission,
      totalClicks: pgValues.totalClicks,
    };
    // A null CH record means the code is absent from the mirror (CDC lag /
    // missing owner row) while Postgres found it — surface that as drift via a
    // zeroed CH record + a labelled line rather than silently skipping.
    const chRecord = ch
      ? {
          totalReferrals: ch.totalReferrals,
          activeReferrals: ch.activeReferrals,
          totalDeposits: ch.totalDeposits,
          codeDepositTotal: ch.codeDepositTotal,
          codeDepositEventCount: ch.codeDepositEventCount,
          codeUniqueDepositors: ch.codeUniqueDepositors,
          totalWagers: ch.totalWagers,
          totalCommission: ch.totalCommission,
          totalClicks: ch.totalClicks,
        }
      : {
          totalReferrals: 0,
          activeReferrals: 0,
          totalDeposits: 0,
          codeDepositTotal: 0,
          codeDepositEventCount: 0,
          codeUniqueDepositors: 0,
          totalWagers: 0,
          totalCommission: 0,
          totalClicks: 0,
        };

    const drift = computeDrift(pgRecord, chRecord, [
      "totalDeposits",
      "codeDepositTotal",
      "totalWagers",
      "totalCommission",
    ]);
    const label = ch
      ? `creators.codeAnalytics[${code}]`
      : `creators.codeAnalytics[${code}] (ch-missing)`;
    logComparison(label, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.creators_code_analytics",
      "comparison failed (ignored)",
      err,
    );
  }
}
