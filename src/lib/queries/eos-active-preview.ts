import { queryMainRows } from "@/lib/drizzle-query";
import { calculateCreatorBattleOutcome } from "@/lib/eos/creator-outcome";
import { postgresTimestampIso } from "@/lib/postgres-runtime";
import { requireOwner } from "@/lib/owners";
import { toNumber } from "@/lib/utils/decimal";

export type ActiveEosBattle = {
  id: string;
  creatorUsername: string | null;
  mode: string;
  teams: number;
  playersPerTeam: number;
  participantCount: number;
  status: "waiting" | "waiting_for_block" | "outcome_ready";
  currency: "real" | "coin";
  betAmount: number;
  eosBlockHash: string | null;
  winnerTeam: number | null;
  creatorTeam: number | null;
  creatorWon: boolean | null;
  totalUnpacked: number | null;
  winningTeamSize: number;
  creatorBorrowPercentage: number;
  creatorFillFunded: boolean;
  sponsorshipPercentage: number;
  stakeAmount: number;
  sponsorshipCost: number;
  payoutAmount: number | null;
  netAmount: number | null;
  createdAt: string;
};

type ActiveEosBattleRow = {
  id: string;
  creator_username: string | null;
  mode: string;
  teams: number;
  players_per_team: number;
  participant_count: number | string;
  database_status: "waiting" | "in_progress" | "animating";
  currency: "real" | "coin";
  bet_amount: string;
  eos_block_hash: string | null;
  winner_team: number | null;
  creator_team: number | null;
  creator_borrow_percentage: number | null;
  creator_paid_stake: string | null;
  creator_source_session_id: string | null;
  sponsorship_percentage: number | null;
  sponsorship_amount_paid: string | null;
  total_unpacked: string | null;
  winning_team_size: number | string;
  created_at: Date | string;
};

/**
 * Live battle rows only. Once the backend commits the EOS hash it also commits
 * the winner and total unpacked value in the same transaction, so those fields
 * are the canonical early outcome while the player-facing animation continues.
 */
export async function getActiveEosBattles(): Promise<ActiveEosBattle[]> {
  await requireOwner();

  const rows = await queryMainRows<ActiveEosBattleRow[]>(`
    SELECT
      b.id,
      u.username AS creator_username,
      b.mode::text AS mode,
      b.teams,
      b.players_per_team,
      COUNT(bp.id)::int AS participant_count,
      b.status::text AS database_status,
      b.currency::text AS currency,
      b.bet_amount::text,
      b.eos_block_hash,
      b.winner_team,
      creator.team_number AS creator_team,
      creator.borrow_percentage AS creator_borrow_percentage,
      creator.paid_stake::text AS creator_paid_stake,
      creator.source_session_id AS creator_source_session_id,
      b.sponsorship_percentage,
      b.sponsorship_amount_paid::text,
      b.total_unpacked::text,
      COUNT(bp.id) FILTER (WHERE bp.team_number = b.winner_team)::int
        AS winning_team_size,
      b.created_at
    FROM battles b
    LEFT JOIN "user" u ON u.id = b.user_id
    LEFT JOIN LATERAL (
      SELECT
        participant.team_number,
        participant.borrow_percentage,
        participant.source_session_id,
        session.bet_amount AS paid_stake
      FROM battle_participants participant
      JOIN game_sessions session ON session.id = participant.game_session_id
      WHERE participant.battle_id = b.id
        AND participant.user_id = b.user_id
      ORDER BY participant.created_at ASC
      LIMIT 1
    ) creator ON TRUE
    LEFT JOIN battle_participants bp ON bp.battle_id = b.id
    WHERE b.status IN ('waiting', 'in_progress', 'animating')
    GROUP BY
      b.id,
      u.username,
      creator.team_number,
      creator.borrow_percentage,
      creator.paid_stake,
      creator.source_session_id
    ORDER BY b.created_at DESC
    LIMIT 50
  `);

  return rows.map((row) => {
    const betAmount = toNumber(row.bet_amount);
    const creatorPaidStake = toNumber(row.creator_paid_stake ?? 0);
    const totalUnpacked =
      row.total_unpacked === null ? null : toNumber(row.total_unpacked);
    const winningTeamSize = Number(row.winning_team_size);
    const creatorBorrowPercentage = row.creator_borrow_percentage ?? 0;
    const sponsorshipCost = toNumber(row.sponsorship_amount_paid ?? 0);
    const outcomeReady =
      row.eos_block_hash !== null &&
      row.winner_team !== null &&
      row.creator_team !== null &&
      totalUnpacked !== null;
    const creatorWon = outcomeReady
      ? row.creator_team === row.winner_team
      : null;

    const financial = calculateCreatorBattleOutcome({
      creatorWon,
      creatorPaidStake,
      creatorBorrowPercentage,
      sponsorshipAmountPaid: sponsorshipCost,
      totalUnpacked,
      winningTeamSize,
    });

    return {
      id: row.id,
      creatorUsername: row.creator_username,
      mode: row.mode,
      teams: row.teams,
      playersPerTeam: row.players_per_team,
      participantCount: Number(row.participant_count),
      status: outcomeReady
        ? "outcome_ready"
        : row.database_status === "waiting"
          ? "waiting"
          : "waiting_for_block",
      currency: row.currency,
      betAmount,
      eosBlockHash: row.eos_block_hash,
      winnerTeam: row.winner_team,
      creatorTeam: row.creator_team,
      creatorWon,
      totalUnpacked,
      winningTeamSize,
      creatorBorrowPercentage,
      creatorFillFunded: row.creator_source_session_id !== null,
      sponsorshipPercentage: row.sponsorship_percentage ?? 0,
      stakeAmount: financial.stakeAmount,
      sponsorshipCost: financial.sponsorshipCost,
      payoutAmount: financial.payoutAmount,
      netAmount: row.currency === "real" ? financial.netAmount : null,
      createdAt: postgresTimestampIso(row.created_at, "battle.created_at"),
    };
  });
}
