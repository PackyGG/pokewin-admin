import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { FunnelData, FunnelPeriod } from "@/lib/queries/analytics-funnel";

import { getFunnelDataFromClickHouse } from "../queries/analytics/funnel";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics FUNNEL tab. No-op unless the
 * `analytics_funnel` surface is in `comparison` mode (forced off when ClickHouse
 * is dormant). All six step counts must match exactly (no money fields).
 * Swallows every error — the served Postgres payload is never affected.
 */
const STEP_KEYS = [
  "clicks",
  "signups",
  "first_deposit",
  "first_wager",
  "repeat_depositor",
  "maw",
] as const;

function countsByKey(
  steps: ReadonlyArray<{ key: string; count: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of STEP_KEYS) {
    out[k] = steps.find((s) => s.key === k)?.count ?? 0;
  }
  return out;
}

export async function compareAnalyticsFunnel(
  period: FunnelPeriod,
  pg: FunnelData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_funnel");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getFunnelDataFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(countsByKey(pg.steps), countsByKey(ch.steps));
    logComparison(`analytics.funnel[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_funnel",
      "comparison failed (ignored)",
      err,
    );
  }
}
