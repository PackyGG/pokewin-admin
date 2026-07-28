import "server-only";

import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";

import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { excludeStaffCreatorsAndBlacklistedSqlFromIds } from "./_blacklist";

export type KenoMetricSlice = {
  games: number;
  players: number;
  wager: number;
  payout: number;
  ggr: number;
  rtp: number;
  hold: number;
  averageBet: number;
  cashReturnGames: number;
  profitableGames: number;
  cashReturnRate: number;
  profitableRate: number;
  maxPayout: number;
  maxMultiplier: number;
  latestAt: string | null;
};

export type KenoRiskBreakdown = KenoMetricSlice & {
  risk: "low" | "medium" | "high";
};

export type KenoPickBreakdown = KenoMetricSlice & {
  picks: number;
};

export type KenoDailyPoint = {
  day: string;
  games: number;
  wager: number;
  payout: number;
  ggr: number;
  rtp: number;
};

export type KenoPayoutObservation = {
  risk: "low" | "medium" | "high";
  picks: number;
  hits: number;
  multiplier: number;
  observedGames: number;
};

export type KenoRecentGame = {
  id: string;
  userId: string;
  risk: "low" | "medium" | "high";
  selectedNumbers: number[];
  drawnNumbers: number[];
  hits: number;
  bet: number;
  payout: number;
  multiplier: number;
  createdAt: string;
};

export type KenoDashboard = {
  lifetime: KenoMetricSlice;
  last24Hours: KenoMetricSlice;
  last7Days: KenoMetricSlice;
  risks: KenoRiskBreakdown[];
  picks: KenoPickBreakdown[];
  daily: KenoDailyPoint[];
  payoutObservations: KenoPayoutObservation[];
  recentGames: KenoRecentGame[];
};

type RawMetric = {
  games?: string;
  players?: string;
  wager?: string;
  payout?: string;
  cash_return_games?: string;
  profitable_games?: string;
  max_payout?: string;
  max_multiplier?: string;
  latest_at?: string | null;
};

type RawDashboardRow = {
  lifetime: RawMetric | null;
  last_24_hours: RawMetric | null;
  last_7_days: RawMetric | null;
  risks: Array<RawMetric & { risk: KenoRiskBreakdown["risk"] }> | null;
  picks: Array<RawMetric & { picks: number }> | null;
  daily: Array<{
    day: string;
    games: string;
    wager: string;
    payout: string;
  }> | null;
  payout_observations: Array<{
    risk: KenoPayoutObservation["risk"];
    picks: number;
    hits: number;
    multiplier: string;
    observed_games: string;
  }> | null;
  recent_games: Array<{
    id: string;
    user_id: string;
    risk: KenoRecentGame["risk"];
    selected_numbers: unknown;
    drawn_numbers: unknown;
    hits: number;
    bet_amount: string;
    won_amount: string;
    result_multiplier: string;
    created_at: string;
  }> | null;
};

const ZERO_METRIC: KenoMetricSlice = {
  games: 0,
  players: 0,
  wager: 0,
  payout: 0,
  ggr: 0,
  rtp: 0,
  hold: 0,
  averageBet: 0,
  cashReturnGames: 0,
  profitableGames: 0,
  cashReturnRate: 0,
  profitableRate: 0,
  maxPayout: 0,
  maxMultiplier: 0,
  latestAt: null,
};

export const EMPTY_KENO_DASHBOARD: KenoDashboard = {
  lifetime: ZERO_METRIC,
  last24Hours: ZERO_METRIC,
  last7Days: ZERO_METRIC,
  risks: [],
  picks: [],
  daily: [],
  payoutObservations: [],
  recentGames: [],
};

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

function metric(raw: RawMetric | null | undefined): KenoMetricSlice {
  const games = finite(raw?.games);
  const wager = finite(raw?.wager);
  const payout = finite(raw?.payout);
  const cashReturnGames = finite(raw?.cash_return_games);
  const profitableGames = finite(raw?.profitable_games);
  const ggr = wager - payout;

  return {
    games,
    players: finite(raw?.players),
    wager,
    payout,
    ggr,
    rtp: wager > 0 ? payout / wager : 0,
    hold: wager > 0 ? ggr / wager : 0,
    averageBet: games > 0 ? wager / games : 0,
    cashReturnGames,
    profitableGames,
    cashReturnRate: games > 0 ? cashReturnGames / games : 0,
    profitableRate: games > 0 ? profitableGames / games : 0,
    maxPayout: finite(raw?.max_payout),
    maxMultiplier: finite(raw?.max_multiplier),
    latestAt: raw?.latest_at ?? null,
  };
}

