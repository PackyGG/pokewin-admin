import assert from "node:assert/strict";
import test from "node:test";

import { createHmac } from "node:crypto";

import {
  BattleOutcomeSimulator,
  resolveBattleMode,
  simulateBattle,
  type PulledParticipant,
} from "../src/battle-outcome-simulator.js";

const BATTLE_ID = "11111111-1111-4111-8111-111111111111";
const PACK_ID = "22222222-2222-4222-8222-222222222222";
const candidates = Array.from({ length: 5 }, (_, index) => ({
  blockNumber: 100 - index,
  blockHash: String(index + 1).repeat(64),
  blockTimestamp: `2026-08-07T21:29:${String(42 - index).padStart(2, "0")}.000`,
}));

function referenceTicket(clientSeed: string, nonce: number): number {
  const hash = createHmac("sha256", "server-seed-for-test")
    .update(`${clientSeed}:${nonce}:0`)
    .digest("hex");
  return Number((BigInt(`0x${hash}`) % 1_000_000n) + 1n);
}

function pulledParticipant(
  id: string,
  teamNumber: number,
  roundCards: Array<{ price: number; hp: number; ticket: number }>,
): PulledParticipant {
  return {
    id,
    userId: id,
    botId: null,
    teamNumber,
    borrowPercentage: 0,
    totalValue: roundCards.reduce((sum, card) => sum + card.price, 0),
    rounds: roundCards.map((card) => ({ cards: [card] })),
  };
}

function simulate(
  mode: string,
  crazyMode = false,
  creatorBorrowPercentage = 0,
  sponsorshipAmountPaid = 0,
  completeRoster = true,
  settlementFixture?: { secondHuman: boolean; fixedCardPrice: number },
) {
  return simulateBattle({
    battle: {
      id: BATTLE_ID,
      user_id: "target-user",
      mode,
      pack_ids: [PACK_ID, PACK_ID],
      additional_settings: crazyMode ? ["crazy_mode"] : [],
      bet_amount: "20.00",
      currency: "real",
      sponsorship_amount_paid: sponsorshipAmountPaid.toFixed(2),
      teams: mode === "group" ? 1 : 2,
      players_per_team: mode === "group" ? 2 : 1,
      server_seed: "unused-by-pure-simulation",
      server_seed_hash: "unused-by-pure-simulation",
    },
    participants: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: "target-user",
        bot_id: null,
        team_number: 1,
        team_position: 0,
        borrow_percentage: creatorBorrowPercentage,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        user_id: settlementFixture?.secondHuman ? "teammate-user" : null,
        bot_id: settlementFixture?.secondHuman
          ? null
          : "55555555-5555-4555-8555-555555555555",
        team_number: mode === "group" ? 1 : 2,
        team_position: mode === "group" ? 1 : 0,
        borrow_percentage: 0,
      },
    ].slice(0, completeRoster ? 2 : 1),
    packs: [
      { id: PACK_ID, cards_per_open: 1 },
      { id: PACK_ID, cards_per_open: 1 },
    ],
    cardsByPack: new Map([[
      PACK_ID,
      settlementFixture
        ? [{
            pack_id: PACK_ID,
            weight: 1,
            order: 0,
            price: settlementFixture.fixedCardPrice.toFixed(2),
            hp: 10,
          }]
        : [
        {
          pack_id: PACK_ID,
          weight: 1,
          order: 0,
          price: "100.00",
          hp: 10,
        },
        {
          pack_id: PACK_ID,
          weight: 1,
          order: 1,
          price: "5.00",
          hp: 500,
        },
          ],
    ]]),
    userID: "target-user",
    candidates,
    serverSeed: "server-seed-for-test",
  });
}

test("battle simulation deterministically evaluates all five EOS candidates", () => {
  const simulation = simulate("normal");

  assert.equal(simulation.outcomes.length, 5);
  assert.deepEqual(
    simulation.outcomes.map((outcome) => outcome.blockNumber),
    candidates.map((candidate) => candidate.blockNumber),
  );
  assert.deepEqual(simulate("normal"), simulation);
  for (const outcome of simulation.outcomes) {
    assert.equal(outcome.creatorTeam, 1);
    assert.equal(outcome.creatorWonBattle, outcome.winningTeam === 1);
    assert.equal(outcome.creatorCost, 20);
    assert.equal(
      outcome.creatorProfitLoss,
      outcome.creatorWonBattle
        ? outcome.creatorProfitLoss
        : -outcome.creatorCost,
    );
  }
});

test("all backend battle modes return creator-level settlement results only", () => {
  for (const mode of ["normal", "jackpot", "group", "hp_rush", "lowest"]) {
    const simulation = simulate(mode);
    assert.equal(simulation.mode, mode);
    assert.equal(simulation.outcomes.length, 5);
    for (const outcome of simulation.outcomes) {
      assert.deepEqual(Object.keys(outcome).sort(), [
        "blockNumber",
        "creatorCost",
        "creatorProfitLoss",
        "creatorTeam",
        "creatorWonBattle",
        "winningTeam",
      ]);
      if (mode === "group") {
        assert.equal(outcome.winningTeam, 1);
        assert.equal(outcome.creatorWonBattle, true);
      }
    }
  }
});

test("crazy mode inverts normal score selection", () => {
  const normal = simulate("normal", false);
  const crazy = simulate("normal", true);

  assert.ok(normal.outcomes.some(
    (outcome, index) => outcome.winningTeam !== crazy.outcomes[index]!.winningTeam,
  ));
});

