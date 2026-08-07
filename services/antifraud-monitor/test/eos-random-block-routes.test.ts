import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { BattleOutcomeSource } from "../src/battle-outcome-simulator.js";
import type { BattleTestConfigSource } from "../src/battle-test-config.js";
import { serviceRequestAuthorized } from "../src/auth.js";
import {
  EosRandomBlockService,
  EOS_CHAIN_BLOCK_PATH,
  EOS_CHAIN_INFO_PATH,
  EOS_RANDOM_BLOCK_CONFIG_PATH,
  EOS_RANDOM_BLOCK_PATH,
  EOS_RANDOM_BLOCK_USER_CONFIG_PATH,
  isUnauthenticatedEosRandomBlockRequest,
  registerEosRandomBlockRoutes,
  selectBattleTestInstructionOutcome,
  selectBattleTestOutcome,
  type EosRandomBlockSource,
} from "../src/eos-random-block-routes.js";

const blocks = Array.from({ length: 5 }, (_, index) => ({
  blockNumber: 100 - index,
  blockHash: String(index + 1).repeat(64),
  blockTimestamp: `2026-08-07T21:29:${String(42 - index).padStart(2, "0")}.000`,
}));

const chainInfo = {
  server_version: "42b514a1",
  chain_id: "aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906",
  head_block_num: 102,
  last_irreversible_block_num: 100,
  last_irreversible_block_id: "f".repeat(64),
  head_block_id: "e".repeat(64),
  head_block_time: "2026-08-07T21:29:43.000",
};

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
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("GET", EOS_CHAIN_INFO_PATH),
    true,
  );
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("POST", EOS_CHAIN_INFO_PATH),
    true,
  );
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("POST", EOS_CHAIN_BLOCK_PATH),
    true,
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
  assert.equal(
    serviceRequestAuthorized(
      "GET",
      EOS_RANDOM_BLOCK_USER_CONFIG_PATH,
      config.API_TOKEN,
      config,
    ),
    false,
  );
});

test("EOS service races providers and fetches a fresh five-block window per request", async () => {
  const requestedBlocks: number[] = [];
  let infoRequests = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/chain/get_info")) {
      infoRequests += 1;
      if (url.startsWith("https://api.eostitan.com")) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }
      if (!url.startsWith("https://mainnet.genereos.io")) {
        return new Response(null, { status: 503 });
      }
      return Response.json({ ...chainInfo, last_irreversible_block_num: 500 });
    }
    assert.ok(url.endsWith("/v1/chain/get_block"));
    const body = JSON.parse(String(init?.body)) as { block_num_or_id: number };
    requestedBlocks.push(body.block_num_or_id);
    return Response.json({
      block_num: body.block_num_or_id,
      id: body.block_num_or_id.toString(16).padStart(64, "0"),
      timestamp: "2026-08-07T21:29:42.000",
    });
  }) as typeof fetch;
  const service = new EosRandomBlockService(
    fetcher,
    () => 2,
  );

  const [result, concurrentResult] = await Promise.all([
    service.select(),
    service.select(),
  ]);
  const freshResult = await service.select();

  assert.equal(infoRequests, 39);
  assert.deepEqual(requestedBlocks, [
    500, 499, 498, 497, 496,
    500, 499, 498, 497, 496,
    500, 499, 498, 497, 496,
  ]);
  assert.equal(result.provider, "https://mainnet.genereos.io");
  assert.equal(result.candidates.length, 5);
  assert.equal(result.selectedIndex, 2);
  assert.equal(result.selectedBlock.blockNumber, 498);
  assert.equal(result.selectedBlock, result.candidates[2]);
  assert.equal(result.chainInfo.head_block_num, 102);
  assert.deepEqual(concurrentResult, result);
  assert.deepEqual(freshResult, result);
});

test("EOS random-block route accepts battle identity and returns only the block hash when simulation is disabled", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        chainInfo,
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
  assert.deepEqual(response.json(), {
    ...chainInfo,
    last_irreversible_block_num: blocks[3]!.blockNumber,
    last_irreversible_block_id: blocks[3]!.blockHash,
    last_irreversible_block_time: blocks[3]!.blockTimestamp,
    blockHash: blocks[3]!.blockHash,
    selected: {
      blockNumber: blocks[3]!.blockNumber,
      blockId: blocks[3]!.blockHash,
      timestamp: blocks[3]!.blockTimestamp,
      provider: "https://eos.example",
    },
  });
  await app.close();
});

