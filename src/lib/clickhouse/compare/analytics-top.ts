import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  LeaderboardPeriod,
  UserLeaderRow,
  CreatorLeaderRow,
  CountryLeaderRow,
} from "@/lib/queries/analytics-top";

import {
  getTopDepositorsFromClickHouse,
  getTopWagerersFromClickHouse,
  getTopLosersFromClickHouse,
  getTopWinnersFromClickHouse,
  getTopCreatorsByVolumeFromClickHouse,
  getTopCountriesFromClickHouse,
} from "../queries/analytics/top";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparisons for the /analytics → Top-performers leaderboards.
 * One compare per board; all gate on the `analytics_top` surface flag (no-op
 * unless `comparison` mode, forced `off` while ClickHouse is dormant). Each diffs
 * the deterministic board aggregate — row count exactly, Σ amount + the #1 row's
 * amount within half a cent. The exact per-row set+order is verified in the
 * uncommitted parity script (a top-N over a `>500`-candidate population is the
 * lone caveat — see queries/analytics/top.ts §5c note). Every error is swallowed
 * so the served Postgres payload is never affected.
 */

const SURFACE = "analytics_top";

function userBoard(rows: UserLeaderRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    amountSum: rows.reduce((a, r) => a + r.amount, 0),
    topAmount: rows[0]?.amount ?? 0,
  };
}
const USER_MONEY = ["amountSum", "topAmount"] as const;

async function compareUserBoard(
  label: string,
  pgRows: UserLeaderRow[],
  chFn: () => Promise<UserLeaderRow[]>,
): Promise<void> {
  try {
    const mode = await getAdminReadMode(SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(chFn);
    const drift = computeDrift(userBoard(pgRows), userBoard(ch), USER_MONEY);
    logComparison(label, drift, durationMs);
  } catch (err) {
    logError(`clickhouse.compare.${SURFACE}`, "comparison failed (ignored)", err);
  }
}

export async function compareTopDepositors(
  period: LeaderboardPeriod,
  pgRows: UserLeaderRow[],
): Promise<void> {
  await compareUserBoard(
    `analytics_top.depositors[${period}]`,
    pgRows,
    async () => {
      const blacklist = await getExcludedUserIds();
      return getTopDepositorsFromClickHouse(period, blacklist);
    },
  );
}

export async function compareTopWagerers(
  period: LeaderboardPeriod,
  pgRows: UserLeaderRow[],
): Promise<void> {
  await compareUserBoard(
    `analytics_top.wagerers[${period}]`,
    pgRows,
    async () => {
      const blacklist = await getExcludedUserIds();
      return getTopWagerersFromClickHouse(period, blacklist);
    },
  );
}

export async function compareTopLosers(
  period: LeaderboardPeriod,
  pgRows: UserLeaderRow[],
): Promise<void> {
  await compareUserBoard(
    `analytics_top.losers[${period}]`,
    pgRows,
    async () => {
      const blacklist = await getExcludedUserIds();
      return getTopLosersFromClickHouse(period, blacklist);
    },
  );
}

export async function compareTopWinners(
  period: LeaderboardPeriod,
  pgRows: UserLeaderRow[],
): Promise<void> {
  await compareUserBoard(
    `analytics_top.winners[${period}]`,
    pgRows,
    async () => {
      const blacklist = await getExcludedUserIds();
      return getTopWinnersFromClickHouse(period, blacklist);
    },
  );
}

export async function compareTopCreators(
  period: LeaderboardPeriod,
  pgRows: CreatorLeaderRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode(SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(() =>
      getTopCreatorsByVolumeFromClickHouse(period),
    );
    const flatten = (rows: CreatorLeaderRow[]): Record<string, number> => ({
      rowCount: rows.length,
      wagerVolumeSum: rows.reduce((a, r) => a + r.wagerVolume, 0),
      commissionSum: rows.reduce((a, r) => a + r.commission, 0),
      topWagerVolume: rows[0]?.wagerVolume ?? 0,
    });
    const drift = computeDrift(flatten(pgRows), flatten(ch), [
      "wagerVolumeSum",
      "commissionSum",
      "topWagerVolume",
    ]);
    logComparison(`analytics_top.creators[${period}]`, drift, durationMs);
  } catch (err) {
    logError(`clickhouse.compare.${SURFACE}`, "comparison failed (ignored)", err);
  }
}

export async function compareTopCountries(
  period: LeaderboardPeriod,
  pgRows: CountryLeaderRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode(SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getTopCountriesFromClickHouse(period, blacklist);
    });
    const flatten = (rows: CountryLeaderRow[]): Record<string, number> => ({
      rowCount: rows.length,
      ggrSum: rows.reduce((a, r) => a + r.ggr, 0),
      usersSum: rows.reduce((a, r) => a + r.users, 0),
      topGgr: rows[0]?.ggr ?? 0,
    });
    const drift = computeDrift(flatten(pgRows), flatten(ch), ["ggrSum", "topGgr"]);
    logComparison(`analytics_top.countries[${period}]`, drift, durationMs);
  } catch (err) {
    logError(`clickhouse.compare.${SURFACE}`, "comparison failed (ignored)", err);
  }
}