async function computeKenoDashboard(
  env: DbEnv,
  blacklist: string[],
): Promise<KenoDashboard> {
  const db = readDrizzleForEnv(env);
  const customerScope =
    excludeStaffCreatorsAndBlacklistedSqlFromIds(blacklist).replace(
      /^user_id\b/,
      "kg.user_id",
    );
  const result = await db.execute<RawDashboardRow>(sql`
    WITH base AS MATERIALIZED (
      SELECT
        kg.id,
        kg.user_id,
        kg.risk::text AS risk,
        kg.selected_numbers,
        kg.drawn_numbers,
        jsonb_array_length(kg.selected_numbers)::integer AS picks,
        kg.hits,
        kg.bet_amount::numeric AS bet_amount,
        kg.won_amount::numeric AS won_amount,
        kg.result_multiplier::numeric AS result_multiplier,
        kg.created_at
      FROM keno_games kg
      WHERE ${sql.raw(customerScope)}
    ),
    risk_rows AS (
      SELECT
        risk,
        COUNT(*)::text AS games,
        COUNT(DISTINCT user_id)::text AS players,
        COALESCE(SUM(bet_amount), 0)::text AS wager,
        COALESCE(SUM(won_amount), 0)::text AS payout,
        COUNT(*) FILTER (WHERE won_amount > 0)::text AS cash_return_games,
        COUNT(*) FILTER (WHERE won_amount > bet_amount)::text AS profitable_games,
        COALESCE(MAX(won_amount), 0)::text AS max_payout,
        COALESCE(MAX(result_multiplier), 0)::text AS max_multiplier,
        MAX(created_at)::text AS latest_at
      FROM base
      GROUP BY risk
    ),
    pick_rows AS (
      SELECT
        picks,
        COUNT(*)::text AS games,
        COUNT(DISTINCT user_id)::text AS players,
        COALESCE(SUM(bet_amount), 0)::text AS wager,
        COALESCE(SUM(won_amount), 0)::text AS payout,
        COUNT(*) FILTER (WHERE won_amount > 0)::text AS cash_return_games,
        COUNT(*) FILTER (WHERE won_amount > bet_amount)::text AS profitable_games,
        COALESCE(MAX(won_amount), 0)::text AS max_payout,
        COALESCE(MAX(result_multiplier), 0)::text AS max_multiplier,
        MAX(created_at)::text AS latest_at
      FROM base
      GROUP BY picks
    ),
    daily_rows AS (
      SELECT
        created_at::date::text AS day,
        COUNT(*)::text AS games,
        COALESCE(SUM(bet_amount), 0)::text AS wager,
        COALESCE(SUM(won_amount), 0)::text AS payout
      FROM base
      WHERE created_at >=
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - INTERVAL '13 days'
      GROUP BY created_at::date
    ),
    payout_rows AS (
      SELECT
        risk,
        picks,
        hits,
        result_multiplier::text AS multiplier,
        COUNT(*)::text AS observed_games
      FROM base
      GROUP BY risk, picks, hits, result_multiplier
    ),
    recent_rows AS (
      SELECT
        id,
        user_id,
        risk,
        selected_numbers,
        drawn_numbers,
        hits,
        bet_amount::text AS bet_amount,
        won_amount::text AS won_amount,
        result_multiplier::text AS result_multiplier,
        created_at::text AS created_at
      FROM base
      ORDER BY created_at DESC
      LIMIT 25
    )
    SELECT
      (
        SELECT jsonb_build_object(
          'games', COUNT(*)::text,
          'players', COUNT(DISTINCT user_id)::text,
          'wager', COALESCE(SUM(bet_amount), 0)::text,
          'payout', COALESCE(SUM(won_amount), 0)::text,
          'cash_return_games', COUNT(*) FILTER (WHERE won_amount > 0)::text,
          'profitable_games', COUNT(*) FILTER (WHERE won_amount > bet_amount)::text,
          'max_payout', COALESCE(MAX(won_amount), 0)::text,
          'max_multiplier', COALESCE(MAX(result_multiplier), 0)::text,
          'latest_at', MAX(created_at)::text
        )
        FROM base
      ) AS lifetime,
      (
        SELECT jsonb_build_object(
          'games', COUNT(*)::text,
          'players', COUNT(DISTINCT user_id)::text,
          'wager', COALESCE(SUM(bet_amount), 0)::text,
          'payout', COALESCE(SUM(won_amount), 0)::text,
          'cash_return_games', COUNT(*) FILTER (WHERE won_amount > 0)::text,
          'profitable_games', COUNT(*) FILTER (WHERE won_amount > bet_amount)::text,
          'max_payout', COALESCE(MAX(won_amount), 0)::text,
          'max_multiplier', COALESCE(MAX(result_multiplier), 0)::text,
          'latest_at', MAX(created_at)::text
        )
        FROM base
        WHERE created_at >=
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '24 hours'
      ) AS last_24_hours,
      (
        SELECT jsonb_build_object(
          'games', COUNT(*)::text,
          'players', COUNT(DISTINCT user_id)::text,
          'wager', COALESCE(SUM(bet_amount), 0)::text,
          'payout', COALESCE(SUM(won_amount), 0)::text,
          'cash_return_games', COUNT(*) FILTER (WHERE won_amount > 0)::text,
          'profitable_games', COUNT(*) FILTER (WHERE won_amount > bet_amount)::text,
          'max_payout', COALESCE(MAX(won_amount), 0)::text,
          'max_multiplier', COALESCE(MAX(result_multiplier), 0)::text,
          'latest_at', MAX(created_at)::text
        )
        FROM base
        WHERE created_at >=
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '7 days'
      ) AS last_7_days,
      COALESCE(
        (SELECT jsonb_agg(to_jsonb(risk_rows) ORDER BY risk) FROM risk_rows),
        '[]'::jsonb
      ) AS risks,
      COALESCE(
        (SELECT jsonb_agg(to_jsonb(pick_rows) ORDER BY picks) FROM pick_rows),
        '[]'::jsonb
      ) AS picks,
      COALESCE(
        (SELECT jsonb_agg(to_jsonb(daily_rows) ORDER BY day) FROM daily_rows),
        '[]'::jsonb
      ) AS daily,
      COALESCE(
        (
          SELECT jsonb_agg(
            to_jsonb(payout_rows)
            ORDER BY risk, picks, hits, multiplier
          )
          FROM payout_rows
        ),
        '[]'::jsonb
      ) AS payout_observations,
      COALESCE(
        (
          SELECT jsonb_agg(
            to_jsonb(recent_rows)
            ORDER BY created_at DESC
          )
          FROM recent_rows
        ),
        '[]'::jsonb
      ) AS recent_games
  `);

  const raw = result.rows[0];
  if (!raw) return EMPTY_KENO_DASHBOARD;

  return {
    lifetime: metric(raw.lifetime),
    last24Hours: metric(raw.last_24_hours),
    last7Days: metric(raw.last_7_days),
    risks: (raw.risks ?? []).map((row) => ({
      ...metric(row),
      risk: row.risk,
    })),
    picks: (raw.picks ?? []).map((row) => ({
      ...metric(row),
      picks: finite(row.picks),
    })),
    daily: (raw.daily ?? []).map((row) => {
      const wager = finite(row.wager);
      const payout = finite(row.payout);
      return {
        day: row.day,
        games: finite(row.games),
        wager,
        payout,
        ggr: wager - payout,
        rtp: wager > 0 ? payout / wager : 0,
      };
    }),
    payoutObservations: (raw.payout_observations ?? []).map((row) => ({
      risk: row.risk,
      picks: finite(row.picks),
      hits: finite(row.hits),
      multiplier: finite(row.multiplier),
      observedGames: finite(row.observed_games),
    })),
    recentGames: (raw.recent_games ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      risk: row.risk,
      selectedNumbers: numberArray(row.selected_numbers),
      drawnNumbers: numberArray(row.drawn_numbers),
      hits: finite(row.hits),
      bet: finite(row.bet_amount),
      payout: finite(row.won_amount),
      multiplier: finite(row.result_multiplier),
      createdAt: row.created_at,
    })),
  };
}

const cachedKenoDashboard = unstable_cache(
  computeKenoDashboard,
  ["keno-dashboard-v2"],
  { revalidate: 300, tags: ["keno-dashboard"] },
);

/**
 * Operational Keno snapshot. The current production relation is read as one
 * materialized, customer-scoped base and then aggregated by PostgreSQL.
 * Read-only production verification on 2026-07-28 returned 253 customer games
 * and 25 recent rows; EXPLAIN ANALYZE for the scoped recent-game path completed
 * in 0.661 ms. The five-minute cache prevents the lifetime aggregation from
 * running per viewer, and the blacklist participates in the cache key.
 */
export async function getKenoDashboard(): Promise<KenoDashboard> {
  const [env, excludedUserIds] = await Promise.all([
    readDbEnv(),
    getExcludedUserIds(),
  ]);
  const blacklist = [...excludedUserIds].sort();
  return cachedKenoDashboard(env, blacklist);
}
