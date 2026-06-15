import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

import { getCreatorPnlHeadlineFromClickHouse } from "../queries/creators-detail/pnl";
import { computeDrift, logComparison, timeCh } from "./_core";
import type { CreatorPnlData } from "@/lib/queries/creators-types";

const PERIOD_KEYS = ["24h", "3d", "7d", "14d", "30d"] as const;

/**
 * Phase 2B per-surface compare module — /creators/[userId] House P&L HEADLINE
 * aggregates (`getCreatorPnl`).
 *
 * Fire-and-forget comparison: no-op unless the `creators_detail_pnl` surface is
 * in `comparison` mode (forced off whenever ClickHouse is dormant). Fetches the
 * SAME excluded-users blacklist the PG path uses, runs the dedicated ClickHouse
 * twin for the SAME creator, diffs the per-window + lifetime money totals
 * (deposits / wagered / cardWithdrawals / pnl, all within half a cent), logs
 * drift, and swallows every error via `logError` — the served Postgres payload
 * is NEVER affected.
 *
 * Only the scalar HEADLINE totals are compared; the per-user popover ROWS
 * (`byPeriod[].users`) are a per-row list, not scalar-diffable, so they are not
 * part of this comparison snapshot.
 */
export async function compareCreatorsDetailPnl(
  userId: string,
  pgValues: CreatorPnlData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("creators_detail_pnl");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getCreatorPnlHeadlineFromClickHouse(userId, blacklist);
    });

    const pgByPeriod = new Map(pgValues.byPeriod.map((p) => [p.period, p]));

    const pgRecord: Record<string, number> = {};
    const chRecord: Record<string, number> = {};
    const moneyFields: string[] = [];

    for (const key of PERIOD_KEYS) {
      const pg = pgByPeriod.get(key);
      const c = ch.byPeriod[key];
      pgRecord[`dep_${key}`] = pg?.deposits ?? 0;
      pgRecord[`wag_${key}`] = pg?.wagered ?? 0;
      pgRecord[`cwd_${key}`] = pg?.cardWithdrawals ?? 0;
      pgRecord[`pnl_${key}`] = pg?.pnl ?? 0;
      chRecord[`dep_${key}`] = c.deposits;
      chRecord[`wag_${key}`] = c.wagered;
      chRecord[`cwd_${key}`] = c.cardWithdrawals;
      chRecord[`pnl_${key}`] = c.pnl;
      moneyFields.push(`dep_${key}`, `wag_${key}`, `cwd_${key}`, `pnl_${key}`);
    }

    pgRecord.dep_lifetime = pgValues.lifetime.totalDeposits;
    pgRecord.wag_lifetime = pgValues.lifetime.totalWagered;
    pgRecord.cwd_lifetime = pgValues.lifetime.totalCardWithdrawals;
    pgRecord.pnl_lifetime = pgValues.lifetime.pnl;
    chRecord.dep_lifetime = ch.lifetime.totalDeposits;
    chRecord.wag_lifetime = ch.lifetime.totalWagered;
    chRecord.cwd_lifetime = ch.lifetime.totalCardWithdrawals;
    chRecord.pnl_lifetime = ch.lifetime.pnl;
    moneyFields.push("dep_lifetime", "wag_lifetime", "cwd_lifetime", "pnl_lifetime");

    const drift = computeDrift(pgRecord, chRecord, moneyFields);
    logComparison(`creators.detailPnl[${userId}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.creators_detail_pnl",
      "comparison failed (ignored)",
      err,
    );
  }
}
