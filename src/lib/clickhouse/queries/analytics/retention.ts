import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "../_shared";

/**
 * ClickHouse twin of `getRetentionCurve`
 * (`src/lib/queries/analytics-retention.ts`) — the /analytics?tab=retention
 * retention / churn curve.
 *
 * PARITY with the canonical Postgres definition:
 *   • eligible cohort  = `public_user` rows with role NOT IN ('admin','support')
 *                        (creators KEPT) + excluded-users blacklist, signed up
 *                        within the last 180 days.
 *   • activity         = DISTINCT (user, day-offset) where the user placed a
 *                        completed wager-type ledger row in
 *                        [signup, signup + 91 days]; day-offset =
 *                        floor((tx − signup) / 1 day).
 *   • curve[day 0..90] :
 *       - retained = COUNT(DISTINCT user) active on that day-offset.
 *       - cohort   = COUNT(eligible users old enough to be measured at day N)
 *                    = eligible users whose signup age ≥ N days.
 *       - pct      = retained / cohort (derived in TS).
 *   • d1 / d7 / d30 / d90 pct + their cohort sizes are read off the curve.
 *
 * Scope mirrors PG EXACTLY: `role NOT IN ('admin','support')` (creators KEPT,
 * NOT the wholesale 3-role dashboard scope) + blacklist, so comparison-mode
 * drift cleanly signals a real bug rather than an intended scope difference.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0`.
 *   • Day-offset uses microsecond timestamps
 *     (`toUnixTimestamp64Micro`) divided by µs-per-day then floored, matching
 *     PG's `FLOOR(EXTRACT(EPOCH FROM (tx − signup)) / 86400)` to the microsecond
 *     (avoids the second-truncation skew of `dateDiff('second', …)`).
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client — it is a
 * pure ClickHouse read. `now` is injected so a parity harness can feed the
 * IDENTICAL window boundary to both engines.
 */

export type RetentionDataCh = {
  curve: { day: number; retained: number; pct: number; cohort: number }[];
  d1: number;
  d7: number;
  d30: number;
  d90: number;
  cohortD1: number;
  cohortD7: number;
  cohortD30: number;
  cohortD90: number;
};

const WAGER_TYPES_CH =
  "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";
const COHORT_WINDOW_DAYS = 180;
const CURVE_LENGTH = 91; // day 0 through day 90 inclusive
const MS_PER_DAY = 86_400_000;
const MICROS_PER_DAY = 86_400_000_000;

export async function getRetentionCurveFromClickHouse(
  blacklist: string[],
  now: Date = new Date(),
): Promise<RetentionDataCh> {
  const hasBlacklist = blacklist.length > 0;
  const blacklistClause = hasBlacklist
    ? "AND id NOT IN {blacklist:Array(String)}"
    : "";
  const windowStart = chDateTime(
    new Date(now.getTime() - COHORT_WINDOW_DAYS * MS_PER_DAY),
  );
  const nowLiteral = chDateTime(now);
  const params: Record<string, unknown> = {
    blacklist,
    windowStart,
    now: nowLiteral,
  };

  const eligibleCte = `
    eligible AS (
      SELECT id AS user_id, created_at AS signed_up_at
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${blacklistClause}
        AND created_at >= {windowStart:DateTime64(6)}
    )`;

  // Cohort sizes per day-offset: an eligible user is "old enough" to be
  // measured at day N when their signup age (full days) ≥ N. We emit the age
  // distribution (capped at the curve max) and fan it out into the cumulative
  // cohort counts in TS, matching PG's
  // `COUNT(DISTINCT e.user_id) WHERE e.created_at <= NOW() - make_interval(days => d)`.
  const ageSql = `
    WITH ${eligibleCte}
    SELECT
      toInt32(least(
        ${CURVE_LENGTH - 1},
        intDiv(
          toUnixTimestamp64Micro({now:DateTime64(6)}) - toUnixTimestamp64Micro(signed_up_at),
          ${MICROS_PER_DAY}
        )
      )) AS age_day,
      toString(count()) AS cnt
    FROM eligible
    WHERE toUnixTimestamp64Micro({now:DateTime64(6)}) - toUnixTimestamp64Micro(signed_up_at) >= 0
    GROUP BY age_day`;

  // Retained per day-offset: distinct users active on day N within the curve.
  const retainedSql = `
    WITH
      ${eligibleCte},
      activity AS (
        SELECT DISTINCT
          lt.user_id AS user_id,
          toInt32(floor(
            (toUnixTimestamp64Micro(lt.created_at) - toUnixTimestamp64Micro(e.signed_up_at)) / ${MICROS_PER_DAY}.0
          )) AS day
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        INNER JOIN eligible e ON e.user_id = lt.user_id
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ${WAGER_TYPES_CH}
          AND lt.created_at >= e.signed_up_at
          AND lt.created_at <= e.signed_up_at + INTERVAL ${CURVE_LENGTH} DAY
      )
    SELECT day AS day, toString(count()) AS retained
    FROM activity
    WHERE day >= 0 AND day <= ${CURVE_LENGTH - 1}
    GROUP BY day`;

  const [ageRows, retRows] = await Promise.all([
    clickhouseRead.query<{ age_day: number; cnt: string }>({
      queryName: "analytics.retention.cohort",
      sql: ageSql,
      params,
    }),
    clickhouseRead.query<{ day: number; retained: string }>({
      queryName: "analytics.retention.retained",
      sql: retainedSql,
      params,
    }),
  ]);

  // Cohort at day N = Σ eligible users whose age_day ≥ N (capped distribution).
  const ageCount = new Map<number, number>();
  for (const r of ageRows) {
    ageCount.set(Number(r.age_day), Number(r.cnt));
  }
  const cohortAtDay = new Array<number>(CURVE_LENGTH).fill(0);
  // Suffix-sum from the top so cohortAtDay[d] = users with age_day ≥ d.
  let running = 0;
  for (let d = CURVE_LENGTH - 1; d >= 0; d--) {
    running += ageCount.get(d) ?? 0;
    cohortAtDay[d] = running;
  }

  const retainedAtDay = new Map<number, number>();
  for (const r of retRows) {
    retainedAtDay.set(Number(r.day), Number(r.retained));
  }

  const curve = Array.from({ length: CURVE_LENGTH }, (_, day) => {
    const retained = retainedAtDay.get(day) ?? 0;
    const cohort = cohortAtDay[day] ?? 0;
    const pct = cohort > 0 ? retained / cohort : 0;
    return { day, retained, pct, cohort };
  });

  function at(day: number): { retained: number; cohort: number; pct: number } {
    const point = curve.find((c) => c.day === day);
    return point ?? { retained: 0, cohort: 0, pct: 0 };
  }

  const d1 = at(1);
  const d7 = at(7);
  const d30 = at(30);
  const d90 = at(90);

  return {
    curve,
    d1: d1.pct,
    d7: d7.pct,
    d30: d30.pct,
    d90: d90.pct,
    cohortD1: d1.cohort,
    cohortD7: d7.cohort,
    cohortD30: d30.cohort,
    cohortD90: d90.cohort,
  };
}
