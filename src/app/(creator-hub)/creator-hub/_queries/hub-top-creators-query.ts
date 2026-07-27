import "server-only";

import { unstable_cache } from "next/cache";
import { readDrizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCodeAndWagerByUser } from "../../../(admin)/creators/_queries/code-and-wager-by-user";
import {
  type TopCreatorsPeriod,
  topCreatorsSinceDate,
} from "../_lib/top-creators-period";
import { getWindowedSignupsByCreatorIds } from "./hub-top-creator-meta";

export type HubTopCreator = {
  creatorUserId: string;
  username: string | null;
  image: string | null;
  code: string | null;
  signups: number;
  depositsUsd: number;
};

const TOP_CREATORS_LIMIT = 6;

type DepositRankRow = {
  creator_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
};

/**
 * The heavy "rank creators by covered deposits" leg. Anchored to a single
 * directly comparable, and routed through `resolveAdminRead` (Index-or-
 */
async function rankTopCreatorsByDeposits(
  period: TopCreatorsPeriod,
  env: DbEnv,
  excluded: string[],
  since: Date,
): Promise<DepositRankRow[]> {
  return (async () => {
      const db = readDrizzleForEnv(env);
      const blacklistAnd = blacklistNotInClause("u.id", excluded);
      return queryRows<DepositRankRow[]>(db,
        `WITH covered_deposits AS (
           SELECT DISTINCT ON (lt.id)
                  lt.amount::numeric AS amount,
                  acu.affiliate_user_id AS creator_id
             FROM ledger_transactions lt
             JOIN "user" u ON u.id = lt.user_id
             LEFT JOIN affiliate_code_usages acu
                    ON acu.referred_user_id = lt.user_id
                   AND acu.created_at <= lt.created_at
                   AND acu.created_at >= lt.created_at - INTERVAL '7 days'
                   AND acu.referred_user_id <> acu.affiliate_user_id
            WHERE lt.type = 'deposit'
              AND lt.status = 'completed'
              AND u.role NOT IN ('admin', 'support', 'creator')
              AND lt.created_at >= $1::timestamptz
              ${blacklistAnd}
            ORDER BY lt.id, acu.created_at DESC
         )
         SELECT cd.creator_id,
                c.username,
                c.image,
                COALESCE(SUM(cd.amount), 0)::text AS deposits
           FROM covered_deposits cd
           JOIN "user" c ON c.id = cd.creator_id AND c.role = 'creator'
          WHERE cd.creator_id IS NOT NULL
          GROUP BY cd.creator_id, c.username, c.image
          HAVING COALESCE(SUM(cd.amount), 0) > 0
          ORDER BY SUM(cd.amount) DESC
          LIMIT ${TOP_CREATORS_LIMIT}`,
        since.toISOString(),
      );
  })();
}

async function fetchTopCreatorsByDeposits(
  period: TopCreatorsPeriod,
  env: DbEnv,
): Promise<HubTopCreator[]> {
  const excluded = await getExcludedUserIds();
  const since = topCreatorsSinceDate(period);

  const rows = await rankTopCreatorsByDeposits(period, env, excluded, since);

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.creator_id);
  const [codeMeta, signupsMeta] = await Promise.all([
    getCodeAndWagerByUser(ids).catch((err) => {
      console.error("[creator-hub] top-creator code meta failed:", err);
      return new Map();
    }),
    getWindowedSignupsByCreatorIds(ids, period).catch((err) => {
      console.error("[creator-hub] top-creator signups meta failed:", err);
      return new Map();
    }),
  ]);

  return rows.map((r) => ({
    creatorUserId: r.creator_id,
    username: r.username,
    image: r.image,
    code: codeMeta.get(r.creator_id)?.code ?? null,
    signups: signupsMeta.get(r.creator_id) ?? 0,
    depositsUsd: toNumber(r.deposits),
  }));
}

export async function getHubTopCreatorsByDeposits(
  period: TopCreatorsPeriod,
): Promise<HubTopCreator[]> {
  return withTiming("creator-hub.topCreatorsByDeposits", async () => {
    const env = await readDbEnv();
    const excluded = await getExcludedUserIds();
    const blacklistKey =
      excluded.length > 0 ? escapeBlacklistIds(excluded) : "none";

    return unstable_cache(
      () => fetchTopCreatorsByDeposits(period, env),
      ["hub-top-creators-by-deposits-v1", period, env, blacklistKey],
      { revalidate: 60, tags: ["creator-hub"] },
    )();
  });
}
