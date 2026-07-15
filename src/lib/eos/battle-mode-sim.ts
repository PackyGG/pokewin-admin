import { generateProvablyFairInt, MAX_TICKET } from "./provably-fair-crypto";

/**
 * Ports backend's battle resolution algorithm — `services/battle/card-roll.service.ts`
 * (card drawing), `utils/pack-odds.ts` (ticket -> card mapping), and
 * `services/battle/mode-strategies.ts` (all 5 mode strategies) — so this
 * admin tool can recompute what a battle's outcome WOULD have been for a
 * given EOS block hash, using the battle's real server seed, participants,
 * and packs. Card odds use today's live pack configuration (weights aren't
 * historically snapshotted for non-recorded blocks), so a recomputed result
 * can drift from what actually happened if a pack's cards changed since.
 */

export type BattleMode = "normal" | "jackpot" | "group" | "hp_rush" | "lowest";

export type SimPackCard = {
  cardId: string;
  price: number;
  hp: number;
  weight: number;
};

export type SimRound = {
  cardsPerOpen: number;
  cards: SimPackCard[];
};

export type SimParticipant = {
  id: string;
  teamNumber: number;
};

type DrawnCard = SimPackCard & { ticket: number };

export type SimulatedParticipantOutcome = {
  participantId: string;
  teamNumber: number;
  won: boolean;
};

export type SimulatedBattleOutcome = {
  mode: BattleMode;
  winnerTeam: number | null;
  usedTiebreaker: boolean;
  scoreUnit: "value" | "hp" | "points" | "n/a";
  teamScores: Record<number, number>;
  participants: SimulatedParticipantOutcome[];
  /** Total USD value of every card drawn by every participant, all rounds — the pot a winning team splits. Always price-based, regardless of mode (mirrors backend's `settlement.service.ts` `totalValue`). */
  potValueUsd: number;
  /** Count of ALL members of the winning team, bots included — the pot is split this many ways (`expectedValuePerMember = totalValue / allWinningTeamMembers.length` in settlement.service.ts). Null when there's no winner. */
  winningTeamSize: number | null;
};

function computeCumulativeWeights(cards: SimPackCard[]): number[] {
  const cumulative: number[] = [];
  let total = 0;
  for (const card of cards) {
    total += card.weight;
    cumulative.push(total);
  }
  return cumulative;
}

function scaleToTicketSpace(cumulativeWeight: number, totalWeight: number): number {
  return Math.floor((cumulativeWeight / totalWeight) * MAX_TICKET);
}

function findCardForTicket(
  ticket: number,
  cards: SimPackCard[],
  cumulativeWeights: number[],
): SimPackCard | undefined {
  const totalWeight = cumulativeWeights[cumulativeWeights.length - 1] ?? 0;
  if (totalWeight === 0 || cards.length === 0) return undefined;

  let left = 0;
  let right = cards.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midBoundary = scaleToTicketSpace(cumulativeWeights[mid]!, totalWeight);
    const prevBoundary =
      mid > 0 ? scaleToTicketSpace(cumulativeWeights[mid - 1]!, totalWeight) : 0;

    if (ticket <= midBoundary && ticket > prevBoundary) return cards[mid];
    if (ticket > midBoundary) left = mid + 1;
    else right = mid - 1;
  }

  return cards[cards.length - 1];
}

function drawCardsForRound(params: {
  round: SimRound;
  serverSeed: string;
  blockHash: string;
  participantId: string;
  roundIndex: number;
}): DrawnCard[] {
  const { round, serverSeed, blockHash, participantId, roundIndex } = params;
  const cumulativeWeights = computeCumulativeWeights(round.cards);

  // `${blockHash}:${participantId}` is the ONLY client seed ever fed into the
  // HMAC (see generateParticipantClientSeed in card-roll.service.ts) — round
  // and card index vary the *nonce*/*cursor*, never the seed string itself.
  // generateCardClientSeed's per-card seed is used solely to relabel the
  // stored `client_seed` for display after the ticket is already drawn; it
  // never participates in the actual draw. Baking roundIndex/cardIndex into
  // the seed string here would double-encode them and produce a different
  // ticket than the real battle.
  const clientSeed = `${blockHash}:${participantId}`;

  const drawn: DrawnCard[] = [];
  for (let cardIndex = 0; cardIndex < round.cardsPerOpen; cardIndex++) {
    const { ticket } = generateProvablyFairInt(serverSeed, clientSeed, roundIndex, cardIndex);
    const card = findCardForTicket(ticket, round.cards, cumulativeWeights);
    if (card) drawn.push({ ...card, ticket });
  }
  return drawn;
}

