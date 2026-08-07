import assert from "node:assert/strict";
import test from "node:test";

import { simulateBattle } from "../src/battle-outcome-simulator.js";

const BATTLE_ID = "11111111-1111-4111-8111-111111111111";
const PACK_ID = "22222222-2222-4222-8222-222222222222";
const candidates = Array.from({ length: 5 }, (_, index) => ({
  blockNumber: 100 - index,
  blockHash: String(index + 1).repeat(64),
}));

function simulate(
  mode: string,
  crazyMode = false,
  creatorBorrowPercentage = 0,
  sponsorshipAmountPaid = 0,
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
        user_id: null,
        bot_id: "55555555-5555-4555-8555-555555555555",
        team_number: mode === "group" ? 1 : 2,
        team_position: 0,
        borrow_percentage: 0,
      },
    ],
    packs: [
      { id: PACK_ID, name: "Test Pack", image_url: null, cards_per_open: 1 },
      { id: PACK_ID, name: "Test Pack", image_url: null, cards_per_open: 1 },
    ],
    cardsByPack: new Map([[
      PACK_ID,
      [
        {
          pack_id: PACK_ID,
          card_id: "66666666-6666-4666-8666-666666666666",
          weight: 1,
          order: 0,
          name: "Rare",
          image_url: "/rare.png",
          price: "100.00",
          hp: 10,
          rarity: "rare",
        },
        {
          pack_id: PACK_ID,
          card_id: "77777777-7777-4777-8777-777777777777",
          weight: 1,
          order: 1,
          name: "Common",
          image_url: "/common.png",
          price: "5.00",
          hp: 500,
          rarity: "common",
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
    simulation.outcomes.map((outcome) => outcome.blockHash),
    candidates.map((candidate) => candidate.blockHash),
  );
  assert.deepEqual(simulate("normal"), simulation);
  for (const outcome of simulation.outcomes) {
    assert.equal(outcome.creatorTeam, 1);
    assert.equal(outcome.creatorWonBattle, outcome.winningTeam === 1);
    assert.equal(outcome.creatorCost, 20);
    assert.equal(
      outcome.creatorProfitLoss,
      Number((outcome.creatorPayout - outcome.creatorCost).toFixed(2)),
    );
    assert.equal(outcome.creatorAmount, Math.abs(outcome.creatorProfitLoss));
  }
});

test("all backend battle modes return creator-level settlement results only", () => {
  for (const mode of ["normal", "jackpot", "group", "hp_rush", "lowest"]) {
    const simulation = simulate(mode);
    assert.equal(simulation.mode, mode);
    assert.equal(simulation.outcomes.length, 5);
    for (const outcome of simulation.outcomes) {
      assert.deepEqual(Object.keys(outcome).sort(), [
        "blockHash",
        "blockNumber",
        "creatorAmount",
        "creatorCost",
        "creatorMoneyResult",
        "creatorPayout",
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

test("creator net includes borrow scaling and battle sponsorship cost", () => {
  const simulation = simulate("group", false, 25, 7.5);
  const outcome = simulation.outcomes[0]!;

  assert.equal(outcome.creatorWonBattle, true);
  assert.equal(outcome.creatorCost, 22.5);
  assert.ok(outcome.creatorPayout > 0);
  assert.equal(
    outcome.creatorMoneyResult,
    outcome.creatorProfitLoss > 0 ? "profit" : "loss",
  );
});