test("EOS-compatible routes return native payloads with no testing metadata", async () => {
  const rawBlock = {
    timestamp: blocks[2]!.blockTimestamp,
    producer: "eosproducer",
    confirmed: 0,
    id: blocks[2]!.blockHash,
    block_num: blocks[2]!.blockNumber,
    transactions: [],
  };
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        chainInfo,
        selectedIndex: 2,
        selectedBlock: blocks[2]!,
        candidates: blocks,
      };
    },
    async getBlock(blockNumOrId) {
      assert.equal(blockNumOrId, blocks[2]!.blockNumber);
      return rawBlock;
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source);

  const info = await app.inject({ method: "GET", url: EOS_CHAIN_INFO_PATH });
  assert.equal(info.statusCode, 200);
  assert.deepEqual(info.json(), {
    ...chainInfo,
    last_irreversible_block_num: blocks[2]!.blockNumber,
    last_irreversible_block_id: blocks[2]!.blockHash,
    last_irreversible_block_time: blocks[2]!.blockTimestamp,
  });
  assert.equal(info.json().selected, undefined);
  assert.equal(info.json().otherPossibleEndings, undefined);

  const block = await app.inject({
    method: "POST",
    url: EOS_CHAIN_BLOCK_PATH,
    payload: { block_num_or_id: blocks[2]!.blockNumber },
  });
  assert.equal(block.statusCode, 200);
  assert.deepEqual(block.json(), rawBlock);
  await app.close();
});

test("EOS-compatible battle request applies and consumes a personal sequence", async () => {
  let consumedFor: string | null = null;
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        chainInfo,
        selectedIndex: 0,
        selectedBlock: blocks[0]!,
        candidates: blocks,
      };
    },
  };
  const outcomes: BattleOutcomeSource = {
    async simulate() {
      return {
        battleId: "11111111-1111-4111-8111-111111111111",
        mode: "normal",
        crazyMode: false,
        currency: "real",
        creatorUserID: "test-user-123",
        outcomes: blocks.map((candidate, index) => ({
          blockNumber: candidate.blockNumber,
          winningTeam: index < 2 ? 1 : 2,
          creatorTeam: 1,
          creatorWonBattle: index < 2,
          creatorCost: 10,
          creatorProfitLoss: [20, 5, -10, -20, -30][index]!,
        })),
      };
    },
  };
  const config: BattleTestConfigSource = {
    async get() {
      return { userOnlyLoses: false, updatedAt: null, updatedBy: null };
    },
    async set() {
      throw new Error("not used");
    },
    async consumeUserInstruction(userId) {
      consumedFor = userId;
      return { target: "win", strategy: "lowest_profit" };
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source, outcomes, config);

  const response = await app.inject({
    method: "POST",
    url: EOS_CHAIN_INFO_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(consumedFor, "test-user-123");
  assert.deepEqual(response.json(), {
    ...chainInfo,
    last_irreversible_block_num: blocks[1]!.blockNumber,
    last_irreversible_block_id: blocks[1]!.blockHash,
    last_irreversible_block_time: blocks[1]!.blockTimestamp,
  });
  await app.close();
});

test("EOS random-block route returns one selected and four alternate endings", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        chainInfo,
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
    ...chainInfo,
    last_irreversible_block_num: blocks[1]!.blockNumber,
    last_irreversible_block_id: blocks[1]!.blockHash,
    last_irreversible_block_time: blocks[1]!.blockTimestamp,
    selectedBlockNumber: blocks[1]!.blockNumber,
    battleId: "11111111-1111-4111-8111-111111111111",
    mode: "normal",
    crazyMode: false,
    currency: "real",
    creatorUserID: "test-user-123",
    otherPossibleEndings: blocks
      .filter((candidate) => candidate.blockNumber !== blocks[1]!.blockNumber)
      .map((candidate) => ({
        blockNumber: candidate.blockNumber,
        blockId: candidate.blockHash,
        timestamp: candidate.blockTimestamp,
        provider: "https://eos.example",
        winningTeam: 1,
        creatorTeam: 1,
        creatorWonBattle: true,
        creatorCost: 10,
        creatorProfitLoss: 5,
      })),
    selected: {
      blockNumber: blocks[1]!.blockNumber,
      blockId: blocks[1]!.blockHash,
      timestamp: blocks[1]!.blockTimestamp,
      provider: "https://eos.example",
      winningTeam: 1,
      creatorTeam: 1,
      creatorWonBattle: true,
      creatorCost: 10,
      creatorProfitLoss: 5,
    },
  });
  await app.close();
});

