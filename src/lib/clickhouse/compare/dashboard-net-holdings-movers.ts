import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getTodayNetHoldingsTopHoldersFromClickHouse } from "../queries/dashboard/net-holdings-movers";
import { computeDrift, logComparison, timeCh } from "./_core";

type PgHolder = {
  userId: string;
  netHoldingsChange: number;
};

/**
 * Fire-and-forget comparison for the Dashboard "Net holdings Δ" top-movers
 * drilldown (`getTodayNetHoldingsTopHolders`). No-op unless the
 * `dashboard_net_holdings_movers` surface is in `comparison` mode (forced off
 * whenever ClickHouse is dormant). Swallows every error — the served Postgres
 * payload is never affected.
 *
 * Ranked-list comparison: the drift record is keyed BY userId (each PG holder's
 * `netHoldingsChange`, a cent-exact money field) plus an exact `count`. Keying
 * by userId — rather than by rank position — means a tie-order difference can't
 * masquerade as drift; a user present in PG's top-5 but absent from CH's
 * (top-N divergence / CDC-lag on the freshest "today" window) surfaces as that
 * user's `ch=0`. Structural row-by-row ranked parity is proven by the
 * uncommitted harness with a pinned `ABS(net) DESC, userId ASC` order.
 */
export async function compareDashboardNetHoldingsMovers(pgValues: {
  holders: PgHolder[];
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_net_holdings_movers");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getTodayNetHoldingsTopHoldersFromClickHouse(since, blacklist);
    });

    const chByUser = new Map(ch.holders.map((h) => [h.userId, h.netHoldingsChange]));
    const pgRecord: Record<string, number> = { count: pgValues.holders.length };
    const chRecord: Record<string, number> = { count: ch.holders.length };
    const moneyFields: string[] = [];
    for (const h of pgValues.holders) {
      const key = `net_${h.userId}`;
      pgRecord[key] = h.netHoldingsChange;
      chRecord[key] = chByUser.get(h.userId) ?? 0;
      moneyFields.push(key);
    }

    const drift = computeDrift(pgRecord, chRecord, moneyFields);
    logComparison("dashboard.netHoldingsMovers[top5]", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_net_holdings_movers",
      "comparison failed (ignored)",
      err,
    );
  }
}
