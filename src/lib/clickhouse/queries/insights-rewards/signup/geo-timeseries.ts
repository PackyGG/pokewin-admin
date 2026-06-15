import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import {
  CH_DB,
  SIGNUP_ROLE_SCOPE,
  blacklistClause,
  signupCutoffCapped,
} from "./_shared";

/**
 * ClickHouse twin of `getSignupGeoTimeSeries`
 * (`src/lib/queries/insights-rewards/signup/geo-timeseries.ts`).
 *
 * The PG twin returns the top-5 countries by signup count in the window, each
 * with a daily (signups, claimers) series. This twin mirrors the per-country
 * window totals those series sum to:
 *   • countryCount — number of top countries returned (≤5)
 *   • signupSum    — Σ signups across the returned top-5 countries
 *   • claimerSum   — Σ distinct claimers across the returned top-5 countries
 *
 * Window: lifetime (`all`) caps at the last 90 days exactly as the PG twin's
 * `effectiveDays = days ?? 90`. NOTE (top-N tie): the served PG `ORDER BY
 * COUNT(*) DESC` has no explicit tie-break, so a tie straddling the 5th slot can
 * select a different country than this twin's deterministic `signups DESC, code
 * ASC`; the parity harness pins the SAME tie-break on both sides to prove
 * structural parity. Scope mirrors PG: `role NOT IN ('admin','support')` + blacklist.
 */

const LIFETIME_CAP_DAYS = 90;

export type SignupGeoTimeSeriesCh = {
  countryCount: number;
  signupSum: number;
  claimerSum: number;
};

export async function getSignupGeoTimeSeriesFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupGeoTimeSeriesCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = signupCutoffCapped(period, now, LIFETIME_CAP_DAYS);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const rows = await clickhouseRead.query<{ signups: string; claimers: string }>({
    queryName: "insights.signup.geo_timeseries",
    sql: `
      WITH
        cohort AS (
          SELECT id AS user_id, coalesce(country_code, '??') AS code
          FROM ${CH_DB}.public_user FINAL
          WHERE _peerdb_is_deleted = 0
            AND ${SIGNUP_ROLE_SCOPE}
            ${blacklistClause(hasBlacklist, "id")}
            AND created_at >= {cutoff:DateTime64(6)}
        ),
        claim_users AS (
          SELECT DISTINCT lt.user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim'
            AND lt.user_id IN (SELECT user_id FROM cohort)
        )
      SELECT
        toString(count()) AS signups,
        toString(countIf(user_id IN (SELECT user_id FROM claim_users))) AS claimers
      FROM cohort
      GROUP BY code
      ORDER BY count() DESC, code ASC
      LIMIT 5`,
    params,
  });

  return {
    countryCount: rows.length,
    signupSum: rows.reduce((a, r) => a + Number(r.signups), 0),
    claimerSum: rows.reduce((a, r) => a + Number(r.claimers), 0),
  };
}