function sumTeamScores(
  participants: SimParticipant[],
  participantResults: Map<string, DrawnCard[][]>,
  key: "price" | "hp",
): Map<number, number> {
  const scores = new Map<number, number>();
  for (const p of participants) {
    if (!scores.has(p.teamNumber)) scores.set(p.teamNumber, 0);
    const rounds = participantResults.get(p.id) ?? [];
    let total = 0;
    for (const round of rounds) {
      for (const card of round) total += card[key];
    }
    scores.set(p.teamNumber, (scores.get(p.teamNumber) ?? 0) + total);
  }
  return scores;
}

function determineWinnerFromScores(
  teamScores: Map<number, number>,
  findLowest: boolean,
): { winnerTeam: number | null; tiedTeams: number[] } {
  const rounded = new Map(
    Array.from(teamScores.entries()).map(([team, score]) => [team, Math.round(score * 100) / 100]),
  );
  const scores = Array.from(rounded.values());
  if (scores.length === 0) return { winnerTeam: null, tiedTeams: [] };

  const target = findLowest ? Math.min(...scores) : Math.max(...scores);
  const tied = Array.from(rounded.entries())
    .filter(([, score]) => score === target)
    .map(([team]) => team)
    .sort((a, b) => a - b);

  if (tied.length === 1) return { winnerTeam: tied[0]!, tiedTeams: [] };
  return { winnerTeam: null, tiedTeams: tied };
}

function resolveTiebreaker(params: {
  tiedTeams: number[];
  serverSeed: string;
  blockHash: string;
  battleId: string;
  nonce: number;
}): number {
  const { tiedTeams, serverSeed, blockHash, battleId, nonce } = params;
  const clientSeed = `${blockHash}:tiebreaker:${battleId}`;
  const { ticket } = generateProvablyFairInt(serverSeed, clientSeed, nonce, 0);

  const segmentSize = Math.floor(MAX_TICKET / tiedTeams.length);
  let currentStart = 1;
  for (let i = 0; i < tiedTeams.length; i++) {
    const isLast = i === tiedTeams.length - 1;
    const endTicket = isLast ? MAX_TICKET : currentStart + segmentSize - 1;
    if (ticket >= currentStart && ticket <= endTicket) return tiedTeams[i]!;
    currentStart = endTicket + 1;
  }
  return tiedTeams[0]!;
}

function resolveByScoreComparison(params: {
  teamScores: Map<number, number>;
  isCrazyMode: boolean;
  serverSeed: string;
  blockHash: string;
  battleId: string;
  totalRounds: number;
}): { winnerTeam: number | null; usedTiebreaker: boolean } {
  const { teamScores, isCrazyMode, serverSeed, blockHash, battleId, totalRounds } = params;
  const { winnerTeam, tiedTeams } = determineWinnerFromScores(teamScores, isCrazyMode);
  if (tiedTeams.length === 0) return { winnerTeam, usedTiebreaker: false };

  const resolved = resolveTiebreaker({
    tiedTeams,
    serverSeed,
    blockHash,
    battleId,
    nonce: totalRounds,
  });
  return { winnerTeam: resolved, usedTiebreaker: true };
}

