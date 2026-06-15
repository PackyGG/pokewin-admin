import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RaceCohortRow,
  RaceCohortResult,
} from "@/lib/queries/insights-rewards/race/cohort";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsCohort`
 * (`src/lib/queries/insights-rewards/race/cohort.ts`).
 *
 * PARITY: three demographic breakdowns of race-prize winners in the window —
 * top-8 countries (by prize), top-8 signup sources (by winner count), and the
 * six fixed signup-recency buckets — plus the distinct-winner denominator used
 * for the share %. The signup source is each winner's PRIMARY (earliest-created)
 * account provider; PG's `DISTINCT ON (userId) ORDER BY created_at ASC NULLS
 * LAST` is reproduced with `argMin(providerId, created_at)`. The recency bucket
 * uses the IDENTICAL day boundaries on the microsecond epoch gap between signup
 * and first in-window claim. `share` is derived in TS off the grand total,
 * identical to the PG twin.
 *
 * The country/source lists are top-N by an aggregate with no secondary
 * tiebreaker (mirrors PG), so the compare hook diffs the over-returned-rows
 * aggregate; the parity script additionally proves the order-independent
 * full-population aggregates + the six (stable) signup buckets.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table,
 * `uniqExact` for distinct counts, money Decimal with scale-matched
 * `toDecimal128(0, 2)` zero-branch.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTRY_LIMIT = 8;
const SOURCE_LIMIT = 8;

type CodeRow = { code: string; winners: string; prize: string };
type ProviderRow = { provider: string; winners: string; prize: string };
type BucketRow = { bucket: string; winners: string; prize: string };
type TotalRow = { winners: string };

const GAP_DAYS = `(toUnixTimestamp64Micro(wfc.first_claim_at) - toUnixTimestamp64Micro(u.created_at)) / 1000000.0 / 86400.0`;

export async function getRaceInsightsCohortFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaceCohortResult> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const [countryRows, sourceRows, cohortRows, totalRows] = await Promise.all([
    clickhouseRead.query<CodeRow>({
      queryName: "insights.rewards.race.cohort.country",
      sql: `
        WITH ${scope}
        SELECT
          coalesce(u.country_code, '??')     AS code,
          toString(uniqExact(rc.user_id))    AS winners,
          toString(sum(rc.prize_amount_usd)) AS prize
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = rc.user_id
        WHERE rc._peerdb_is_deleted = 0
          AND u._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}
        GROUP BY coalesce(u.country_code, '??')
        ORDER BY sum(rc.prize_amount_usd) DESC
        LIMIT ${COUNTRY_LIMIT}`,
      params,
    }),
    clickhouseRead.query<ProviderRow>({
      queryName: "insights.rewards.race.cohort.source",
      sql: `
        WITH
          ${scope},
          winners AS (
            SELECT DISTINCT rc.user_id AS user_id
            FROM ${CH_DB}.public_race_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.user_id IN (SELECT id FROM real_users)
              ${dateClause}
          ),
          prize_by_user AS (
            SELECT rc.user_id AS user_id, sum(rc.prize_amount_usd) AS total
            FROM ${CH_DB}.public_race_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.user_id IN (SELECT user_id FROM winners)
              ${dateClause}
            GROUP BY rc.user_id
          ),
          primary_provider AS (
            SELECT a.userId AS user_id, argMin(a.providerId, a.created_at) AS provider
            FROM ${CH_DB}.public_account AS a FINAL
            WHERE a._peerdb_is_deleted = 0
              AND a.userId IN (SELECT user_id FROM winners)
            GROUP BY a.userId
          )
        SELECT
          coalesce(pp.provider, 'unknown') AS provider,
          toString(uniqExact(w.user_id))   AS winners,
          toString(sum(coalesce(pbu.total, toDecimal128(0, 2)))) AS prize
        FROM winners AS w
        LEFT JOIN primary_provider AS pp ON pp.user_id = w.user_id
        LEFT JOIN prize_by_user AS pbu ON pbu.user_id = w.user_id
        GROUP BY coalesce(pp.provider, 'unknown')
        ORDER BY uniqExact(w.user_id) DESC
        LIMIT ${SOURCE_LIMIT}`,
      params,
    }),
    clickhouseRead.query<BucketRow>({
      queryName: "insights.rewards.race.cohort.signup",
      sql: `
        WITH
          ${scope},
          winner_first_claim AS (
            SELECT
              rc.user_id AS user_id,
              min(rc.claimed_at) AS first_claim_at,
              sum(rc.prize_amount_usd) AS prize_total
            FROM ${CH_DB}.public_race_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.user_id IN (SELECT id FROM real_users)
              ${dateClause}
            GROUP BY rc.user_id
          ),
          bucketed AS (
            SELECT
              multiIf(
                ${GAP_DAYS} < 7, '0_7d',
                ${GAP_DAYS} < 30, '7_30d',
                ${GAP_DAYS} < 90, '30_90d',
                ${GAP_DAYS} < 180, '90_180d',
                ${GAP_DAYS} < 365, '180_365d',
                '365d_plus'
              ) AS bucket,
              wfc.user_id AS user_id,
              wfc.prize_total AS prize_total
            FROM winner_first_claim AS wfc
            INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = wfc.user_id
            WHERE u._peerdb_is_deleted = 0
          )
        SELECT
          bucket                       AS bucket,
          toString(uniqExact(user_id)) AS winners,
          toString(sum(prize_total))   AS prize
        FROM bucketed
        GROUP BY bucket`,
      params,
    }),
    clickhouseRead.query<TotalRow>({
      queryName: "insights.rewards.race.cohort.total",
      sql: `
        WITH ${scope}
        SELECT toString(uniqExact(rc.user_id)) AS winners
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}`,
      params,
    }),
  ]);

  const totalWinners = Number(totalRows[0]?.winners ?? 0);

  const COUNTRY_LABEL = (code: string) => (code === "??" ? "Unknown" : code);
  const countries: RaceCohortRow[] = countryRows.map((r) => ({
    key: r.code,
    label: COUNTRY_LABEL(r.code),
    winnerCount: Number(r.winners),
    totalPrize: toNumber(r.prize),
    share: totalWinners > 0 ? (Number(r.winners) / totalWinners) * 100 : 0,
  }));

  const sources: RaceCohortRow[] = sourceRows.map((r) => ({
    key: r.provider,
    label: r.provider,
    winnerCount: Number(r.winners),
    totalPrize: toNumber(r.prize),
    share: totalWinners > 0 ? (Number(r.winners) / totalWinners) * 100 : 0,
  }));

  const BUCKET_LABEL: Record<string, string> = {
    "0_7d": "0–7 days",
    "7_30d": "7–30 days",
    "30_90d": "30–90 days",
    "90_180d": "90–180 days",
    "180_365d": "180–365 days",
    "365d_plus": "1 year+",
  };
  const BUCKET_ORDER = [
    "0_7d",
    "7_30d",
    "30_90d",
    "90_180d",
    "180_365d",
    "365d_plus",
  ];
  const cohortByKey = new Map<
    string,
    { winnerCount: number; totalPrize: number }
  >();
  for (const r of cohortRows) {
    cohortByKey.set(r.bucket, {
      winnerCount: Number(r.winners),
      totalPrize: toNumber(r.prize),
    });
  }
  const signupCohorts: RaceCohortRow[] = BUCKET_ORDER.map((key) => {
    const row = cohortByKey.get(key) ?? { winnerCount: 0, totalPrize: 0 };
    return {
      key,
      label: BUCKET_LABEL[key] ?? key,
      winnerCount: row.winnerCount,
      totalPrize: row.totalPrize,
      share: totalWinners > 0 ? (row.winnerCount / totalWinners) * 100 : 0,
    };
  });

  return { countries, sources, signupCohorts };
}
