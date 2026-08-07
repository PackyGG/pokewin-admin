import assert from "node:assert/strict";
import test from "node:test";

import { simulateBattle } from "../src/battle-outcome-simulator.js";

const BATTLE_ID = "11111111-1111-4111-8111-111111111111";
const PACK_ID = "22222222-2222-4222-8222-222222222222";
const candidates = Array.from({ length: 5 }, (_, index) => ({
  blockNumber: 100 - index,
  blockHash: String(index + 1).repeat(64),
}));

function simulate(mode: string, crazyMode = false) {
  return simulateBattle({
    battle: {
      id: BATTLE_ID,
      mode,
      pack_ids: [PACK_ID, PACK_ID],
      additional_settings: crazyMode ? ["crazy_mode"] : [],
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
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        user_id: null,
        bot_id: "55555555-5555-4555-8555-555555555555",
        team_number: 2,
        team_position: 0,
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
    assert.equal(outcome.participants.length, 2);
    assert.equal(outcome.teamScores.length, 2);
    assert.equal(outcome.userTeam, 1);
    assert.equal(outcome.userWon, outcome.winnerTeam === 1);
    assert.equal(outcome.scoreType, "value");
    assert.equal(
      outcome.totalUnpacked,
      outcome.participants.reduce(
        (sum, participant) => sum + participant.totalValue,
        0,
      ),
    );
  }
});

test("all backend battle modes expose their mode-specific resolution", () => {
  const expected = {
    normal: "value",
    jackpot: "jackpot_value",
    group: "value",
    hp_rush: "hp",
    lowest: "points",
  } as const;

  for (const [mode, scoreType] of Object.entries(expected)) {
    const simulation = simulate(mode);
    assert.equal(simulation.mode, mode);
    assert.equal(simulation.outcomes.length, 5);
    for (const outcome of simulation.outcomes) {
      assert.equal(outcome.scoreType, scoreType);
      assert.equal(
        outcome.totalUnpacked,
        outcome.participants.reduce(
          (sum, participant) => sum + participant.totalValue,
          0,
        ),
      );
      if (mode === "group") {
        assert.equal(outcome.winnerTeam, 1);
        assert.equal(outcome.resolution.type, "group");
      } else if (mode === "jackpot") {
        assert.equal(outcome.resolution.type, "jackpot");
        assert.ok((outcome.resolution.ticket ?? 0) >= 1);
      } else if (mode === "lowest") {
        assert.equal(
          outcome.teamScores.reduce((sum, team) => sum + team.score, 0),
          2,
        );
      }
    }
  }
});

test("crazy mode inverts normal score selection", () => {
  const normal = simulate("normal", false);
  const crazy = simulate("normal", true);

  for (let index = 0; index < normal.outcomes.length; index += 1) {
    const high = normal.outcomes[index]!;
    const low = crazy.outcomes[index]!;
    const scores = high.teamScores.map((team) => team.score);
    if (Math.max(...scores) !== Math.min(...scores)) {
      assert.notEqual(high.winnerTeam, low.winnerTeam);
    }
  }
});
