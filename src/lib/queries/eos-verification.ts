import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { isUuid } from "@/lib/utils/ids";
import type { BattleMode, SimParticipant, SimRound } from "@/lib/eos/battle-mode-sim";

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
  /** Total wagered across every seat — `betAmount × participantCount`. */
  totalPotUsd: number;
  /** 0–100. % of every participant's bet the house fronted (borrow). */
  borrowPercentage: number;
  /** USD the house fronted across the whole battle. 0 when not borrowed. */
  borrowedAmountUsd: number;
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
        borrow_percentage: true,
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

      const betAmount = toNumber(b.bet_amount);
      const participantCount = b.battle_participants.length;
      const totalPotUsd = betAmount * participantCount;
      const borrowPercentage = b.borrow_percentage ?? 0;
      const borrowedAmountUsd =
        borrowPercentage > 0 ? totalPotUsd * (borrowPercentage / 100) : 0;

      return {
        id: b.id,
        creatorUsername: b.user?.username ?? null,
        mode: b.mode,
        teams: b.teams,
        playersPerTeam: b.players_per_team,
        betAmount,
        winnerTeam: b.winner_team,
        participantCount,
        creatorWon,
        totalPotUsd,
        borrowPercentage,
        borrowedAmountUsd,
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

export type BattleSimulationContext = {
  battleId: string;
  mode: BattleMode;
  isCrazyMode: boolean;
  /** AES-256-GCM ciphertext — never decrypted here, only in the server action. */
  serverSeedEncrypted: string;
  /** The battle creator's team, for a "would the creator have won" read same as `EosBattleSummary.creatorWon`. Null if the creator isn't among the participants. */
  creatorTeam: number | null;
  /** The creator's own `borrow_percentage` — the house-fronted share of their stake is excluded from both their payout and their profit (mirrors settlement.service.ts's `calculateBorrowFactor`). 0 if the creator isn't among the participants. */
  creatorBorrowPercentage: number;
  /** Per-seat stake (`battles.bet_amount`) — what the creator personally wagered to enter. */
  betAmountUsd: number;
  participants: SimParticipant[];
  rounds: SimRound[];
};

/**
 * Everything needed to recompute what a battle's outcome WOULD have been for
 * a candidate EOS block hash — the battle's mode/settings, every
 * participant's team, and each round's pack cards (price/hp/weight) in the
 * exact order backend draws them (`pack_cards.order` ascending). Pure reads
 * only; `server_seed` comes back still encrypted, decrypted only inside the
 * "show result" server action right before use. Backs the EOS-verification
 * page's per-block "Show result" simulation, never eager-loaded for a whole
 * page of battles.
 */
export async function getBattleSimulationContext(
  battleId: string,
): Promise<BattleSimulationContext | null> {
  if (!isUuid(battleId)) return null;
  const db = await getDb();

  const battle = await db.battles.findUnique({
    where: { id: battleId },
    select: {
      user_id: true,
      mode: true,
      pack_ids: true,
      additional_settings: true,
      server_seed: true,
      bet_amount: true,
    },
  });
  if (!battle) return null;

  const participants = await db.battle_participants.findMany({
    where: { battle_id: battleId },
    select: { id: true, team_number: true, user_id: true, borrow_percentage: true },
  });

  const uniquePackIds = [...new Set(battle.pack_ids)];
  const packs = await db.packs.findMany({
    where: { id: { in: uniquePackIds } },
    select: {
      id: true,
      cards_per_open: true,
      pack_cards: {
        orderBy: { order: "asc" },
        select: {
          weight: true,
          cards: { select: { id: true, price: true, hp: true } },
        },
      },
    },
  });
  const packMap = new Map(packs.map((p) => [p.id, p]));

  const rounds: SimRound[] = [];
  for (const packId of battle.pack_ids) {
    const pack = packMap.get(packId);
    if (!pack) continue;
    rounds.push({
      cardsPerOpen: pack.cards_per_open,
      cards: pack.pack_cards.map((pc) => ({
        cardId: pc.cards.id,
        price: toNumber(pc.cards.price),
        hp: pc.cards.hp ?? 0,
        weight: pc.weight,
      })),
    });
  }

  const creatorParticipant = participants.find((p) => p.user_id === battle.user_id);

  return {
    battleId,
    mode: battle.mode as BattleMode,
    isCrazyMode: battle.additional_settings.includes("crazy_mode"),
    serverSeedEncrypted: battle.server_seed,
    creatorTeam: creatorParticipant?.team_number ?? null,
    creatorBorrowPercentage: creatorParticipant?.borrow_percentage ?? 0,
    betAmountUsd: toNumber(battle.bet_amount),
    participants: participants.map((p) => ({ id: p.id, teamNumber: p.team_number })),
    rounds,
  };
}
