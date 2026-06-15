import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getAffiliateReferredPnlTodayFromClickHouse } from "../queries/dashboard/affiliate-referred-pnl-today";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "affiliate-referred players"
 * P&L corner badge (`getAffiliateReferredPnlToday`). No-op unless the
 * `dashboard_affiliate_referred_pnl_today` surface is in `comparison` mode
 * (forced off whenever ClickHouse is dormant). Swallows every error — the
 * served Postgres payload is never affected.
 *
 * The PG box only surfaces `pnl`; the CH twin computes the full 5-term
 * windowed P&L for the SAME window start (today 00:00 UTC, `dayStartIso`) +
 * blacklist, and this hook diffs the `pnl` figure (cent-exact money field).
 */
export async function compareDashboardAffiliateReferredPnlToday(pgValues: {
  pnl: number;
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_affiliate_referred_pnl_today");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateReferredPnlTodayFromClickHouse(since, blacklist);
    });
    const drift = computeDrift({ pnl: pgValues.pnl }, { pnl: ch.pnl }, ["pnl"]);
    logComparison("dashboard.affiliateReferredPnlToday", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_affiliate_referred_pnl_today",
      "comparison failed (ignored)",
      err,
    );
  }
}
