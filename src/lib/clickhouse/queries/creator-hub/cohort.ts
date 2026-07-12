import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "@/lib/clickhouse/queries/_shared";

/**
 * Creator-Hub dashboard cohort — ClickHouse twin of the 8 correlated Postgres
 * scans in
 * src/app/(creator-hub)/creator-hub/_queries/hub-dashboard-cohort.ts
 * (`getHubCohortWindowed`).
 *
 * Returns the SAME raw row bundle the Postgres `Promise.all` produces, so the
 * existing merge + pad post-processing runs unchanged on either source and
 * `resolveAdminRead('creator_hub_cohort', { pg, ch })` can swap the leg.
 *
 * Semantics mirrored EXACTLY from the PG definition:
 *   • KPI window = the active period; chart series window = fixed 30 days.
 *   • Customer scope = role NOT IN (admin,support,creator) minus the
 *     excluded-users blacklist (`real_users`). The PG `exclStaffSessionFrag`
 *     session-window NOT EXISTS is a documented no-op once creators are dropped
 *     wholesale (see metrics/scope.ts) and is sourced from the backend API, so
 *     it is intentionally omitted here — identical to `customerScopeCte`.
 *   • signups   = real users referred by a creator, signed up in window.
 *   • ftds      = distinct referred users with a 'deposit' affiliate usage,
 *                 affiliate is a creator, referred user is real, in window.
 *   • deposits  = covered-deposit SUM: each completed deposit by a real user is
 *                 mapped to the creator of its MOST RECENT affiliate usage in
 *                 the 7-day pre-deposit window (argMax = PG DISTINCT ON), summed
 *                 over deposits whose mapped user has role='creator'.
 *   • wager (packs/battles) = completed ledger wager legs (pack_opening minus
 *                 reward/daily packs, battle_bet, battle_sponsorship) by real
 *                 users, mapped to a creator via the same 7-day borrow lateral.
 *   • upgrader  = upgrader_games bet_amount by real users, mapped to a creator.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every public_* table;
 * money Decimal end-to-end (toString(sum(...)) → toNumber in TS, never Float);
 * day buckets via toDate(created_at) (UTC), serialized as 'YYYY-MM-DD' to match
 * the PG DATE_TRUNC('day', ...) buckets the merge helpers consume.
 */

type HubCohortCountRow = { value: string };
type HubCohortCountBucketRow = { bucket: string; value: string };
type HubCohortMoneyBucketRow = { bucket: string; amount: string };
type HubCohortWagerBucketRow = {
  bucket: string;
  packs: string;
  battles: string;
};

type HubCohortScanBundle = {
  signupRows: HubCohortCountRow[];
  ftdRows: HubCohortCountRow[];
  depositTotalRows: HubCohortCountRow[];
  signupSeriesRows: HubCohortCountBucketRow[];
  ftdSeriesRows: HubCohortCountBucketRow[];
  depositSeriesRows: HubCohortMoneyBucketRow[];
  ledgerWagerSeriesRows: HubCohortWagerBucketRow[];
  upgraderWagerSeriesRows: HubCohortMoneyBucketRow[];
};

