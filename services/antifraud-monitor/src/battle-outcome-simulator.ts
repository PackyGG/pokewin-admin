import { createDecipheriv, createHash, createHmac, hkdfSync } from "node:crypto";

import type pg from "pg";

import type { EosBlockCandidate } from "./eos-random-block-routes.js";

const MAX_TICKET = 1_000_000;

type BattleRow = {
  id: string;
  user_id: string;
  mode: string;
  pack_ids: string[];
  additional_settings: string[];
  bet_amount: string;
  currency: "real" | "coin";
  sponsorship_amount_paid: string;
  server_seed: string;
  server_seed_hash: string;
};

type ParticipantRow = {
  id: string;
  user_id: string | null;
  bot_id: string | null;
  team_number: number;
  team_position: number;
  borrow_percentage: number;
};

type PackRow = {
  id: string;
  name: string;
  image_url: string | null;
  cards_per_open: number;
};

type CardRow = {
  pack_id: string;
  card_id: string;
  weight: number;
  order: number;
  name: string;
  image_url: string;
  price: string;
  hp: number | null;
  rarity: string | null;
};

export type BattleCandidateOutcome = {
  blockNumber: number;
  blockHash: string;
  winningTeam: number;
  creatorTeam: number;
  creatorWonBattle: boolean;
  creatorCost: number;
  creatorPayout: number;
  creatorProfitLoss: number;
  creatorMoneyResult: "profit" | "loss" | "break_even";
  creatorAmount: number;
};

export type BattleOutcomeSimulation = {
  battleId: string;
  mode: "normal" | "jackpot" | "group" | "hp_rush" | "lowest";
  crazyMode: boolean;
  currency: "real" | "coin";
  creatorUserID: string;
  outcomes: BattleCandidateOutcome[];
};

export interface BattleOutcomeSource {
  simulate(
    userID: string,
    battleID: string,
    candidates: EosBlockCandidate[],
  ): Promise<BattleOutcomeSimulation>;
}

export class BattleSimulationError extends Error {
  constructor(
    readonly code:
      | "battle_not_found"
      | "battle_data_incomplete"
      | "battle_mode_not_supported"
      | "battle_seed_invalid",
    readonly status: 404 | 409 | 422 | 503,
  ) {
    super(code);
    this.name = "BattleSimulationError";
  }
}

