import "server-only";

import { getBattleTestDevReadDrizzleDb } from "@/lib/battle-test-dev-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import type { DbEnv } from "@/lib/db-env";
import { queryRowsInTimeboxedTx } from "@/lib/drizzle-query";
import { calculateCreatorBattleOutcome } from "@/lib/eos/creator-outcome";
import type { EosObservedCreatorBattle } from "@/lib/eos-user-history-shared";

type BattleRow = {
  battle_id: string;
  creator_user_id: string;
  creator_username: string | null;
  created_at: Date | string;
  mode: string;
  currency: string;
  status: string;
  creator_team: number;
  winner_team: number | null;
  bet_amount: string;
  sponsorship_paid: string;
  borrow_percentage: string;
  total_unpacked: string | null;
  winning_team_size: string;
};

function finiteNumber(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapBattleRows(
  environment: DbEnv,
  rows: BattleRow[],
): EosObservedCreatorBattle[] {
  return rows.map((row) => {
    const betAmount = finiteNumber(row.bet_amount);
    const borrowPercentage = finiteNumber(row.borrow_percentage);
    const creatorPaidStake = betAmount * (1 - Math.min(100, Math.max(0, borrowPercentage)) / 100);
    const creatorWonBattle = row.winner_team === null
      ? null
      : row.creator_team === row.winner_team;
    const outcome = calculateCreatorBattleOutcome({
      creatorWon: creatorWonBattle,
      creatorPaidStake,
      creatorBorrowPercentage: borrowPercentage,
      sponsorshipAmountPaid: finiteNumber(row.sponsorship_paid),
      totalUnpacked: row.total_unpacked === null
        ? null
        : finiteNumber(row.total_unpacked),
      winningTeamSize: finiteNumber(row.winning_team_size),
    });
    const creatorCost = outcome.stakeAmount + outcome.sponsorshipCost;

    return {
      environment,
      battleId: row.battle_id,
      creatorUserId: row.creator_user_id,
      creatorUsername: row.creator_username,
      createdAt: new Date(row.created_at).toISOString(),
      mode: row.mode,
      currency: row.currency,
      status: row.status,
      creatorTeam: row.creator_team,
      winnerTeam: row.winner_team,
      creatorWonBattle,
      creatorCost,
      creatorPayout: outcome.payoutAmount,
      creatorProfitLoss: outcome.netAmount,
      creatorMultiplier: outcome.payoutAmount === null || creatorCost <= 0
        ? null
        : outcome.payoutAmount / creatorCost,
    };
  });
}

export async function getEosObservedCreatorBattles(
  environment: DbEnv,
  userId: string,
  limit = 30,
): Promise<EosObservedCreatorBattle[]> {
  const db = environment === "prod"
    ? getProdReadDrizzleDb()
    : getBattleTestDevReadDrizzleDb();
  const boundedLimit = Math.max(1, Math.min(50, limit));
  const rows = await queryRowsInTimeboxedTx(db, 8_000, (query) =>
    query<BattleRow[]>(`
      SELECT b.id::text AS battle_id, b.user_id::text AS creator_user_id,
             COALESCE(NULLIF(BTRIM(u.display_username), ''), NULLIF(BTRIM(u.username), '')) AS creator_username,
             b.created_at,
             b.mode::text, b.currency::text, b.status::text,
             creator.team_number AS creator_team,
             b.winner_team,
             b.bet_amount::text,
             b.sponsorship_amount_paid::text AS sponsorship_paid,
             creator.borrow_percentage::text,
             b.total_unpacked::text,
             COALESCE(winners.member_count, 0)::text AS winning_team_size
      FROM battles b
      JOIN "user" u ON u.id = b.user_id
      JOIN LATERAL (
        SELECT bp.team_number, bp.borrow_percentage
        FROM battle_participants bp
        WHERE bp.battle_id = b.id
          AND bp.user_id = b.user_id
          AND bp.bot_id IS NULL
        ORDER BY bp.created_at, bp.id
        LIMIT 1
      ) creator ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS member_count
        FROM battle_participants bp
        WHERE bp.battle_id = b.id
          AND bp.team_number = b.winner_team
      ) winners ON b.winner_team IS NOT NULL
      WHERE b.user_id = $1
        AND b.eos_block_hash IS NOT NULL
        AND b.currency::text = 'real'
        AND b.created_at >= now() - interval '30 days'
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $2
    `, userId, boundedLimit));

  return mapBattleRows(environment, rows);
}

export async function getRecentEosObservedBattles(
  environment: DbEnv,
  limit = 50,
): Promise<EosObservedCreatorBattle[]> {
  const db = environment === "prod"
    ? getProdReadDrizzleDb()
    : getBattleTestDevReadDrizzleDb();
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const rows = await queryRowsInTimeboxedTx(db, 8_000, (query) =>
    query<BattleRow[]>(`
      SELECT b.id::text AS battle_id, b.user_id::text AS creator_user_id,
             COALESCE(NULLIF(BTRIM(u.display_username), ''), NULLIF(BTRIM(u.username), '')) AS creator_username,
             b.created_at, b.mode::text, b.currency::text, b.status::text,
             creator.team_number AS creator_team, b.winner_team,
             b.bet_amount::text, b.sponsorship_amount_paid::text AS sponsorship_paid,
             creator.borrow_percentage::text, b.total_unpacked::text,
             COALESCE(winners.member_count, 0)::text AS winning_team_size
      FROM battles b
      JOIN "user" u ON u.id = b.user_id
      JOIN LATERAL (
        SELECT bp.team_number, bp.borrow_percentage
        FROM battle_participants bp
        WHERE bp.battle_id = b.id
          AND bp.user_id = b.user_id
          AND bp.bot_id IS NULL
        ORDER BY bp.created_at, bp.id
        LIMIT 1
      ) creator ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS member_count
        FROM battle_participants bp
        WHERE bp.battle_id = b.id
          AND bp.team_number = b.winner_team
      ) winners ON b.winner_team IS NOT NULL
      WHERE b.eos_block_hash IS NOT NULL
        AND b.currency::text = 'real'
        AND b.created_at >= now() - interval '30 days'
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $1
    `, boundedLimit));
  return mapBattleRows(environment, rows);
}
