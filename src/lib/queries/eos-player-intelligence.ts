import "server-only";

import { getBattleTestDevReadDrizzleDb } from "@/lib/battle-test-dev-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import type { DbEnv } from "@/lib/db-env";
import { queryRowsInTimeboxedTx } from "@/lib/drizzle-query";
import {
  eosPlayerIntelligenceInputSchema,
  type EosPlayerIntelligence,
  type EosPlayerIntelligenceInput,
} from "@/lib/eos-player-intelligence-shared";

type IntelligenceRow = {
  user_id: string;
  username: string | null;
  role: string;
  battle_count: string;
  wins: string;
  losses: string;
  win_rate: string;
  luck_eligible_battles: string;
  luck_wins: string;
  expected_wins: string;
  expected_win_rate: string;
  luck_score: string | null;
  total_creator_cost: string;
  average_creator_cost: string;
  largest_creator_cost: string;
  largest_pot_value: string;
  estimated_payout: string;
  estimated_net_pnl: string;
  last_battle_at: Date | string;
  matching_players: string;
  matching_battles: string;
};

const PERIOD_HOURS: Record<EosPlayerIntelligenceInput["period"], number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

const ORDER_BY: Record<EosPlayerIntelligenceInput["sort"], string> = {
  luck: "luck_score DESC NULLS LAST, luck_eligible_battles DESC, battle_count DESC",
  battles: "battle_count DESC, total_creator_cost DESC, luck_score DESC NULLS LAST",
  volume: "total_creator_cost DESC, battle_count DESC, luck_score DESC NULLS LAST",
  largest: "largest_creator_cost DESC, total_creator_cost DESC, battle_count DESC",
};

