import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { WithdrawnCoinsData } from "@/lib/queries/analytics-withdrawals";

import { getWithdrawnCoinsBreakdownFromClickHouse } from "../queries/analytics/withdrawals";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics → Revenue tab "Withdrawn coins"
 * card (`getWithdrawnCoinsBreakdown`). No-op unless the
 * `analytics_revenue_withdrawals` surface is in `comparison` mode. Diffs the
 * physical bucket (USD + count), the crypto total, and each crypto asset's USD /
 * count / native amount within half a cent. Swallows every error so the served
 * Postgres payload is never affected.
 */

const SURFACE = "analytics_revenue_withdrawals";

function flatten(d: WithdrawnCoinsData): {
  record: Record<string, number>;
  moneyKeys: string[];
} {
  const record: Record<string, number> = {
    totalCryptoUsd: d.totalCryptoUsd,
    physicalUsd: d.physicalUsd,
    physicalCount: d.physicalCount,
    assetCount: d.assets.length,
  };
  const moneyKeys = ["totalCryptoUsd", "physicalUsd"];
  for (const a of d.assets) {
    record[`asset:${a.asset}:usd`] = a.totalUsd;
    record[`asset:${a.asset}:count`] = a.count;
    record[`asset:${a.asset}:crypto`] = a.totalCryptoAmount;
    moneyKeys.push(`asset:${a.asset}:usd`);
  }
  return { record, moneyKeys };
}

export async function compareWithdrawals(
  pgData: WithdrawnCoinsData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode(SURFACE);
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getWithdrawnCoinsBreakdownFromClickHouse(pgData.period, blacklist);
    });

    // Key the diff off the PG payload (the served truth); CH-only assets would
    // surface as a row-count mismatch via assetCount.
    const pg = flatten(pgData);
    const chFlat = flatten(ch);
    const drift = computeDrift(pg.record, chFlat.record, pg.moneyKeys);
    logComparison(`${SURFACE}[${pgData.period}]`, drift, durationMs);
  } catch (err) {
    logError(`clickhouse.compare.${SURFACE}`, "comparison failed (ignored)", err);
  }
}