test("mode resolver matches backend rules for normal, HP Rush, and group", () => {
  const participants = [
    pulledParticipant("player-1", 1, [
      { price: 100, hp: 10, ticket: 100 },
    ]),
    pulledParticipant("player-2", 2, [
      { price: 10, hp: 200, ticket: 200 },
    ]),
  ];
  const base = {
    participants,
    valueScores: new Map([[1, 100], [2, 10]]),
    serverSeed: "server-seed-for-test",
    blockHash: candidates[0]!.blockHash,
    battleId: BATTLE_ID,
    nonce: 1,
  };

  assert.equal(resolveBattleMode({ ...base, mode: "normal", crazyMode: false }).winnerTeam, 1);
  assert.equal(resolveBattleMode({ ...base, mode: "normal", crazyMode: true }).winnerTeam, 2);
  assert.equal(resolveBattleMode({ ...base, mode: "hp_rush", crazyMode: false }).winnerTeam, 2);
  assert.equal(resolveBattleMode({ ...base, mode: "hp_rush", crazyMode: true }).winnerTeam, 1);
  assert.equal(resolveBattleMode({ ...base, mode: "group", crazyMode: false }).winnerTeam, 1);
});

test("Ticket Rush awards each round by ticket direction and most points", () => {
  const participants = [
    pulledParticipant("player-1", 1, [
      { price: 1, hp: 1, ticket: 10 },
      { price: 1, hp: 1, ticket: 900 },
      { price: 1, hp: 1, ticket: 20 },
    ]),
    pulledParticipant("player-2", 2, [
      { price: 1, hp: 1, ticket: 20 },
      { price: 1, hp: 1, ticket: 800 },
      { price: 1, hp: 1, ticket: 30 },
    ]),
  ];
  const base = {
    mode: "lowest" as const,
    participants,
    valueScores: new Map([[1, 3], [2, 3]]),
    serverSeed: "server-seed-for-test",
    blockHash: candidates[0]!.blockHash,
    battleId: BATTLE_ID,
    nonce: 3,
  };

  assert.equal(resolveBattleMode({ ...base, crazyMode: false }).winnerTeam, 1);
  assert.equal(resolveBattleMode({ ...base, crazyMode: true }).winnerTeam, 2);
});

test("jackpot and ties use the backend million-ticket segments", () => {
  const participants = [
    pulledParticipant("player-1", 1, [
      { price: 100, hp: 1, ticket: 100 },
    ]),
    pulledParticipant("player-2", 2, [
      { price: 10, hp: 1, ticket: 200 },
    ]),
  ];
  const blockHash = candidates[0]!.blockHash;
  const base = {
    participants,
    serverSeed: "server-seed-for-test",
    blockHash,
    battleId: BATTLE_ID,
    nonce: 1,
  };
  const jackpotTicket = referenceTicket(`${blockHash}:jackpot:${BATTLE_ID}`, 1);
  const normalBoundary = Math.floor(1_000_000 * (100 / 110));
  const crazyBoundary = Math.floor(1_000_000 * ((1 / 100) / ((1 / 100) + (1 / 10))));

  assert.equal(
    resolveBattleMode({
      ...base,
      mode: "jackpot",
      crazyMode: false,
      valueScores: new Map([[1, 100], [2, 10]]),
    }).winnerTeam,
    jackpotTicket <= normalBoundary ? 1 : 2,
  );
  assert.equal(
    resolveBattleMode({
      ...base,
      mode: "jackpot",
      crazyMode: true,
      valueScores: new Map([[1, 100], [2, 10]]),
    }).winnerTeam,
    jackpotTicket <= crazyBoundary ? 1 : 2,
  );

  const tieTicket = referenceTicket(`${blockHash}:tiebreaker:${BATTLE_ID}`, 1);
  assert.equal(
    resolveBattleMode({
      ...base,
      mode: "normal",
      crazyMode: false,
      valueScores: new Map([[1, 50], [2, 50]]),
    }).winnerTeam,
    tieTicket <= 500_000 ? 1 : 2,
  );
});

test("creator net mirrors borrow and sponsored settlement independently", () => {
  const fixture = { secondHuman: true, fixedCardPrice: 10 };
  const borrowed = simulate("group", false, 25, 0, true, fixture);
  const borrowedOutcome = borrowed.outcomes[0]!;

  assert.equal(borrowedOutcome.creatorWonBattle, true);
  assert.equal(borrowedOutcome.creatorCost, 15);
  assert.equal(borrowedOutcome.creatorProfitLoss, 0);

  const sponsored = simulate("group", false, 0, 7.5, true, fixture);
  const sponsoredOutcome = sponsored.outcomes[0]!;

  assert.equal(sponsoredOutcome.creatorWonBattle, true);
  assert.equal(sponsoredOutcome.creatorCost, 27.5);
  assert.equal(sponsoredOutcome.creatorProfitLoss, -7.5);
});

test("battle simulation rejects an unfinished participant roster", () => {
  assert.throws(
    () => simulate("normal", false, 0, 0, false),
    (error: unknown) =>
      error instanceof Error
      && error.message === "battle_data_incomplete",
  );
});

test("dev simulator resolves the newest in-progress battle when battle ID is omitted", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  };
  const simulator = new BattleOutcomeSimulator(
    pool as never,
    "pepper",
  );

  await assert.rejects(
    simulator.simulate("target-user", undefined, candidates),
    (error: unknown) =>
      error instanceof Error && error.message === "battle_not_found",
  );
  assert.match(capturedSql, /b\.status = 'in_progress'/);
  assert.match(capturedSql, /ORDER BY b\.created_at DESC/);
  assert.deepEqual(capturedParams, ["target-user", undefined]);
});
