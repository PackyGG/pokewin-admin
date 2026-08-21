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

test("only the userID-free chain routes are unauthenticated", () => {
  // Every route that can name a user — and therefore reach the database or a
  // rule sequence — must fall through to the bearer check.
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("POST", EOS_RANDOM_BLOCK_PATH),
    false,
  );
  assert.equal(
    isUnauthenticatedEosRandomBlockRequest("POST", EOS_CHAIN_INFO_PATH),
    false,
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

  assert.equal(infoRequests, 15);
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

test("the testing route is gone entirely, not merely gated", async () => {
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

  assert.equal(response.statusCode, 404);
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

test("EOS-compatible battle request can resolve the active battle from only userID", async () => {
  let receivedBattleId: string | undefined = "not-called";
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
    async simulate(_userID, battleID) {
      receivedBattleId = battleID;
      return {
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
      };
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source, outcomes);

  const response = await app.inject({
    method: "POST",
    url: EOS_CHAIN_INFO_PATH,
    payload: { userID: "test-user-123" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(receivedBattleId, undefined);
  assert.equal(response.json().last_irreversible_block_num, blocks[0]!.blockNumber);
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
    url: EOS_CHAIN_INFO_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.last_irreversible_block_num, blocks[4]!.blockNumber);
  assert.equal(body.last_irreversible_block_id, blocks[4]!.blockHash);
  // The steered block is all the caller may learn. Nothing about the battle,
  // the alternate endings, or the creator's profit may ride along.
  assert.equal(body.selected, undefined);
  assert.equal(body.selectedBlockNumber, undefined);
  assert.equal(body.otherPossibleEndings, undefined);
  assert.equal(body.outcomes, undefined);
  assert.equal(body.creatorUserID, undefined);
  assert.equal(body.battleId, undefined);
  await app.close();
});

test("only-loses selection chooses a battle loss or the lowest available profit", () => {
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
    outcome(9, true, -30),
    outcome(8, false, -10),
  ];
  assert.equal(selectBattleTestOutcome(mixed, 10, false).blockNumber, 10);
  assert.equal(selectBattleTestOutcome(mixed, 10, true).blockNumber, 8);

  const profits = [
    outcome(10, true, 50),
    outcome(9, true, 5),
    outcome(8, true, 20),
  ];
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
      return { environment: "prod", userOnlyLoses: enabled, updatedAt: null, updatedBy: null };
    },
    async set(userOnlyLoses, actor) {
      enabled = userOnlyLoses;
      return {
        environment: "prod",
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
  assert.deepEqual(before.json().data, {
    environment: "prod",
    userOnlyLoses: false,
    updatedAt: null,
    updatedBy: null,
  });

  const updated = await app.inject({
    method: "PUT",
    url: EOS_RANDOM_BLOCK_CONFIG_PATH,
    payload: { userOnlyLoses: true, actor: "motha" },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().data, {
    environment: "prod",
    userOnlyLoses: true,
    updatedAt: "2026-08-07T00:00:00.000Z",
    updatedBy: "motha",
  });
  await app.close();
});

test("EOS global config accepts repeating weighted-random flows", async () => {
  let savedInput: unknown[] | null = null;
  const config: BattleTestConfigSource = {
    async get() {
      return { userOnlyLoses: false, updatedAt: null, updatedBy: null };
    },
    async set() {
      throw new Error("legacy setter must not handle flow payloads");
    },
    async setFlow(rules, persistent, randomized, enabled, actor) {
      savedInput = [rules, persistent, randomized, enabled, actor];
      return {
        environment: "prod",
        userOnlyLoses: false,
        rules,
        currentRuleIndex: 0,
        remainingInRule: rules[0]!.count,
        persistent,
        randomized,
        enabled,
        updatedAt: "2026-08-21T00:00:00.000Z",
        updatedBy: actor,
      };
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, undefined, undefined, config);
  const rules = [
    { target: "loss", strategy: "lowest_profit", count: 3 },
    { target: "win", strategy: "random", count: 1 },
  ];
  const response = await app.inject({
    method: "PUT",
    url: EOS_RANDOM_BLOCK_CONFIG_PATH,
    payload: { rules, persistent: true, randomized: true, enabled: true, actor: "hifoen" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(savedInput, [rules, true, true, true, "hifoen"]);
  assert.equal(response.json().data.randomized, true);
  await app.close();
});

test("EOS user sequence config routes list, reset, and delete rules", async () => {
  const saved = {
    environment: "prod" as const,
    userId: "cm1234567890abcdefghijklmnopqrst",
    username: "tester",
    rules: [{ target: "loss" as const, strategy: "lowest_profit" as const, count: 2 }],
    currentRuleIndex: 0,
    remainingInRule: 2,
    persistent: true,
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
    async setUser(userId, username, rules, persistent, enabled, actor) {
      assert.equal(userId, saved.userId);
      assert.equal(username, "tester");
      assert.deepEqual(rules, saved.rules);
      assert.equal(persistent, true);
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
      persistent: true,
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

test("battle retries reuse one durable EOS response and consume one rule", async () => {
  const battleId = "11111111-1111-4111-8111-111111111111";
  let selects = 0;
  let consumes = 0;
  let saved: Record<string, unknown> | null = null;
  const source: EosRandomBlockSource = {
    async select() {
      selects += 1;
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
        battleId,
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
      };
    },
  };
  const config: BattleTestConfigSource = {
    async get() {
      return { environment: "prod", userOnlyLoses: false, updatedAt: null, updatedBy: null };
    },
    async set() {
      throw new Error("not used");
    },
    async getBattleSelection() {
      return saved;
    },
    async consumeUserInstruction() {
      consumes += 1;
      return { target: "any", strategy: "random" };
    },
    async saveBattleSelection(_userId, _battleId, response) {
      saved ??= response;
      return saved;
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source, outcomes, config);
  const request = {
    method: "POST" as const,
    url: EOS_CHAIN_INFO_PATH,
    payload: { userID: "test-user-123", battleID: battleId },
  };
  const first = await app.inject(request);
  const retry = await app.inject(request);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(retry.json(), first.json());
  assert.equal(selects, 1);
  assert.equal(consumes, 1);
  await app.close();
});

test("rejected requests reveal neither the schema nor provider errors", async () => {
  const source: EosRandomBlockSource = {
    async select() {
      throw new Error("provider details must not escape");
    },
  };
  const app = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(app, source);

  // A 400 must not narrate what the body should have looked like: echoing the
  // validator's own wording ("expected string, received undefined",
  // "Invalid UUID", "Unrecognized key") hands a caller the request shape.
  for (
    const payload of [
      { battleID: "11111111-1111-4111-8111-111111111111" },
      { userID: "", battleID: "not-a-uuid" },
      { userID: "test-user-123", extra: true },
    ]
  ) {
    const invalid = await app.inject({
      method: "POST",
      url: EOS_CHAIN_INFO_PATH,
      payload,
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: "invalid_request" });
    assert.doesNotMatch(invalid.body, /userID|battleID|expected|Unrecognized/i);
  }

  await app.close();

  // Provider failures surface as a bare 503 — the thrown message never reaches
  // the caller. Needs an outcome source, or the request is rejected as
  // incomplete before any provider is contacted.
  const outcomes: BattleOutcomeSource = {
    async simulate() {
      throw new Error("simulate must not be reached");
    },
  };
  const failing = Fastify({ logger: false });
  await registerEosRandomBlockRoutes(failing, source, outcomes);

  const unavailable = await failing.inject({
    method: "POST",
    url: EOS_CHAIN_INFO_PATH,
    payload: {
      userID: "test-user-123",
      battleID: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: "eos_unavailable" });
  assert.doesNotMatch(unavailable.body, /provider details/);
  await failing.close();
});
