import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "@/lib/clickhouse/queries/_shared";

/**
 * Creator-Hub "big first-time deposit" alerts — ClickHouse twin of
 * `deriveBigFtdAlerts` in
 * src/app/(creator-hub)/creator-hub/alerts/_queries/creator-alerts.ts.
 *
 * The Postgres leg Parallel-Seq-Scans ALL of ledger_transactions (~925k rows,
 * ~280 MB) because the first-deposit-per-user DISTINCT ON cannot be pruned by
 * the 48h window (the window is applied AFTER the per-user reduction) and the
 * `type::text` cast (needed for dev-DB enum-lag safety) defeats the enum index.
 * This twin does the same on the columnar mirror cheaply (argMin per user).
 *
 * Semantics mirrored EXACTLY:
 *   • first_deposits = the EARLIEST completed deposit per real user (role NOT IN
 *     admin/support/creator minus blacklist), across ALL history.
 *   • keep only first deposits in the last {lookbackHours} with amount >= {minUsd}.
 *   • creator_user_id = the affiliate of the MOST RECENT affiliate usage in the
 *     7-day pre-deposit window (argMax = PG DISTINCT ON / ORDER BY created_at DESC
 *     LIMIT 1); '' when none (the consumer skips falsy creator ids).
 */

export type BigFtdAlertRow = {
  ledger_tx_id: string;
  user_id: string;
  amount: string;
  created_at: string;
  creator_user_id: string;
};

export async function deriveBigFtdAlertsFromClickHouse(
  blacklist: string[],
  since: Date,
  minUsd: number,
): Promise<BigFtdAlertRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    since: chDateTime(since),
    minUsd,
    ...(hasBlacklist ? { blacklist } : {}),
  };

  return clickhouseRead.query<BigFtdAlertRow>({
    queryName: "creator-hub.bigFtdAlerts",
    sql: `WITH real_users AS (
            SELECT id FROM ${CH_DB}.public_user FINAL
            WHERE _peerdb_is_deleted = 0
              AND role NOT IN ('admin','support','creator')
              ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
          ),
          first_deposits AS (
            SELECT lt.user_id AS uid,
                   argMin(lt.id, lt.created_at) AS ledger_tx_id,
                   argMin(lt.amount, lt.created_at) AS amount,
                   min(lt.created_at) AS ts
            FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
            WHERE lt._peerdb_is_deleted = 0
              AND lt.type = 'deposit' AND lt.status = 'completed'
              AND lt.user_id IN (SELECT id FROM real_users)
            GROUP BY lt.user_id
          ),
          filtered AS (
            SELECT uid, ledger_tx_id, amount, ts
            FROM first_deposits
            WHERE ts >= {since:DateTime64(3)} AND amount >= {minUsd:Decimal(20,2)}
          ),
          mapped AS (
            SELECT d.ledger_tx_id AS ledger_tx_id, d.uid AS user_id,
                   d.amount AS amount, d.ts AS ts,
                   argMax(acu.affiliate_user_id, acu.created_at) AS creator_id
            FROM filtered AS d
            LEFT JOIN ${CH_DB}.public_affiliate_code_usages AS acu FINAL
                   ON acu.referred_user_id = d.uid
                  AND acu._peerdb_is_deleted = 0
                  AND acu.referred_user_id <> acu.affiliate_user_id
                  AND acu.created_at <= d.ts
                  AND acu.created_at >= d.ts - INTERVAL 7 DAY
            GROUP BY d.ledger_tx_id, d.uid, d.amount, d.ts
          )
          SELECT ledger_tx_id,
                 user_id,
                 toString(amount) AS amount,
                 formatDateTime(ts, '%Y-%m-%dT%H:%i:%SZ') AS created_at,
                 creator_id AS creator_user_id
          FROM mapped`,
    params,
    timeoutMs: 20_000,
  });
}
