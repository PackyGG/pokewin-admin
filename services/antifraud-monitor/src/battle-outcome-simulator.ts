import { createDecipheriv, createHash, createHmac, hkdfSync } from "node:crypto";

import type pg from "pg";

import type { EosBlockCandidate } from "./eos-random-block-routes.js";

const MAX_TICKET = 1_000_000;
const VALUE_TOLERANCE = 0.01;

type BattleRow = {
  id: string;
  user_id: string;
  mode: string;
  pack_ids: string[];
  additional_settings: string[];
  bet_amount: string;
  currency: "real" | "coin";
  sponsorship_amount_paid: string;
  teams: number;
  players_per_team: number;
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
  cards_per_open: number;
};

type CardRow = {
  pack_id: string;
  weight: number;
  order: number;
  price: string;
  hp: number | null;
};

type BattleSnapshotRow = BattleRow & {
  participants: ParticipantRow[];
  packs: PackRow[];
  cards: CardRow[];
};

export type BattleCandidateOutcome = {
  blockNumber: number;
  winningTeam: number;
  creatorTeam: number;
  creatorWonBattle: boolean;
  creatorCost: number;
  creatorProfitLoss: number;
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
    battleID: string | undefined,
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

export type PulledParticipant = {
  id: string;
  userId: string | null;
  botId: string | null;
  teamNumber: number;
  borrowPercentage: number;
  totalValue: number;
  rounds: Array<{
    cards: Array<{
      price: number;
      hp: number;
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

function borrowFactor(borrowPercentage: number): number {
  return borrowPercentage > 0 ? 1 - borrowPercentage / 100 : 1;
}

function creatorSettlementValue(
  participants: PulledParticipant[],
  winnerTeam: number,
  creatorUserId: string,
): number {
  const allWinningMembers = participants.filter(
    (participant) => participant.teamNumber === winnerTeam,
  );
  const humanWinners = allWinningMembers.filter(
    (participant) => participant.userId !== null && participant.botId === null,
  );
  const creator = humanWinners.find(
    (participant) => participant.userId === creatorUserId,
  );
  if (!creator || allWinningMembers.length === 0) return 0;

  const cards = participants.flatMap((participant) =>
    participant.rounds.flatMap((round) => round.cards.map((card) => card.price))
  );
  const totalValue = cards.reduce((sum, value) => sum + value, 0);
  const expectedPerMember = totalValue / allWinningMembers.length;
  const expected = new Map(humanWinners.map((participant) => [
    participant.id,
    expectedPerMember * borrowFactor(participant.borrowPercentage),
  ]));
  const totals = new Map(humanWinners.map((participant) => [participant.id, 0]));

  if (humanWinners.length === 1) {
    const winner = humanWinners[0]!;
    const winnerExpected = expected.get(winner.id)!;
    for (const value of [...cards].sort((left, right) => right - left)) {
      const current = totals.get(winner.id)!;
      if (current + value <= winnerExpected + VALUE_TOLERANCE) {
        totals.set(winner.id, current + value);
      }
    }
  } else {
    const sortedCards = cards
      .map((value, originalIndex) => ({ value, originalIndex }))
      .sort((left, right) => left.value - right.value);
    const available = new Set(sortedCards.map((_, index) => index));
    const deferred: number[] = [];
    let currentMember = 0;
    let roundsWithoutAssignment = 0;
    const maxRounds = cards.length * 2;
    let safetyCounter = 0;
    const safetyLimit = cards.length * humanWinners.length * 10;

    const assign = (cardIndex: number, participant: PulledParticipant) => {
      const card = sortedCards[cardIndex]!;
      totals.set(
        participant.id,
        totals.get(participant.id)! + card.value,
      );
      available.delete(cardIndex);
    };

    while (
      available.size > 0
      && roundsWithoutAssignment < maxRounds
      && safetyCounter < safetyLimit
    ) {
      safetyCounter += 1;
      const participant = humanWinners[currentMember]!;
      const current = totals.get(participant.id)!;
      const participantExpected = expected.get(participant.id)!;
      if (participantExpected - current > VALUE_TOLERANCE) {
        let bestIndex: number | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const cardIndex of available) {
          const newTotal = current + sortedCards[cardIndex]!.value;
          if (newTotal > participantExpected + VALUE_TOLERANCE) continue;
          const score = Math.abs(participantExpected - newTotal);
          if (score < bestScore) {
            bestScore = score;
            bestIndex = cardIndex;
          }
        }
        if (bestIndex !== null) {
          assign(bestIndex, participant);
          roundsWithoutAssignment = 0;
        } else {
          const smallestIndex = available.values().next().value as
            | number
            | undefined;
          if (smallestIndex !== undefined) {
            deferred.push(smallestIndex);
            available.delete(smallestIndex);
          }
          roundsWithoutAssignment += 1;
        }
      }
      currentMember = (currentMember + 1) % humanWinners.length;
    }

    let deferredSafety = 0;
    const deferredSafetyLimit = deferred.length * 10;
    while (deferred.length > 0 && deferredSafety < deferredSafetyLimit) {
      deferredSafety += 1;
      let assignedAny = false;
      const orderedWinners = humanWinners
        .map((participant) => ({
          participant,
          total: totals.get(participant.id)!,
        }))
        .sort((left, right) => left.total - right.total);
      for (let index = deferred.length - 1; index >= 0; index -= 1) {
        const cardIndex = deferred[index]!;
        const card = sortedCards[cardIndex]!;
        for (const { participant, total } of orderedWinners) {
          if (
            total + card.value
            <= expected.get(participant.id)! + VALUE_TOLERANCE
          ) {
            assign(cardIndex, participant);
            deferred.splice(index, 1);
            assignedAny = true;
            break;
          }
        }
      }
      if (!assignedAny) break;
    }
  }

  const actualCardValue = totals.get(creator.id)!;
  const rawDeficit = expected.get(creator.id)! - actualCardValue;
  const voucherValue = rawDeficit > VALUE_TOLERANCE
    ? Number(rawDeficit.toFixed(2))
    : 0;
  return roundedMoney(actualCardValue + voucherValue);
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

export function resolveBattleMode(input: {
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
  const creatorParticipants = input.participants.filter(
    (participant) => participant.user_id === input.battle.user_id,
  );
  const creatorParticipant = creatorParticipants[0];
  const expectedParticipants = input.battle.teams * input.battle.players_per_team;
  const occupiedSlots = new Set(input.participants.map(
    (participant) => `${participant.team_number}:${participant.team_position}`,
  ));
  if (
    input.userID !== input.battle.user_id
    || !creatorParticipant
    || creatorParticipants.length !== 1
    || input.participants.length !== expectedParticipants
    || occupiedSlots.size !== expectedParticipants
    || input.participants.some((participant) =>
      (participant.user_id === null) === (participant.bot_id === null)
    )
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
            price: Number(card.price),
            hp: card.hp ?? 0,
            ticket,
          };
        });
        return { cards };
      });
      const totalValue = rounds.reduce(
        (sum, round) => sum + round.cards.reduce(
          (roundSum, card) => roundSum + card.price,
          0,
        ),
        0,
      );
      return {
        id: participant.id,
        userId: participant.user_id,
        botId: participant.bot_id,
        teamNumber: participant.team_number,
        borrowPercentage: participant.borrow_percentage,
        totalValue,
        rounds,
      };
    });
    const values = valueScores(participants);
    const resolved = resolveBattleMode({
      mode,
      crazyMode,
      participants,
      valueScores: values,
      serverSeed: input.serverSeed,
      blockHash: candidate.blockHash,
      battleId: input.battle.id,
      nonce: input.packs.length,
    });
    const creatorWonBattle =
      resolved.winnerTeam === creatorParticipant.team_number;
    const creatorStake = roundedMoney(
      Number(input.battle.bet_amount)
        * borrowFactor(creatorParticipant.borrow_percentage),
    );
    const creatorCost = roundedMoney(
      creatorStake + Number(input.battle.sponsorship_amount_paid),
    );
    const creatorPayout = creatorWonBattle
      ? creatorSettlementValue(
          participants,
          resolved.winnerTeam,
          input.battle.user_id,
        )
      : 0;
    const creatorProfitLoss = roundedMoney(creatorPayout - creatorCost);
    return {
      blockNumber: candidate.blockNumber,
      winningTeam: resolved.winnerTeam,
      creatorTeam: creatorParticipant.team_number,
      creatorWonBattle,
      creatorCost,
      creatorProfitLoss,
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

export class BattleOutcomeSimulator implements BattleOutcomeSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pepper: string,
  ) {}

  async simulate(
    userID: string,
    battleID: string | undefined,
    candidates: EosBlockCandidate[],
  ): Promise<BattleOutcomeSimulation> {
    // One SQL statement gives a consistent snapshot while avoiding the
    // latency of several sequential round trips to the dev database.
    const snapshots = await this.pool.query<BattleSnapshotRow>(
      `
        SELECT b.id, b.user_id, b.mode::text, b.pack_ids,
               b.teams, b.players_per_team,
               b.additional_settings, b.bet_amount::text,
               b.currency::text, b.sponsorship_amount_paid::text,
               b.server_seed, b.server_seed_hash,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', bp.id,
                   'user_id', bp.user_id,
                   'bot_id', bp.bot_id,
                   'team_number', bp.team_number,
                   'team_position', bp.team_position,
                   'borrow_percentage', bp.borrow_percentage
                 ) ORDER BY bp.team_number, bp.team_position, bp.id)
                 FROM battle_participants bp
                 WHERE bp.battle_id = b.id
               ), '[]'::jsonb) AS participants,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', p.id,
                   'cards_per_open', p.cards_per_open
                 ))
                 FROM packs p
                 WHERE p.id = ANY(b.pack_ids::uuid[])
               ), '[]'::jsonb) AS packs,
               COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'pack_id', pc.pack_id,
                   'weight', pc.weight,
                   'order', pc."order",
                   'price', c.price::text,
                   'hp', c.hp
                 ) ORDER BY pc.pack_id, pc."order", pc.id)
                 FROM pack_cards pc
                 JOIN cards c ON c.id = pc.card_id
                 WHERE pc.pack_id = ANY(b.pack_ids::uuid[])
               ), '[]'::jsonb) AS cards
        FROM battles b
        WHERE b.user_id = $1
          AND (
            ($2::uuid IS NOT NULL AND b.id = $2::uuid)
            OR ($2::uuid IS NULL AND b.status = 'in_progress')
          )
        ORDER BY b.created_at DESC
        LIMIT 1
      `,
      [userID, battleID],
    );
    const battle = snapshots.rows[0];
    if (!battle) {
      throw new BattleSimulationError("battle_not_found", 404);
    }
    const packMap = new Map(battle.packs.map((pack) => [pack.id, pack]));
    const packs = battle.pack_ids.map((id) => packMap.get(id)).filter(
      (pack): pack is PackRow => Boolean(pack),
    );
    if (packs.length !== battle.pack_ids.length) {
      throw new BattleSimulationError("battle_data_incomplete", 409);
    }
    const cardsByPack = new Map<string, CardRow[]>();
    for (const card of battle.cards) {
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
    return simulateBattle({
      battle,
      participants: battle.participants,
      packs,
      cardsByPack,
      userID,
      candidates,
      serverSeed,
    });
  }
}