function decryptServerSeed(encrypted: string, pepper: string): string {
  const v2 = encrypted.startsWith("v2:");
  const data = Buffer.from(v2 ? encrypted.slice(3) : encrypted, "base64");
  if (data.length <= 28) throw new Error("Invalid encrypted seed");
  const key = v2
    ? Buffer.from(hkdfSync(
        "sha256",
        pepper,
        Buffer.from("packy-server-seed-encryption", "utf8"),
        Buffer.from("aes-256-gcm-key", "utf8"),
        32,
      ))
    : createHash("sha256").update(pepper).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(12, data.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

function ticketFor(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  cursor: number,
): number {
  const hash = createHmac("sha256", serverSeed)
    .update(`${clientSeed}:${nonce}:${cursor}`)
    .digest("hex");
  return Number((BigInt(`0x${hash}`) % BigInt(MAX_TICKET)) + 1n);
}

function selectedCard(ticket: number, cards: CardRow[]): CardRow {
  const totalWeight = cards.reduce((sum, card) => sum + Number(card.weight), 0);
  if (totalWeight <= 0) throw new Error("Pack has no positive card weight");
  let cumulativeWeight = 0;
  for (const card of cards) {
    cumulativeWeight += Number(card.weight);
    const boundary = Math.floor((cumulativeWeight / totalWeight) * MAX_TICKET);
    if (ticket <= boundary) return card;
  }
  return cards[cards.length - 1]!;
}

function roundedMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

type ModeResolution = {
  winnerTeam: number;
  scores: Map<number, number>;
};

function resolveScoreWinner(
  teamScores: Map<number, number>,
  crazyMode: boolean,
  serverSeed: string,
  blockHash: string,
  battleId: string,
  nonce: number,
): ModeResolution {
  const rounded = [...teamScores.entries()].map(([team, score]) => ({
    team,
    score: roundedMoney(score),
  }));
  const target = crazyMode
    ? Math.min(...rounded.map((entry) => entry.score))
    : Math.max(...rounded.map((entry) => entry.score));
  const tied = rounded
    .filter((entry) => entry.score === target)
    .map((entry) => entry.team)
    .sort((left, right) => left - right);
  if (tied.length === 1) {
    return {
      winnerTeam: tied[0]!,
      scores: teamScores,
    };
  }
  const ticket = ticketFor(
    serverSeed,
    `${blockHash}:tiebreaker:${battleId}`,
    nonce,
    0,
  );
  const segmentSize = Math.floor(MAX_TICKET / tied.length);
  return {
    winnerTeam:
      tied[Math.min(Math.floor((ticket - 1) / segmentSize), tied.length - 1)]!,
    scores: teamScores,
  };
}

type PulledParticipant = {
  participantId: string;
  userID: string | null;
  botId: string | null;
  teamNumber: number;
  teamPosition: number;
  totalValue: number;
  rounds: Array<{
    round: number;
    packId: string;
    packName: string;
    cards: Array<{
      cardId: string;
      name: string;
      imageUrl: string;
      price: number;
      hp: number;
      rarity: string | null;
      ticket: number;
    }>;
  }>;
};

function participantValue(participant: PulledParticipant): number {
  return participant.rounds.reduce(
    (sum, round) => sum + round.cards.reduce(
      (roundSum, card) => roundSum + card.price,
      0,
    ),
    0,
  );
}

function valueScores(participants: PulledParticipant[]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const participant of participants) {
    scores.set(
      participant.teamNumber,
      (scores.get(participant.teamNumber) ?? 0) + participant.totalValue,
    );
  }
  return scores;
}

function resolveMode(input: {
  mode: BattleOutcomeSimulation["mode"];
  crazyMode: boolean;
  participants: PulledParticipant[];
  valueScores: Map<number, number>;
  serverSeed: string;
  blockHash: string;
  battleId: string;
  nonce: number;
}): ModeResolution {
  if (input.mode === "group") {
    return {
      winnerTeam: 1,
      scores: input.valueScores,
    };
  }
  if (input.mode === "normal") {
    return resolveScoreWinner(
      input.valueScores,
      input.crazyMode,
      input.serverSeed,
      input.blockHash,
      input.battleId,
      input.nonce,
    );
  }
  if (input.mode === "hp_rush") {
    const hpScores = new Map<number, number>();
    for (const participant of input.participants) {
      const hp = participant.rounds.reduce(
        (sum, round) => sum + round.cards.reduce(
          (roundSum, card) => roundSum + card.hp,
          0,
        ),
        0,
      );
      hpScores.set(
        participant.teamNumber,
        (hpScores.get(participant.teamNumber) ?? 0) + hp,
      );
    }
    const resolved = resolveScoreWinner(
      hpScores,
      input.crazyMode,
      input.serverSeed,
      input.blockHash,
      input.battleId,
      input.nonce,
    );
    return resolved;
  }
  if (input.mode === "lowest") {
    const points = new Map<number, number>();
    for (const participant of input.participants) {
      points.set(participant.teamNumber, 0);
    }
    const roundCount = input.participants[0]?.rounds.length ?? 0;
    for (let round = 0; round < roundCount; round += 1) {
      let bestTicket = input.crazyMode ? 0 : MAX_TICKET + 1;
      let roundWinner: number | null = null;
      for (const participant of input.participants) {
        for (const card of participant.rounds[round]?.cards ?? []) {
          const better = input.crazyMode
            ? card.ticket > bestTicket
            : card.ticket < bestTicket;
          if (better) {
            bestTicket = card.ticket;
            roundWinner = participant.teamNumber;
          }
        }
      }
      if (roundWinner !== null) {
        points.set(roundWinner, (points.get(roundWinner) ?? 0) + 1);
      }
    }
    const resolved = resolveScoreWinner(
      points,
      false,
      input.serverSeed,
      input.blockHash,
      input.battleId,
      input.nonce,
    );
    return resolved;
  }

  const sortedTeams = [...input.valueScores.keys()].sort((a, b) => a - b);
  const percentages = new Map<number, number>();
  if (input.crazyMode) {
    const weights = new Map(sortedTeams.map((team) => [team, 0]));
    for (const participant of input.participants) {
      const value = participantValue(participant);
      weights.set(
        participant.teamNumber,
        (weights.get(participant.teamNumber) ?? 0) + (value > 0 ? 1 / value : 1),
      );
    }
    const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
    for (const team of sortedTeams) {
      percentages.set(team, (weights.get(team) ?? 0) / totalWeight);
    }
  } else {
    const totalValue = [...input.valueScores.values()]
      .reduce((sum, value) => sum + value, 0);
    for (const team of sortedTeams) {
      percentages.set(
        team,
        totalValue > 0
          ? (input.valueScores.get(team) ?? 0) / totalValue
          : 1 / sortedTeams.length,
      );
    }
  }
  const ticket = ticketFor(
    input.serverSeed,
    `${input.blockHash}:jackpot:${input.battleId}`,
    input.nonce,
    0,
  );
  let start = 1;
  let winner = sortedTeams[0]!;
  for (let index = 0; index < sortedTeams.length; index += 1) {
    const team = sortedTeams[index]!;
    const end = index === sortedTeams.length - 1
      ? MAX_TICKET
      : start + Math.floor(MAX_TICKET * (percentages.get(team) ?? 0)) - 1;
    if (ticket >= start && ticket <= end) winner = team;
    start = end + 1;
  }
  return {
    winnerTeam: winner,
    scores: input.valueScores,
  };
}

export function simulateBattle(input: {
  battle: BattleRow;
  participants: ParticipantRow[];
  packs: PackRow[];
  cardsByPack: Map<string, CardRow[]>;
  userID: string;
  candidates: EosBlockCandidate[];
  serverSeed: string;
}): BattleOutcomeSimulation {
  const creatorParticipant = input.participants.find(
    (participant) => participant.user_id === input.battle.user_id,
  );
  if (
    input.userID !== input.battle.user_id
    || !creatorParticipant
    || input.participants.length === 0
  ) {
    throw new BattleSimulationError("battle_data_incomplete", 409);
  }
  const mode = input.battle.mode as BattleOutcomeSimulation["mode"];
  if (!["normal", "jackpot", "group", "hp_rush", "lowest"].includes(mode)) {
    throw new BattleSimulationError("battle_mode_not_supported", 422);
  }
  const crazyMode = input.battle.additional_settings.includes("crazy_mode");
  const outcomes = input.candidates.map((candidate) => {
    const participants = input.participants.map((participant) => {
      const rounds = input.packs.map((pack, round) => {
        const pool = input.cardsByPack.get(pack.id) ?? [];
        if (pool.length === 0) {
          throw new BattleSimulationError("battle_data_incomplete", 409);
        }
        const clientSeed = `${candidate.blockHash}:${participant.id}`;
        const cards = Array.from({ length: pack.cards_per_open }, (_, cursor) => {
          const ticket = ticketFor(input.serverSeed, clientSeed, round, cursor);
          const card = selectedCard(ticket, pool);
          return {
            cardId: card.card_id,
            name: card.name,
            imageUrl: card.image_url,
            price: Number(card.price),
            hp: card.hp ?? 0,
            rarity: card.rarity,
            ticket,
          };
        });
        return { round, packId: pack.id, packName: pack.name, cards };
      });
      const totalValue = rounds.reduce(
        (sum, round) => sum + round.cards.reduce(
          (roundSum, card) => roundSum + card.price,
          0,
        ),
        0,
      );
      return {
        participantId: participant.id,
        userID: participant.user_id,
        botId: participant.bot_id,
        teamNumber: participant.team_number,
        teamPosition: participant.team_position,
        totalValue: roundedMoney(totalValue),
        rounds,
      };
    });
    const values = valueScores(participants);
    const resolved = resolveMode({
      mode,
      crazyMode,
      participants,
      valueScores: values,
      serverSeed: input.serverSeed,
      blockHash: candidate.blockHash,
      battleId: input.battle.id,
      nonce: input.packs.length,
    });
    const totalUnpacked = roundedMoney(
      [...values.values()].reduce((sum, value) => sum + value, 0),
    );
    const creatorWonBattle =
      resolved.winnerTeam === creatorParticipant.team_number;
    const creatorBorrowFactor = creatorParticipant.borrow_percentage > 0
      ? 1 - creatorParticipant.borrow_percentage / 100
      : 1;
    const creatorStake = roundedMoney(
      Number(input.battle.bet_amount) * creatorBorrowFactor,
    );
    const creatorCost = roundedMoney(
      creatorStake + Number(input.battle.sponsorship_amount_paid),
    );
    const winningTeamSize = input.participants.filter(
      (participant) => participant.team_number === resolved.winnerTeam,
    ).length;
    const creatorPayout = creatorWonBattle
      ? roundedMoney(
          (totalUnpacked / winningTeamSize) * creatorBorrowFactor,
        )
      : 0;
    const creatorProfitLoss = roundedMoney(creatorPayout - creatorCost);
    const creatorMoneyResult: BattleCandidateOutcome["creatorMoneyResult"] = creatorProfitLoss > 0
      ? "profit"
      : creatorProfitLoss < 0
        ? "loss"
        : "break_even";
    return {
      ...candidate,
      winningTeam: resolved.winnerTeam,
      creatorTeam: creatorParticipant.team_number,
      creatorWonBattle,
      creatorCost,
      creatorPayout,
      creatorProfitLoss,
      creatorMoneyResult,
      creatorAmount: Math.abs(creatorProfitLoss),
    };
  });
  return {
    battleId: input.battle.id,
    mode,
    crazyMode,
    currency: input.battle.currency,
    creatorUserID: input.battle.user_id,
    outcomes,
  };
}

export class DevBattleOutcomeSimulator implements BattleOutcomeSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pepper: string,
  ) {}

  async simulate(
    userID: string,
    battleID: string,
    candidates: EosBlockCandidate[],
  ): Promise<BattleOutcomeSimulation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const battles = await client.query<BattleRow>(
        `
          SELECT b.id, b.user_id, b.mode::text, b.pack_ids,
                 b.additional_settings, b.bet_amount::text,
                 b.currency::text, b.sponsorship_amount_paid::text,
                 b.server_seed, b.server_seed_hash
          FROM battles b
          WHERE b.user_id = $1 AND b.id = $2::uuid
          LIMIT 1
        `,
        [userID, battleID],
      );
      const battle = battles.rows[0];
      if (!battle) {
        throw new BattleSimulationError("battle_not_found", 404);
      }
      // One checked-out client owns the repeatable-read snapshot. Keep its
      // queries sequential: node-postgres is deprecating concurrent query()
      // calls on a busy client, and they would not gain DB parallelism anyway.
      const participantResult = await client.query<ParticipantRow>(
          `
            SELECT id, user_id, bot_id, team_number, team_position,
                   borrow_percentage
            FROM battle_participants
            WHERE battle_id = $1
            ORDER BY team_number, team_position, id
          `,
          [battle.id],
        );
      const packResult = await client.query<PackRow>(
          `
            SELECT id, name, image_url, cards_per_open
            FROM packs
            WHERE id = ANY($1::uuid[])
          `,
          [battle.pack_ids],
        );
      const cardResult = await client.query<CardRow>(
          `
            SELECT pc.pack_id, pc.card_id, pc.weight, pc."order",
                   c.name, c.image_url, c.price::text, c.hp, c.rarity
            FROM pack_cards pc
            JOIN cards c ON c.id = pc.card_id
            WHERE pc.pack_id = ANY($1::uuid[])
            ORDER BY pc.pack_id, pc."order", pc.id
          `,
          [battle.pack_ids],
        );
      const packMap = new Map(packResult.rows.map((pack) => [pack.id, pack]));
      const packs = battle.pack_ids.map((id) => packMap.get(id)).filter(
        (pack): pack is PackRow => Boolean(pack),
      );
      if (packs.length !== battle.pack_ids.length) {
        throw new BattleSimulationError("battle_data_incomplete", 409);
      }
      const cardsByPack = new Map<string, CardRow[]>();
      for (const card of cardResult.rows) {
        const cards = cardsByPack.get(card.pack_id) ?? [];
        cards.push(card);
        cardsByPack.set(card.pack_id, cards);
      }
      let serverSeed: string;
      try {
        serverSeed = decryptServerSeed(battle.server_seed, this.pepper);
      } catch {
        throw new BattleSimulationError("battle_seed_invalid", 503);
      }
      const actualHash = createHash("sha256").update(serverSeed, "utf8").digest("hex");
      if (actualHash !== battle.server_seed_hash) {
        throw new BattleSimulationError("battle_seed_invalid", 503);
      }
      const simulation = simulateBattle({
        battle,
        participants: participantResult.rows,
        packs,
        cardsByPack,
        userID,
        candidates,
        serverSeed,
      });
      await client.query("COMMIT");
      return simulation;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
