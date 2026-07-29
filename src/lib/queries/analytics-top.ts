import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { realCustomersScopeSql } from "./insights-games/_shared";

/** Periods supported by the active top-depositors leaderboard. */
export type LeaderboardPeriod = "7d" | "30d" | "all";

export type UserLeaderRow = {
  userId: string;
  username: string | null;
  image: string | null;
  amount: number;
};

const LIFETIME_LOOKBACK_DAYS = 365;
const LIMIT = 20;

function daysForPeriod(period: LeaderboardPeriod): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

async function computeTopDepositors(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<UserLeaderRow[]> {
  void _blacklistKey;
  const db = await getReadDrizzleDb();
  const scope = await realCustomersScopeSql();
  const days = daysForPeriod(period);
  const rows = await queryRows<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
    }[]
  >(db, `
    SELECT u.id, u.username, u.image, SUM(ABS(lt.amount::numeric))::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type::text = 'deposit'
      AND lt.user_id IN ${scope}
      AND lt.created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY u.id, u.username, u.image
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((row) => ({
    userId: row.id,
    username: row.username,
    image: row.image,
    amount: toNumber(row.amount),
  }));
}

const cachedTopDepositors = unstable_cache(
  computeTopDepositors,
  ["analytics-top-depositors-v1"],
  { revalidate: 60, tags: ["analytics"] },
);
const cachedLifetimeTopDepositors = unstable_cache(
  computeTopDepositors,
  ["analytics-top-depositors-lifetime-v1"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getTopDepositors(
  period: LeaderboardPeriod,
): Promise<UserLeaderRow[]> {
  const blacklist = [...(await getExcludedUserIds())].sort();
  return period === "all"
    ? cachedLifetimeTopDepositors(period, blacklist)
    : cachedTopDepositors(period, blacklist);
}