function resolveLowest(params: {
  participants: SimParticipant[];
  participantResults: Map<string, DrawnCard[][]>;
  isCrazyMode: boolean;
  serverSeed: string;
  blockHash: string;
  battleId: string;
  totalRounds: number;
}): { winnerTeam: number | null; teamScores: Map<number, number>; usedTiebreaker: boolean } {
  const { participants, participantResults, isCrazyMode, serverSeed, blockHash, battleId, totalRounds } =
    params;

  const teamPoints = new Map<number, number>();
  for (const p of participants) {
    if (!teamPoints.has(p.teamNumber)) teamPoints.set(p.teamNumber, 0);
  }

  for (let round = 0; round < totalRounds; round++) {
    let bestTicket = isCrazyMode ? 0 : MAX_TICKET + 1;
    let roundWinnerTeam: number | null = null;

    for (const p of participants) {
      const cards = participantResults.get(p.id)?.[round] ?? [];
      for (const card of cards) {
        const isBetter = isCrazyMode ? card.ticket > bestTicket : card.ticket < bestTicket;
        if (isBetter) {
          bestTicket = card.ticket;
          roundWinnerTeam = p.teamNumber;
        }
      }
    }

    if (roundWinnerTeam !== null) {
      teamPoints.set(roundWinnerTeam, (teamPoints.get(roundWinnerTeam) ?? 0) + 1);
    }
  }

  const points = Array.from(teamPoints.values());
  const maxPoints = points.length > 0 ? Math.max(...points, 0) : 0;
  const tiedTeams = Array.from(teamPoints.entries())
    .filter(([, pts]) => pts === maxPoints)
    .map(([team]) => team)
    .sort((a, b) => a - b);

  if (tiedTeams.length === 1) {
    return { winnerTeam: tiedTeams[0]!, teamScores: teamPoints, usedTiebreaker: false };
  }
  if (tiedTeams.length === 0) {
    return { winnerTeam: null, teamScores: teamPoints, usedTiebreaker: false };
  }

  const resolved = resolveTiebreaker({
    tiedTeams,
    serverSeed,
    blockHash,
    battleId,
    nonce: totalRounds,
  });
  return { winnerTeam: resolved, teamScores: teamPoints, usedTiebreaker: true };
}

function resolveJackpot(params: {
  participants: SimParticipant[];
  participantResults: Map<string, DrawnCard[][]>;
  teamScores: Map<number, number>;
  isCrazyMode: boolean;
  serverSeed: string;
  blockHash: string;
  battleId: string;
  totalRounds: number;
}): number | null {
  const {
    participants,
    participantResults,
    teamScores,
    isCrazyMode,
    serverSeed,
    blockHash,
    battleId,
    totalRounds,
  } = params;

  const clientSeed = `${blockHash}:jackpot:${battleId}`;
  const { ticket } = generateProvablyFairInt(serverSeed, clientSeed, totalRounds, 0);

  const totalValue = Array.from(teamScores.values()).reduce((sum, v) => sum + v, 0);
  const sortedTeams = Array.from(teamScores.keys()).sort((a, b) => a - b);
  if (sortedTeams.length === 0) return null;

  const adjustedPercentages = new Map<number, number>();

  if (isCrazyMode && totalValue > 0) {
    const teamWeightSum = new Map<number, number>();
    for (const team of sortedTeams) teamWeightSum.set(team, 0);

    for (const p of participants) {
      const rounds = participantResults.get(p.id) ?? [];
      let playerTotal = 0;
      for (const round of rounds) for (const card of round) playerTotal += card.price;
      const weight = playerTotal > 0 ? 1 / playerTotal : 1;
      teamWeightSum.set(p.teamNumber, (teamWeightSum.get(p.teamNumber) ?? 0) + weight);
    }

    const totalWeight = Array.from(teamWeightSum.values()).reduce((sum, v) => sum + v, 0);
    if (totalWeight > 0) {
      for (const team of sortedTeams) {
        adjustedPercentages.set(team, (teamWeightSum.get(team) ?? 0) / totalWeight);
      }
    }
  } else {
    for (const team of sortedTeams) {
      const teamValue = teamScores.get(team) ?? 0;
      adjustedPercentages.set(team, totalValue > 0 ? teamValue / totalValue : 1 / sortedTeams.length);
    }
  }

  const segments: { team: number; startTicket: number; endTicket: number }[] = [];
  let currentStart = 1;
  for (let i = 0; i < sortedTeams.length; i++) {
    const team = sortedTeams[i]!;
    const percentage = adjustedPercentages.get(team) ?? 1 / sortedTeams.length;
    const isLast = i === sortedTeams.length - 1;
    const segmentSize = Math.floor(MAX_TICKET * percentage);
    const endTicket = isLast ? MAX_TICKET : currentStart + segmentSize - 1;
    segments.push({ team, startTicket: currentStart, endTicket });
    currentStart = endTicket + 1;
  }

  const winnerSegment = segments.find((s) => ticket >= s.startTicket && ticket <= s.endTicket);
  return winnerSegment?.team ?? sortedTeams[0]!;
}