function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
    SELECT id FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND role NOT IN ('admin','support','creator')
      ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
  )`;
}

const CREATORS_CTE = `creators AS (
  SELECT id FROM ${CH_DB}.public_user FINAL
  WHERE _peerdb_is_deleted = 0 AND role = 'creator'
)`;

const REWARD_PACK_SESSIONS_CTE = `reward_pack_sessions AS (
  SELECT gs.id AS id
  FROM ${CH_DB}.public_game_sessions AS gs FINAL
  INNER JOIN ${CH_DB}.public_packs AS p FINAL
          ON p.id = gs.game_id AND p.pack_type = 'reward' AND p._peerdb_is_deleted = 0
  WHERE gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
)`;

/** The 7-day "most recent affiliate usage wins" borrow lateral, as a JOIN. */
function borrowLateralJoin(): string {
  return `LEFT JOIN ${CH_DB}.public_affiliate_code_usages AS acu FINAL
            ON acu.referred_user_id = d.uid
           AND acu._peerdb_is_deleted = 0
           AND acu.referred_user_id <> acu.affiliate_user_id
           AND acu.created_at <= d.ts
           AND acu.created_at >= d.ts - INTERVAL 7 DAY`;
}

export async function getHubCohortScansFromClickHouse(
  blacklist: string[],
  sinceKpi: Date,
  sinceChart: Date,
): Promise<HubCohortScanBundle> {
  const hasBlacklist = blacklist.length > 0;
  const blParam = hasBlacklist ? { blacklist } : {};
  const kpi = { since: chDateTime(sinceKpi), ...blParam };
  const chart = { since: chDateTime(sinceChart), ...blParam };

  const run = <T>(queryName: string, sql: string, params: Record<string, unknown>) =>
    clickhouseRead.query<T>({ queryName, sql, params, timeoutMs: 25_000 });

  const [
    signupRows,
    ftdRows,
    depositTotalRows,
    signupSeriesRows,
    ftdSeriesRows,
    depositSeriesRows,
    ledgerWagerSeriesRows,
    upgraderWagerSeriesRows,
  ] = await Promise.all([
    // 1) KPI signups
    run<HubCohortCountRow>(
      "creator-hub.cohort.signups",
      `WITH ${CREATORS_CTE}
       SELECT toString(count()) AS value
       FROM ${CH_DB}.public_user AS u FINAL
       WHERE u._peerdb_is_deleted = 0
         AND u.role NOT IN ('admin','support','creator')
         AND u.referred_by IN (SELECT id FROM creators)
         AND u.created_at >= {since:DateTime64(3)}
         ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}`,
      kpi,
    ),

    // 2) KPI ftds
    run<HubCohortCountRow>(
      "creator-hub.cohort.ftds",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE}
       SELECT toString(uniqExact(acu.referred_user_id)) AS value
       FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
       WHERE acu._peerdb_is_deleted = 0
         AND acu.usage_type = 'deposit'
         AND acu.referred_user_id <> acu.affiliate_user_id
         AND acu.affiliate_user_id IN (SELECT id FROM creators)
         AND acu.referred_user_id IN (SELECT id FROM real_users)
         AND acu.created_at >= {since:DateTime64(3)}`,
      kpi,
    ),

    // 3) KPI deposits (covered-deposit sum)
    run<HubCohortCountRow>(
      "creator-hub.cohort.deposits",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE},
       deposits AS (
         SELECT lt.id AS lid, lt.user_id AS uid, lt.amount AS amount, lt.created_at AS ts
         FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
         WHERE lt._peerdb_is_deleted = 0 AND lt.type = 'deposit' AND lt.status = 'completed'
           AND lt.user_id IN (SELECT id FROM real_users)
           AND lt.created_at >= {since:DateTime64(3)}
       ),
       mapped AS (
         SELECT d.amount AS amount, argMax(acu.affiliate_user_id, acu.created_at) AS creator_id
         FROM deposits AS d
         ${borrowLateralJoin()}
         GROUP BY d.lid, d.amount
       )
       SELECT toString(sum(m.amount)) AS value
       FROM mapped AS m
       WHERE m.creator_id <> '' AND m.creator_id IN (SELECT id FROM creators)`,
      kpi,
    ),

    // 4) signup series (30d daily)
    run<HubCohortCountBucketRow>(
      "creator-hub.cohort.signupSeries",
      `WITH ${CREATORS_CTE}
       SELECT toDate(u.created_at) AS bucket, toString(count()) AS value
       FROM ${CH_DB}.public_user AS u FINAL
       WHERE u._peerdb_is_deleted = 0
         AND u.role NOT IN ('admin','support','creator')
         AND u.referred_by IN (SELECT id FROM creators)
         AND u.created_at >= {since:DateTime64(3)}
         ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
       GROUP BY bucket ORDER BY bucket`,
      chart,
    ),

    // 5) ftd series (30d daily)
    run<HubCohortCountBucketRow>(
      "creator-hub.cohort.ftdSeries",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE}
       SELECT toDate(acu.created_at) AS bucket, toString(uniqExact(acu.referred_user_id)) AS value
       FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
       WHERE acu._peerdb_is_deleted = 0
         AND acu.usage_type = 'deposit'
         AND acu.referred_user_id <> acu.affiliate_user_id
         AND acu.affiliate_user_id IN (SELECT id FROM creators)
         AND acu.referred_user_id IN (SELECT id FROM real_users)
         AND acu.created_at >= {since:DateTime64(3)}
       GROUP BY bucket ORDER BY bucket`,
      chart,
    ),

    // 6) deposit series (30d daily, covered-deposit sum)
    run<HubCohortMoneyBucketRow>(
      "creator-hub.cohort.depositSeries",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE},
       deposits AS (
         SELECT lt.id AS lid, lt.user_id AS uid, lt.amount AS amount, lt.created_at AS ts
         FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
         WHERE lt._peerdb_is_deleted = 0 AND lt.type = 'deposit' AND lt.status = 'completed'
           AND lt.user_id IN (SELECT id FROM real_users)
           AND lt.created_at >= {since:DateTime64(3)}
       ),
       mapped AS (
         SELECT toDate(d.ts) AS bucket, d.amount AS amount,
                argMax(acu.affiliate_user_id, acu.created_at) AS creator_id
         FROM deposits AS d
         ${borrowLateralJoin()}
         GROUP BY d.lid, bucket, d.amount
       )
       SELECT bucket, toString(sum(m.amount)) AS amount
       FROM mapped AS m
       WHERE m.creator_id <> '' AND m.creator_id IN (SELECT id FROM creators)
       GROUP BY bucket ORDER BY bucket`,
      chart,
    ),

    // 7) ledger wager series (30d daily, packs/battles)
    run<HubCohortWagerBucketRow>(
      "creator-hub.cohort.ledgerWagerSeries",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE}, ${REWARD_PACK_SESSIONS_CTE},
       wager AS (
         SELECT lt.id AS lid, lt.user_id AS uid, lt.type AS type,
                abs(lt.amount) AS amount, lt.created_at AS ts
         FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
         WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
           AND lt.created_at >= {since:DateTime64(3)}
           AND lt.user_id IN (SELECT id FROM real_users)
           AND (
             lt.type = 'battle_bet'
             OR lt.type = 'battle_sponsorship'
             OR (lt.type = 'pack_opening'
                 AND (isNull(lt.game_session_id)
                      OR lt.game_session_id NOT IN (SELECT id FROM reward_pack_sessions)))
           )
       ),
       mapped AS (
         SELECT toDate(d.ts) AS bucket, d.type AS type, d.amount AS amount,
                argMax(acu.affiliate_user_id, acu.created_at) AS creator_id
         FROM wager AS d
         ${borrowLateralJoin()}
         GROUP BY d.lid, bucket, d.type, d.amount
       )
       SELECT bucket,
              toString(sum(if(type = 'pack_opening', amount, toDecimal128(0, 2)))) AS packs,
              toString(sum(if(type IN ('battle_bet','battle_sponsorship'), amount, toDecimal128(0, 2)))) AS battles
       FROM mapped AS m
       WHERE m.creator_id <> '' AND m.creator_id IN (SELECT id FROM creators)
       GROUP BY bucket ORDER BY bucket`,
      chart,
    ),

    // 8) upgrader wager series (30d daily)
    run<HubCohortMoneyBucketRow>(
      "creator-hub.cohort.upgraderWagerSeries",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE},
       ug AS (
         SELECT ug.id AS gid, ug.user_id AS uid, ug.bet_amount AS amount, ug.created_at AS ts
         FROM ${CH_DB}.public_upgrader_games AS ug FINAL
         WHERE ug._peerdb_is_deleted = 0
           AND ug.user_id IN (SELECT id FROM real_users)
           AND ug.created_at >= {since:DateTime64(3)}
       ),
       mapped AS (
         SELECT toDate(d.ts) AS bucket, d.amount AS amount,
                argMax(acu.affiliate_user_id, acu.created_at) AS creator_id
         FROM ug AS d
         ${borrowLateralJoin()}
         GROUP BY d.gid, bucket, d.amount
       )
       SELECT bucket, toString(sum(m.amount)) AS amount
       FROM mapped AS m
       WHERE m.creator_id <> '' AND m.creator_id IN (SELECT id FROM creators)
       GROUP BY bucket ORDER BY bucket`,
      chart,
    ),
  ]);

  return {
    signupRows,
    ftdRows,
    depositTotalRows,
    signupSeriesRows,
    ftdSeriesRows,
    depositSeriesRows,
    ledgerWagerSeriesRows,
    upgraderWagerSeriesRows,
  };
}
