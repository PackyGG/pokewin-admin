import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { BattleOutcomeSource } from "../src/battle-outcome-simulator.js";
import {
  EosRandomBlockService,
  EOS_RANDOM_BLOCK_PATH,
  isUnauthenticatedEosRandomBlockRequest,
  registerEosRandomBlockRoutes,
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
  const randomValues = [0, 2];
  const service = new EosRandomBlockService(
    fetcher,
    () => randomValues.shift() ?? 0,
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
        outcomes: [],
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
    blockHash: blocks[1]!.blockHash,
    battleId: "11111111-1111-4111-8111-111111111111",
    mode: "normal",
    crazyMode: false,
    outcomes: [],
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