export function simulateBattleOutcomeForBlockHash(params: {
  mode: BattleMode;
  battleId: string;
  blockHash: string;
  serverSeed: string;
  isCrazyMode: boolean;
  participants: SimParticipant[];
  rounds: SimRound[];
}): SimulatedBattleOutcome {
  const { mode, battleId, blockHash, serverSeed, isCrazyMode, participants, rounds } = params;

  const participantResults = new Map<string, DrawnCard[][]>();
  for (const p of participants) {
    const perRound: DrawnCard[][] = rounds.map((round, roundIndex) =>
      drawCardsForRound({ round, serverSeed, blockHash, participantId: p.id, roundIndex }),
    );
    participantResults.set(p.id, perRound);
  }

  const totalRounds = rounds.length;
  const priceTeamScores = sumTeamScores(participants, participantResults, "price");
  const potValueUsd = Array.from(priceTeamScores.values()).reduce((sum, v) => sum + v, 0);

  let winnerTeam: number | null;
  let teamScores: Map<number, number>;
  let scoreUnit: SimulatedBattleOutcome["scoreUnit"];
  let usedTiebreaker = false;

  if (mode === "group") {
    winnerTeam = 1;
    teamScores = priceTeamScores;
    scoreUnit = "n/a";
  } else if (mode === "hp_rush") {
    teamScores = sumTeamScores(participants, participantResults, "hp");
    const resolved = resolveByScoreComparison({
      teamScores,
      isCrazyMode,
      serverSeed,
      blockHash,
      battleId,
      totalRounds,
    });
    winnerTeam = resolved.winnerTeam;
    usedTiebreaker = resolved.usedTiebreaker;
    scoreUnit = "hp";
  } else if (mode === "lowest") {
    const resolved = resolveLowest({
      participants,
      participantResults,
      isCrazyMode,
      serverSeed,
      blockHash,
      battleId,
      totalRounds,
    });
    winnerTeam = resolved.winnerTeam;
    teamScores = resolved.teamScores;
    usedTiebreaker = resolved.usedTiebreaker;
    scoreUnit = "points";
  } else if (mode === "jackpot") {
    teamScores = priceTeamScores;
    winnerTeam = resolveJackpot({
      participants,
      participantResults,
      teamScores: priceTeamScores,
      isCrazyMode,
      serverSeed,
      blockHash,
      battleId,
      totalRounds,
    });
    scoreUnit = "value";
  } else {
    teamScores = priceTeamScores;
    const resolved = resolveByScoreComparison({
      teamScores: priceTeamScores,
      isCrazyMode,
      serverSeed,
      blockHash,
      battleId,
      totalRounds,
    });
    winnerTeam = resolved.winnerTeam;
    usedTiebreaker = resolved.usedTiebreaker;
    scoreUnit = "value";
  }

  const winningTeamSize =
    winnerTeam !== null ? participants.filter((p) => p.teamNumber === winnerTeam).length : null;

  return {
    mode,
    winnerTeam,
    usedTiebreaker,
    scoreUnit,
    teamScores: Object.fromEntries(teamScores),
    potValueUsd,
    winningTeamSize,
    participants: participants.map((p) => ({
      participantId: p.id,
      teamNumber: p.teamNumber,
      won: winnerTeam !== null && p.teamNumber === winnerTeam,
    })),
  };
}
