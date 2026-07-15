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
  /**
   * Whether the battle's CREATOR won (their team === winner_team) — house
   * POV: creator won = house paid out = house lost money; creator lost =
   * house kept the pot. Null when the creator isn't found among the
   * battle's own participants (shouldn't happen for a completed battle,
   * but the join is defensive) or `winnerTeam` is null.
   */
  creatorWon: boolean | null;
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
        user_id: true,
        mode: true,
        teams: true,
        players_per_team: true,
        bet_amount: true,
        winner_team: true,
        created_at: true,
        user: { select: { username: true } },
        battle_participants: { select: { user_id: true, team_number: true } },
      },
    }),
    db.battles.count({ where: { status: "completed" } }),
  ]);

  return {
    items: rows.map((b) => {
      const creatorTeam = b.battle_participants.find(
        (p) => p.user_id === b.user_id,
      )?.team_number;
      const creatorWon =
        creatorTeam != null && b.winner_team != null
          ? creatorTeam === b.winner_team
          : null;

      return {
        id: b.id,
        creatorUsername: b.user?.username ?? null,
        mode: b.mode,
        teams: b.teams,
        playersPerTeam: b.players_per_team,
        betAmount: toNumber(b.bet_amount),
        winnerTeam: b.winner_team,
        participantCount: b.battle_participants.length,
        creatorWon,
        createdAt: b.created_at.toISOString(),
      };
    }),
    total,
  };
}

/**
 * A single battle's stored `eos_block_hash`, by id — backs the on-demand
 * EOS block lookup behind the battle-row expand action. Returns `null`
 * when `battleId` isn't a real battle (including a malformed/non-UUID id
 * — guarded before hitting Postgres so a bad id can't throw `22P02
 * invalid input syntax for type uuid`).
 */
export async function getBattleEosBlockHash(
  battleId: string,
): Promise<{ eosBlockHash: string | null } | null> {
  if (!isUuid(battleId)) return null;
  const db = await getDb();

  const battle = await db.battles.findUnique({
    where: { id: battleId },
    select: { eos_block_hash: true },
  });
  if (!battle) return null;

  return { eosBlockHash: battle.eos_block_hash };
}
