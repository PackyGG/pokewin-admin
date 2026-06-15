import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import {
  getPackBattlePurePnlFromClickHouse,
  type PackBattlePnlRowCh,
  type PackBattlePnlWindowsCh,
} from "../queries/analytics/pure-pnl";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics?tab=pure-pnl "Pack & Battle
 * Pure P&L" panel (`getPackBattlePurePnl`). No-op unless the `pure_pnl` surface
 * is in `comparison` mode (forced `off` whenever ClickHouse is dormant). Runs
 * the ClickHouse twin, diffs each window's money fields (within half a cent),
 * logs drift, and swallows every error — the served Postgres payload is never
 * affected.
 *
 * Every field on each window is money (wager / payouts / pnl), so all are
 * passed to `computeDrift` as money fields.
 */
const MONEY_FIELDS = [
  "packWager",
  "packPayouts",
  "packPnl",
  "battleWager",
  "battlePayouts",
  "battlePnl",
  "totalWager",
  "totalPayouts",
  "totalPnl",
] as const;

function toRecord(row: PackBattlePnlRowCh): Record<string, number> {
  return {
    packWager: row.packWager,
    packPayouts: row.packPayouts,
    packPnl: row.packPnl,
    battleWager: row.battleWager,
    battlePayouts: row.battlePayouts,
    battlePnl: row.battlePnl,
    totalWager: row.totalWager,
    totalPayouts: row.totalPayouts,
    totalPnl: row.totalPnl,
  };
}

export async function comparePurePnl(
  pgWindows: PackBattlePnlWindowsCh,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("pure_pnl");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getPackBattlePurePnlFromClickHouse(blacklist);
    });

    const windows = ["h24", "d3", "d7", "all"] as const;
    for (const w of windows) {
      const drift = computeDrift(
        toRecord(pgWindows[w]),
        toRecord(ch[w]),
        MONEY_FIELDS,
      );
      logComparison(`analytics.purePnl[${w}]`, drift, durationMs);
    }
  } catch (err) {
    logError("clickhouse.compare.pure_pnl", "comparison failed (ignored)", err);
  }
}