test("chain info block id follows the outcome selected by only-loses mode", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      return {
        provider: "https://eos.example",
        chainInfo,
        selectedIndex: 0,
        selectedBlock: blocks[0]!,
        candidates: blocks,
      };
    },
  };
  const outcomes: BattleOutcomeSource = {
    async simulate() {
      return {
        battleId: "11111111-1111-4111-8111-111111111111",
        mode: "normal",
        crazyMode: false,
        currency: "real",
        creatorUserID: "test-user-123",
        outcomes: blocks.map((candidate, index) => ({
          blockNumber: candidate.blockNumber,
          winningTeam: index === 4 ? 2 : 1,
          creatorTeam: 1,
          creatorWonBattle: index !== 4,
          creatorCost: 10,
          creatorProfitLoss: index === 4 ? -10 : 5,
        })),
      };
    },
  };
  const config: BattleTestConfigSource = {
    async get() {
      return { userOnlyLoses: true, updatedAt: null, updatedBy: null };
    },
    async set() {
      throw new Error("not used");
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source, outcomes, config);

  const response = await app.inject({
    method: "POST",
    url: EOS_RANDOM_BLOCK_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.selectedBlockNumber, blocks[4]!.blockNumber);
  assert.equal(body.last_irreversible_block_num, blocks[4]!.blockNumber);
  assert.equal(body.last_irreversible_block_id, blocks[4]!.blockHash);
  assert.equal(body.selected.blockId, blocks[4]!.blockHash);
  assert.equal(body.selected.creatorProfitLoss, -10);
  assert.equal(body.outcomes, undefined);
  assert.equal(body.otherPossibleEndings.length, 4);
  assert.deepEqual(
    body.otherPossibleEndings.map((ending: { blockNumber: number }) =>
      ending.blockNumber
    ),
    blocks.slice(0, 4).map((block) => block.blockNumber),
  );
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

test("personal outcome selection supports target and profit strategy fallbacks", () => {
  const outcome = (
    blockNumber: number,
    creatorWonBattle: boolean,
    creatorProfitLoss: number,
  ) => ({
    blockNumber,
    winningTeam: creatorWonBattle ? 1 : 2,
    creatorTeam: 1,
    creatorWonBattle,
    creatorCost: 10,
    creatorProfitLoss,
  });
  const mixed = [
    outcome(10, true, 50),
    outcome(9, true, 5),
    outcome(8, false, -10),
    outcome(7, false, -30),
  ];
  assert.equal(
    selectBattleTestInstructionOutcome(
      mixed,
      10,
      { target: "win", strategy: "lowest_profit" },
    ).blockNumber,
    9,
  );
  assert.equal(
    selectBattleTestInstructionOutcome(
      mixed,
      10,
      { target: "loss", strategy: "highest_profit" },
    ).blockNumber,
    8,
  );
  assert.equal(
    selectBattleTestInstructionOutcome(
      mixed.slice(0, 2),
      10,
      { target: "loss", strategy: "random" },
    ).blockNumber,
    9,
  );
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

test("EOS user sequence config routes list, reset, and delete rules", async () => {
  const saved = {
    userId: "11111111-1111-4111-8111-111111111111",
    username: "tester",
    rules: [{ target: "loss" as const, strategy: "lowest_profit" as const, count: 2 }],
    currentRuleIndex: 0,
    remainingInRule: 2,
    enabled: true,
    updatedAt: "2026-08-07T00:00:00.000Z",
    updatedBy: "motha",
  };
  let deleted: string | null = null;
  const config: BattleTestConfigSource = {
    async get() {
      return { userOnlyLoses: false, updatedAt: null, updatedBy: null };
    },
    async set() {
      throw new Error("not used");
    },
    async listUsers() {
      return [saved];
    },
    async setUser(userId, username, rules, enabled, actor) {
      assert.equal(userId, saved.userId);
      assert.equal(username, "tester");
      assert.deepEqual(rules, saved.rules);
      assert.equal(enabled, true);
      assert.equal(actor, "motha");
      return saved;
    },
    async deleteUser(userId) {
      deleted = userId;
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, undefined, undefined, config);

  const listed = await app.inject({
    method: "GET",
    url: EOS_RANDOM_BLOCK_USER_CONFIG_PATH,
  });
  assert.deepEqual(listed.json(), { data: [saved] });

  const updated = await app.inject({
    method: "PUT",
    url: `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/${saved.userId}`,
    payload: {
      username: "tester",
      rules: saved.rules,
      enabled: true,
      actor: "motha",
    },
  });
  assert.deepEqual(updated.json(), { data: saved });

  const removed = await app.inject({
    method: "DELETE",
    url: `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/${saved.userId}`,
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(deleted, saved.userId);
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
