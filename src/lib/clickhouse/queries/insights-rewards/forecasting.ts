import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";

import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of the /insights/forecast (rewards forecast tab) surface —
 * Phase 2B comparison-mode read from the prod game mirror (`packy_prod`, PeerDB
 * CDC).
 *
 * The canonical Postgres source is `getRewardsForecasting` /
 * `computeForecasting` in `src/lib/queries/insights-rewards/forecasting.ts`.
 * That helper has two parts:
 *
 *   1. A single DB-read aggregate — per-day per-category SUM(ABS(amount)) over a
 *      trailing 60-day window of reward ledger transactions.
 *   2. A pure-TS projection layer — zero-fill onto a UTC date axis, fold the
 *      per-day net rain house slice into the rainRace series, take a trailing
 *      7-day average, project ×30, drop empty categories, sort.
 *
 * Per the Phase 2B contract ONLY the DB-READ AGGREGATE moves to ClickHouse; the
 * projection math is pure TS and stays shared on the Postgres side. So this twin
 * reproduces EXACTLY the raw `$queryRawUnsafe` output the PG path feeds its
 * projection with: rows of `{ date, category, total }`, where `category`
 * includes the `__rain_win` / `__rain_tip` per-day pseudo-buckets the PG SQL
 * emits (the net-rain fold happens later, in shared TS, on both engines'
 * aggregates identically). The comparison layer applies that same fold to BOTH
 * sides so logged drift reflects engine / CDC-lag only, never a math change.
 *
 * SCOPE (mirrors the PG twin EXACTLY — NOT the wholesale customer scope):
 *   role NOT IN ('admin','support')  (creators are KEPT, exactly as the PG
 *   forecast SQL does) + the dynamic `excluded_users` blacklist. This is the
 *   admin/support-only scope, NOT `customerScopeCte` (which would also drop
 *   creators) — using that here would be a scope change.
 *
 * The 60-day cutoff mirrors the PG `NOW() - INTERVAL '60 days'`; the caller
 * supplies a single `now` so the PG and CH windows align (prod runs UTC, so an
 * N-day interval is exactly N*24h). Money stays Decimal end-to-end
 * (`toString(sum(abs(...)))` in SQL → `toNumber()` in TS, never Float). The
 * blacklist is passed IN by the caller so this module never imports a
 * Postgres/Prisma client (directly or transitively) — it is a pure ClickHouse
 * read.
 */

// Mirrors `HISTORY_DAYS` in the PG twin (forecasting.ts). Inlined — that module
// value-imports the Postgres client, so importing the constant from it would
// drag Prisma across the CQRS boundary.
export const FORECAST_HISTORY_DAYS = 60;

// The canonical reward ledger types the forecast trends, mirroring
// `ALL_REWARD_TYPES_SQL` in the PG twin. `rain_tip` is included so the per-day
// rain house slice can be netted downstream; `creator_tip` is excluded (it is a
// RESIDUAL pass-through, not a house cost).
const ALL_REWARD_TYPES = [
  "deposit_bonus",
  "promo_code_redeemed",
  "gift_card_redeemed",
  "rakeback_claim",
  "affiliate_claim",
  "rain_win",
  "rain_tip",
  "race_prize",
  "balance_reward_claim",
  "waitlist_prize",
] as const;

/**
 * One raw aggregate row — the exact shape the PG `$queryRawUnsafe` yields before
 * the shared TS projection layer runs. `category` is one of the six forecast
 * keys (`bonuses` / `rakeback` / `affiliate` / `rainRace` / `signupPack` /
 * `waitlist`) OR the `__rain_win` / `__rain_tip` per-day pseudo-buckets.
 */
export type ForecastAggregateRow = {
  /** 'YYYY-MM-DD' (UTC) — `toDate(created_at)`, matching PG `DATE(created_at)`. */
  date: string;
  category: string;
  total: number;
};

type RawRow = { date: string; category: string; total: string };

/**
 * The per-category mapping — mirrors the PG `CASE` EXACTLY. `rain_win` /
 * `rain_tip` stay as separate per-day pseudo-buckets (`__rain_win` /
 * `__rain_tip`) so the shared projection can net the day's rain house slice
 * before folding it into `rainRace`.
 */
const CATEGORY_EXPR = `multiIf(
    lt.type IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed'), 'bonuses',
    lt.type = 'rakeback_claim', 'rakeback',
    lt.type = 'affiliate_claim', 'affiliate',
    lt.type = 'race_prize', 'rainRace',
    lt.type = 'rain_win', '__rain_win',
    lt.type = 'rain_tip', '__rain_tip',
    lt.type = 'balance_reward_claim', 'signupPack',
    lt.type = 'waitlist_prize', 'waitlist',
    ''
  )`;

export async function getRewardsForecastingAggregatesFromClickHouse(
  blacklist: string[],
  now: Date = new Date(),
): Promise<ForecastAggregateRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = chDateTime(
    new Date(now.getTime() - FORECAST_HISTORY_DAYS * 24 * 60 * 60 * 1000),
  );
  const params: Record<string, unknown> = {
    cutoff,
    rewardTypes: ALL_REWARD_TYPES,
    blacklist,
  };

  const rows = await clickhouseRead.query<RawRow>({
    queryName: "insights.forecast.aggregates",
    sql: `
      WITH real_users AS (
        SELECT id
        FROM ${CH_DB}.public_user FINAL
        WHERE _peerdb_is_deleted = 0
          AND role NOT IN ('admin','support')
          ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
      )
      SELECT
        toString(toDate(lt.created_at)) AS date,
        ${CATEGORY_EXPR}                AS category,
        toString(sum(abs(lt.amount)))   AS total
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type IN {rewardTypes:Array(String)}
        AND lt.created_at >= {cutoff:DateTime64(6)}
        AND lt.user_id IN (SELECT id FROM real_users)
      GROUP BY date, category
      ORDER BY date ASC`,
    params,
  });

  return rows.map((r) => ({
    date: r.date,
    category: r.category,
    total: toNumber(r.total),
  }));
}
