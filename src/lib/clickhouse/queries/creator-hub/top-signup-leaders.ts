import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "@/lib/clickhouse/queries/_shared";

/**
 * Creator-Hub top sign-up leaders — ClickHouse twin of `fetchTopSignupLeaders`
 * in
 * src/app/(creator-hub)/creator-hub/_queries/hub-top-creator-meta.ts.
 *
 * Top creators by referred sign-ups in the active window: a real user (role
 * NOT IN admin/support/creator, minus blacklist) counts toward the creator who
 * referred them (`referred_by`). The PG query groups by (referred_by, username)
 * — username is functionally determined by referred_by (= creator id), so
 * grouping by the id alone with `any(username)` is identical.
 */

type HubSignupLeaderRow = {
  creator_id: string;
  username: string | null;
  value: string;
};

export async function getTopSignupLeadersFromClickHouse(
  blacklist: string[],
  since: Date,
  limit: number,
): Promise<HubSignupLeaderRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    since: chDateTime(since),
    lim: limit,
    ...(hasBlacklist ? { blacklist } : {}),
  };

  return clickhouseRead.query<HubSignupLeaderRow>({
    queryName: "creator-hub.topSignupLeaders",
    sql: `WITH creators AS (
            SELECT id, username FROM ${CH_DB}.public_user FINAL
            WHERE _peerdb_is_deleted = 0 AND role = 'creator'
          )
          SELECT u.referred_by AS creator_id,
                 any(c.username) AS username,
                 toString(count()) AS value
          FROM ${CH_DB}.public_user AS u FINAL
          INNER JOIN creators AS c ON c.id = u.referred_by
          WHERE u._peerdb_is_deleted = 0
            AND u.role NOT IN ('admin','support','creator')
            AND u.created_at >= {since:DateTime64(3)}
            ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
          GROUP BY creator_id
          ORDER BY count() DESC
          LIMIT {lim:UInt32}`,
    params,
    timeoutMs: 15_000,
  });
}
