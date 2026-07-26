import "server-only";

import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";

import { drizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";

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

export type KenoDashboard = {
  lifetime: KenoMetricSlice;
  last24Hours: KenoMetricSlice;
  last7Days: KenoMetricSlice;
  risks: KenoRiskBreakdown[];
  picks: KenoPickBreakdown[];
  daily: KenoDailyPoint[];
  payoutObservations: KenoPayoutObservation[];
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
};

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function computeKenoDashboard(env: DbEnv): Promise<KenoDashboard> {
  const db = drizzleForEnv(env);
  const result = await db.execute<RawDashboardRow>(sql`
    WITH base AS MATERIALIZED (
      SELECT
        user_id,
        risk::text AS risk,
        jsonb_array_length(selected_numbers)::integer AS picks,
        hits,
        bet_amount::numeric AS bet_amount,
        won_amount::numeric AS won_amount,
        result_multiplier::numeric AS result_multiplier,
        created_at
      FROM keno_games
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
      ) AS payout_observations
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
  };
}

const cachedKenoDashboard = unstable_cache(
  computeKenoDashboard,
  ["keno-dashboard-v1"],
  { revalidate: 300, tags: ["keno-dashboard"] },
);

/**
 * Operational Keno snapshot. The current production relation is deliberately
 * read as one materialized base and then aggregated in memory by PostgreSQL.
 * EXPLAIN ANALYZE on 2026-07-26 showed the planner-selected sequential scan
 * was optimal for the 431-row / 496 KiB table; the complete JSON aggregate
 * executed in 7.3 ms from warm buffers. The five-minute cache prevents that
 * lifetime scan from running per viewer.
 */
export async function getKenoDashboard(): Promise<KenoDashboard> {
  return cachedKenoDashboard(await readDbEnv());
}
