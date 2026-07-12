import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "@/lib/clickhouse/queries/_shared";

/**
 * Creator-Hub "Top creators by deposits" — ClickHouse twin of the Postgres
 * `covered_deposits` ranking in
 * src/app/(creator-hub)/creator-hub/_queries/hub-top-creators-query.ts.
 *
 * Canonical PG shape mirrored EXACTLY:
 *   • Scan completed `deposit` ledger rows in the window, by REAL customers
 *     (role NOT IN admin/support/creator, minus the excluded-users blacklist).
 *   • Map each deposit to a creator = the affiliate_user_id of the MOST RECENT
 *     affiliate_code_usage for that depositor in the 7-day pre-deposit window
 *     (self-referrals dropped). PG does this with
 *     `DISTINCT ON (lt.id) ... ORDER BY lt.id, acu.created_at DESC`; the CH twin
 *     does it with `argMax(acu.affiliate_user_id, acu.created_at)` grouped per
 *     ledger id (same "latest qualifying acu wins" semantics).
 *   • Keep only deposits whose mapped creator actually has role='creator', SUM
 *     per creator, drop non-positive, ORDER BY deposits DESC, LIMIT 6.
 *
 * Returns the SAME row shape as the PG `DepositRankRow` (creator_id, username,
 * image, deposits) so `resolveAdminRead` can swap the leg transparently and the
 * downstream meta hydration (code + signups) is unchanged.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every public_* table;
 * money stays Decimal end-to-end (`toString(sum(...))` in SQL → toNumber in TS,
 * never Float). The blacklist is passed in by the caller so this module imports
 * no Postgres client.
 */

type TopCreatorDepositRow = {
  creator_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
};

type CreatorHubTopPeriod = "3d" | "7d" | "14d";

const PERIOD_DAYS: Record<CreatorHubTopPeriod, number> = {
  "3d": 3,
  "7d": 7,
  "14d": 14,
};

/** Trailing-window start, anchored to a single instant (deterministic parity). */
export function topCreatorsSinceDate(
  period: CreatorHubTopPeriod,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() - PERIOD_DAYS[period] * 86_400_000);
}

const TOP_CREATORS_LIMIT = 6;

export async function rankTopCreatorsByDepositsFromClickHouse(
  period: CreatorHubTopPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<TopCreatorDepositRow[]> {
  const since = topCreatorsSinceDate(period, now);
  const hasBlacklist = blacklist.length > 0;

  const sql = `
    WITH real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    ),
    creators AS (
      SELECT id, username, image
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role = 'creator'
    ),
    deposits AS (
      SELECT lt.id AS lid,
             lt.user_id AS uid,
             lt.amount AS amount,
             lt.created_at AS ts
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.user_id IN (SELECT id FROM real_users)
        AND lt.created_at >= {since:DateTime64(3)}
    ),
    mapped AS (
      SELECT d.amount AS amount,
             argMax(acu.affiliate_user_id, acu.created_at) AS creator_id
      FROM deposits AS d
      LEFT JOIN ${CH_DB}.public_affiliate_code_usages AS acu FINAL
             ON acu.referred_user_id = d.uid
            AND acu._peerdb_is_deleted = 0
            AND acu.referred_user_id <> acu.affiliate_user_id
            AND acu.created_at <= d.ts
            AND acu.created_at >= d.ts - INTERVAL 7 DAY
      GROUP BY d.lid, d.amount
    )
    SELECT m.creator_id AS creator_id,
           c.username AS username,
           c.image AS image,
           toString(sum(m.amount)) AS deposits
    FROM mapped AS m
    INNER JOIN creators AS c ON c.id = m.creator_id
    WHERE m.creator_id <> ''
    GROUP BY m.creator_id, c.username, c.image
    HAVING sum(m.amount) > 0
    ORDER BY sum(m.amount) DESC
    LIMIT ${TOP_CREATORS_LIMIT}`;

  return clickhouseRead.query<TopCreatorDepositRow>({
    queryName: "creator-hub.top-creators",
    sql,
    params: hasBlacklist
      ? { since: chDateTime(since), blacklist }
      : { since: chDateTime(since) },
    timeoutMs: 20_000,
  });
}
