import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { isUuid } from "@/lib/utils/ids";

export type EosBattleSummary = {
  id: string;
  creatorUsername: string | null;
  mode: string;
  teams: number;
  playersPerTeam: number;
  betAmount: number;
  winnerTeam: number | null;
  participantCount: number;
  createdAt: string;
};

/**
 * Latest COMPLETED battles, newest first. Scoped to `status = 'completed'`
 * (the only status that ever has a resolved `eos_block_hash` to verify) —
 * this also happens to be exactly the leading predicate of the existing
 * `idx_battles_status_created_at` index, so both the page query and the
 * count query plan as an Index (Only) Scan (verified read-only via EXPLAIN,
 * 2026-07-15). No new index needed.
 */
export async function getRecentCompletedBattles(params: {
  page?: number;
  perPage?: number;
}): Promise<{ items: EosBattleSummary[]; total: number }> {
  const { page = 1, perPage = 5 } = params;
  const db = await getDb();

  const [rows, total] = await Promise.all([
    db.battles.findMany({
      where: { status: "completed" },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        mode: true,
        teams: true,
        players_per_team: true,
        bet_amount: true,
        winner_team: true,
        created_at: true,
        user: { select: { username: true } },
        _count: { select: { battle_participants: true } },
      },
    }),
    db.battles.count({ where: { status: "completed" } }),
  ]);

  return {
    items: rows.map((b) => ({
      id: b.id,
      creatorUsername: b.user?.username ?? null,
      mode: b.mode,
      teams: b.teams,
      playersPerTeam: b.players_per_team,
      betAmount: toNumber(b.bet_amount),
      winnerTeam: b.winner_team,
      participantCount: b._count.battle_participants,
      createdAt: b.created_at.toISOString(),
    })),
    total,
  };
}

export type EosParticipant = {
  id: string;
  userId: string | null;
  username: string | null;
  isBot: boolean;
  teamNumber: number;
  teamPosition: number;
  clientSeed: string;
};

/**
 * A single battle's stored `eos_block_hash` plus every participant (real
 * users AND bots, both teams) — not just the battle's creator. Participant
 * lookup is by `battle_id`, backed by `idx_battle_participants_battle_id`
 * (verified read-only via EXPLAIN: Bitmap Index Scan, 2026-07-15).
 *
 * Returns `null` when `battleId` isn't a real battle (including a
 * malformed/non-UUID id — guarded before hitting Postgres so a bad id
 * can't throw `22P02 invalid input syntax for type uuid`).
 */
export async function getBattleParticipantsForVerification(
  battleId: string,
): Promise<{ eosBlockHash: string | null; participants: EosParticipant[] } | null> {
  if (!isUuid(battleId)) return null;
  const db = await getDb();

  const battle = await db.battles.findUnique({
    where: { id: battleId },
    select: { eos_block_hash: true },
  });
  if (!battle) return null;

  const participants = await db.battle_participants.findMany({
    where: { battle_id: battleId },
    orderBy: [{ team_number: "asc" }, { team_position: "asc" }],
    select: {
      id: true,
      user_id: true,
      bot_id: true,
      team_number: true,
      team_position: true,
      client_seed: true,
      user: { select: { username: true } },
      bots: { select: { username: true } },
    },
  });

  return {
    eosBlockHash: battle.eos_block_hash,
    participants: participants.map((p) => ({
      id: p.id,
      userId: p.user_id,
      username: p.user?.username ?? p.bots?.username ?? null,
      isBot: p.bot_id !== null,
      teamNumber: p.team_number,
      teamPosition: p.team_position,
      clientSeed: p.client_seed,
    })),
  };
}