function number(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getEosPlayerIntelligence(
  environment: DbEnv,
  rawInput: EosPlayerIntelligenceInput,
): Promise<EosPlayerIntelligence> {
  const input = eosPlayerIntelligenceInputSchema.parse(rawInput);
  const db = environment === "prod"
    ? getProdReadDrizzleDb()
    : getBattleTestDevReadDrizzleDb();
  const rows = await queryRowsInTimeboxedTx(db, 12_000, (query) =>
    query<IntelligenceRow[]>(`
      WITH bounded_battles AS MATERIALIZED (
        SELECT b.id, b.user_id, b.mode::text AS mode, b.teams,
               b.players_per_team, b.bet_amount::numeric AS bet_amount,
               b.sponsorship_amount_paid::numeric AS sponsorship_paid,
               b.total_unpacked::numeric AS total_unpacked,
               b.winner_team, b.created_at
        FROM battles b
        WHERE b.status = 'completed'
          AND b.winner_team IS NOT NULL
          AND b.total_unpacked IS NOT NULL
          AND b.created_at >= now() - ($1::int * interval '1 hour')
          AND b.currency::text = $2
          AND b.bet_amount::numeric >= $3::numeric
      ), creator_battles AS (
        SELECT b.id, b.user_id,
               (creator.team_number = b.winner_team) AS creator_won,
               b.mode NOT IN ('group', 'jackpot') AS luck_eligible,
               1.0 / GREATEST(b.teams, 1)::numeric AS expected_probability,
               ROUND(
                 b.bet_amount * (1 - creator.borrow_percentage::numeric / 100)
                   + b.sponsorship_paid,
                 2
               ) AS creator_cost,
               b.bet_amount * b.teams * b.players_per_team AS pot_value,
               CASE WHEN creator.team_number = b.winner_team
                 THEN ROUND(
                   b.total_unpacked / GREATEST(winners.member_count, 1)
                     * (1 - creator.borrow_percentage::numeric / 100),
                   2
                 )
                 ELSE 0
               END AS estimated_payout,
               b.created_at
        FROM bounded_battles b
        JOIN LATERAL (
          SELECT bp.team_number, bp.borrow_percentage
          FROM battle_participants bp
          WHERE bp.battle_id = b.id
            AND bp.user_id = b.user_id
            AND bp.bot_id IS NULL
          ORDER BY bp.created_at, bp.id
          LIMIT 1
        ) creator ON true
        JOIN LATERAL (
          SELECT COUNT(*)::numeric AS member_count
          FROM battle_participants bp
          WHERE bp.battle_id = b.id
            AND bp.team_number = b.winner_team
        ) winners ON true
      ), stats AS (
        SELECT user_id,
               COUNT(*)::numeric AS battle_count,
               COUNT(*) FILTER (WHERE creator_won)::numeric AS wins,
               COUNT(*) FILTER (WHERE NOT creator_won)::numeric AS losses,
               COUNT(*) FILTER (WHERE luck_eligible)::numeric AS luck_eligible_battles,
               COUNT(*) FILTER (WHERE luck_eligible AND creator_won)::numeric AS luck_wins,
               COALESCE(SUM(expected_probability) FILTER (WHERE luck_eligible), 0) AS expected_wins,
               COALESCE(SUM(
                 expected_probability * (1 - expected_probability)
               ) FILTER (WHERE luck_eligible), 0) AS luck_variance,
               SUM(creator_cost) AS total_creator_cost,
               AVG(creator_cost) AS average_creator_cost,
               MAX(creator_cost) AS largest_creator_cost,
               MAX(pot_value) AS largest_pot_value,
               SUM(estimated_payout) AS estimated_payout,
               SUM(estimated_payout - creator_cost) AS estimated_net_pnl,
               MAX(created_at) AS last_battle_at
        FROM creator_battles
        GROUP BY user_id
      ), ranked AS (
        SELECT stats.*,
               wins / NULLIF(battle_count, 0) AS win_rate,
               expected_wins / NULLIF(luck_eligible_battles, 0) AS expected_win_rate,
               CASE WHEN luck_variance > 0
                 THEN (luck_wins - expected_wins) / SQRT(luck_variance)
                 ELSE NULL
               END AS luck_score
        FROM stats
        WHERE battle_count >= $4
      )
      SELECT ranked.user_id,
             COALESCE(u.display_username, u.username, u.name) AS username,
             u.role::text AS role,
             battle_count::text, wins::text, losses::text,
             COALESCE(win_rate, 0)::text AS win_rate,
             luck_eligible_battles::text, luck_wins::text,
             expected_wins::text,
             COALESCE(expected_win_rate, 0)::text AS expected_win_rate,
             luck_score::text,
             total_creator_cost::text, average_creator_cost::text,
             largest_creator_cost::text, largest_pot_value::text,
             estimated_payout::text, estimated_net_pnl::text,
             last_battle_at,
             COUNT(*) OVER()::text AS matching_players,
             SUM(battle_count) OVER()::text AS matching_battles
      FROM ranked
      JOIN "user" u ON u.id = ranked.user_id
      ORDER BY ${ORDER_BY[input.sort]}
      LIMIT $5
    `, PERIOD_HOURS[input.period], input.currency, input.minBattleValue,
    input.minBattles, input.limit));

  return {
    environment,
    generatedAt: new Date().toISOString(),
    period: input.period,
    currency: input.currency,
    sort: input.sort,
    minBattles: input.minBattles,
    matchingPlayers: number(rows[0]?.matching_players ?? "0"),
    matchingBattles: number(rows[0]?.matching_battles ?? "0"),
    rows: rows.map((row) => {
      const luckScore = row.luck_score === null ? null : number(row.luck_score);
      const luckEligibleBattles = number(row.luck_eligible_battles);
      const signal = luckEligibleBattles >= 10 && luckScore !== null
        ? luckScore >= 3.5
          ? "strong" as const
          : luckScore >= 2.5
            ? "elevated" as const
            : "none" as const
        : "none" as const;
      return {
        userId: row.user_id,
        username: row.username,
        role: row.role,
        battleCount: number(row.battle_count),
        wins: number(row.wins),
        losses: number(row.losses),
        winRate: number(row.win_rate),
        luckEligibleBattles,
        luckWins: number(row.luck_wins),
        expectedWins: number(row.expected_wins),
        expectedWinRate: number(row.expected_win_rate),
        luckScore,
        totalCreatorCost: number(row.total_creator_cost),
        averageCreatorCost: number(row.average_creator_cost),
        largestCreatorCost: number(row.largest_creator_cost),
        largestPotValue: number(row.largest_pot_value),
        estimatedPayout: number(row.estimated_payout),
        estimatedNetPnl: number(row.estimated_net_pnl),
        lastBattleAt: new Date(row.last_battle_at).toISOString(),
        signal,
      };
    }),
  };
}
