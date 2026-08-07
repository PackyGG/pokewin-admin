import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { BattleOutcomeSource } from "../src/battle-outcome-simulator.js";
import type { BattleTestConfigSource } from "../src/battle-test-config.js";
import { serviceRequestAuthorized } from "../src/auth.js";
import {
  EosRandomBlockService,
  EOS_RANDOM_BLOCK_CONFIG_PATH,
  EOS_RANDOM_BLOCK_PATH,
  isUnauthenticatedEosRandomBlockRequest,
  registerEosRandomBlockRoutes,
  selectBattleTestOutcome,
  type EosRandomBlockSource,
} from "../src/eos-random-block-routes.js";

const blocks = Array.from({ length: 5 }, (_, index) => ({
  blockNumber: 100 - index,
  blockHash: String(index + 1).repeat(64),
}));

test("EOS random-block path is unauthenticated only for POST", () => {
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("POST", EOS_RANDOM_BLOCK_PATH),
    true,
  );
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("GET", EOS_RANDOM_BLOCK_PATH),
    false,
  );
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("POST", "/v1/testing/other"),
    false,
  );
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("GET", EOS_RANDOM_BLOCK_CONFIG_PATH),
    false,
  );
});

test("EOS test config read and writes require the admin token", () => {
  const config = { API_TOKEN: "read-token", API_ADMIN_TOKEN: "admin-token" };
  for (const method of ["GET", "PUT"] as const) {
    assert.equal(
      serviceRequestAuthorized(method, EOS_RANDOM_BLOCK_CONFIG_PATH, config.API_TOKEN, config),
      false,
    );
    assert.equal(
      serviceRequestAuthorized(method, EOS_RANDOM_BLOCK_CONFIG_PATH, config.API_ADMIN_TOKEN, config),
      true,
    );
  }
});

test("EOS service fetches the latest five irreversible blocks and selects one", async () => {
  const requestedBlocks: number[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/chain/get_info")) {
      return Response.json({ last_irreversible_block_num: 500 });
    }
    assert.ok(url.endsWith("/v1/chain/get_block"));
    const body = JSON.parse(String(init?.body)) as { block_num_or_id: number };
    requestedBlocks.push(body.block_num_or_id);
    return Response.json({
      block_num: body.block_num_or_id,
      id: body.block_num_or_id.toString(16).padStart(64, "0"),
    });
  }) as typeof fetch;
  const service = new EosRandomBlockService(
    fetcher,
    () => 2,
  );

  const result = await service.select();

  assert.deepEqual(requestedBlocks, [500, 499, 498, 497, 496]);
  assert.equal(result.candidates.length, 5);
  assert.equal(result.selectedIndex, 2);
  assert.equal(result.selectedBlock.blockNumber, 498);
  assert.equal(result.selectedBlock, result.candidates[2]);
});

test("EOS random-block route accepts battle identity and returns only the block hash when simulation is disabled", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        selectedIndex: 3,
        selectedBlock: blocks[3]!,
        candidates: blocks,
      };
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source);

  const response = await app.inject({
    method: "POST",
    url: EOS_RANDOM_BLOCK_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { blockHash: blocks[3]!.blockHash });
  await app.close();
});

test("EOS random-block route adds five dev battle outcomes when configured", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        selectedIndex: 1,
        selectedBlock: blocks[1]!,
        candidates: blocks,
      };
    },
  };
  const outcomes: BattleOutcomeSource = {
    async simulate(userID, battleID, candidates) {
      assert.equal(userID, "test-user-123");
      assert.equal(battleID, "11111111-1111-4111-8111-111111111111");
      assert.deepEqual(candidates, blocks);
      return {
        battleId: "11111111-1111-4111-8111-111111111111",
        mode: "normal",
        crazyMode: false,
        currency: "real",
        creatorUserID: "test-user-123",
        outcomes: candidates.map((candidate) => ({
          blockNumber: candidate.blockNumber,
          winningTeam: 1,
          creatorTeam: 1,
          creatorWonBattle: true,
          creatorCost: 10,
          creatorProfitLoss: 5,
        })),
      };
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source, outcomes);

  const response = await app.inject({
    method: "POST",
    url: EOS_RANDOM_BLOCK_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    selectedBlockNumber: blocks[1]!.blockNumber,
    battleId: "11111111-1111-4111-8111-111111111111",
    mode: "normal",
    crazyMode: false,
    currency: "real",
    creatorUserID: "test-user-123",
    outcomes: blocks.map((candidate) => ({
      blockNumber: candidate.blockNumber,
      winningTeam: 1,
      creatorTeam: 1,
      creatorWonBattle: true,
      creatorCost: 10,
      creatorProfitLoss: 5,
    })),
  });
  await app.close();
});

test("only-loses selection chooses a loss or the lowest available profit", () => {
  const outcome = (blockNumber: number, creatorProfitLoss: number) => ({
    blockNumber,
    winningTeam: 1,
    creatorTeam: 1,
    creatorWonBattle: creatorProfitLoss >= 0,
    creatorCost: 10,
    creatorProfitLoss,
  });
  const mixed = [outcome(10, 50), outcome(9, -10), outcome(8, -30)];
  assert.equal(selectBattleTestOutcome(mixed, 10, false).blockNumber, 10);
  assert.equal(selectBattleTestOutcome(mixed, 10, true, () => 1).blockNumber, 8);

  const profits = [outcome(10, 50), outcome(9, 5), outcome(8, 20)];
  assert.equal(selectBattleTestOutcome(profits, 10, true).blockNumber, 9);
});

test("EOS test config routes read and update the persisted setting", async () => {
  let enabled = false;
  const config: BattleTestConfigSource = {
    async get() {
      return { userOnlyLoses: enabled, updatedAt: null, updatedBy: null };
    },
    async set(userOnlyLoses, actor) {
      enabled = userOnlyLoses;
      return {
        userOnlyLoses,
        updatedAt: "2026-08-07T00:00:00.000Z",
        updatedBy: actor,
      };
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, undefined, undefined, config);

  const before = await app.inject({ method: "GET", url: EOS_RANDOM_BLOCK_CONFIG_PATH });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().data.userOnlyLoses, false);

  const updated = await app.inject({
    method: "PUT",
    url: EOS_RANDOM_BLOCK_CONFIG_PATH,
    payload: { userOnlyLoses: true, actor: "motha" },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().data, {
    userOnlyLoses: true,
    updatedAt: "2026-08-07T00:00:00.000Z",
    updatedBy: "motha",
  });
  await app.close();
});

test("EOS random-block route rejects invalid input and hides provider errors", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      throw new Error("provider details must not escape");
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source);

  const invalid = await app.inject({
    method: "POST",
    url: EOS_RANDOM_BLOCK_PATH,
    payload: { userID: "", battleID: "not-a-uuid", extra: true },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "invalid_request");

  const unavailable = await app.inject({
    method: "POST",
    url: EOS_RANDOM_BLOCK_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: "eos_unavailable" });
  assert.doesNotMatch(unavailable.body, /provider details/);
  await app.close();
});
