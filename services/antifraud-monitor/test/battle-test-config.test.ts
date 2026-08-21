import assert from "node:assert/strict";
import test from "node:test";

import { PgBattleTestConfigStore } from "../src/battle-test-config.js";

test("global configuration reads and writes only its deployment environment", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return {
        rows: [{
          user_only_loses: true,
          updated_at: new Date("2026-08-08T00:00:00.000Z"),
          updated_by: "motha",
        }],
      };
    },
  };
  const store = new PgBattleTestConfigStore(pool as never, "prod");
  assert.equal((await store.get()).environment, "prod");
  assert.equal((await store.set(false, "hifoen")).environment, "prod");
  assert.match(calls[0]!.text, /WHERE environment = \$1/);
  assert.match(calls[1]!.text, /ON CONFLICT \(environment\)/);
  assert.equal(calls[0]!.params[0], "prod");
  assert.equal(calls[1]!.params[0], "prod");
});

test("persistent user rules stay active without consuming their counter", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        return { rows: [{ battle_id: "test-battle" }] };
      }
      if (text.includes("FROM battle_test_user_sequences")) {
        return {
          rows: [{
            user_id: "test-user-123",
            username: "tester",
            rules: [{ target: "loss", strategy: "lowest_profit", count: 1 }],
            current_rule_index: 0,
            remaining_in_rule: 1,
            persistent: true,
            enabled: true,
            updated_at: new Date("2026-08-08T00:00:00.000Z"),
            updated_by: "motha",
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  const first = await store.consumeUserInstruction(
    "test-user-123",
    "00000000-0000-0000-0000-000000000001",
  );
  const second = await store.consumeUserInstruction(
    "test-user-123",
    "00000000-0000-0000-0000-000000000002",
  );

  assert.deepEqual(first, {
    target: "loss",
    strategy: "lowest_profit",
    minMultiplier: null,
    maxMultiplier: null,
  });
  assert.deepEqual(second, first);
  assert.equal(
    statements.some((statement) =>
      statement.includes("UPDATE battle_test_user_sequences")
    ),
    false,
  );
});

test("every user-sequence query is scoped to the deployment's environment", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const record = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    if (text.includes("INSERT INTO battle_test_eos_selections")) {
      return { rows: [{ battle_id: "test-battle" }] as never[] };
    }
    return { rows: [] as never[] };
  };
  const client = {
    query: record,
    release() {},
  };
  const pool = {
    query: record,
    async connect() {
      return client;
    },
  };
  const store = new PgBattleTestConfigStore(pool as never, "prod");

  await store.listUsers();
  await store.deleteUser("test-user-123");
  await store.consumeUserInstruction("test-user-123");

  const sequenceCalls = calls.filter((call) =>
    call.text.includes("battle_test_user_sequences")
  );
  assert.ok(sequenceCalls.length >= 3);
  for (const call of sequenceCalls) {
    // A query that forgets the scope would read or write another
    // environment's marks for the same userID.
    assert.match(call.text, /environment = \$1/);
    assert.equal(call.params[0], "prod");
  }
});

test("ordered user flows retain multiplier ranges and disable after their final step", async () => {
  const row = {
    environment: "dev",
    user_id: "test-user-123",
    username: "tester",
    rules: [
      {
        target: "win", strategy: "lowest_multiplier", count: 2,
        minMultiplier: 1.25, maxMultiplier: 2.5,
      },
      {
        target: "loss", strategy: "highest_multiplier", count: 1,
        minMultiplier: 3, maxMultiplier: 8,
      },
    ],
    current_rule_index: 0,
    remaining_in_rule: 2,
    persistent: false,
    randomized: false,
    enabled: true,
    updated_at: new Date("2026-08-08T00:00:00.000Z"),
    updated_by: "motha",
  };
  let reservation = 0;
  const client = {
    async query(text: string, params: unknown[] = []) {
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        reservation += 1;
        return { rows: [{ battle_id: String(reservation) }] };
      }
      if (text.includes("FROM battle_test_user_sequences")) {
        return { rows: [{ ...row }] };
      }
      if (text.includes("UPDATE battle_test_user_sequences")) {
        row.current_rule_index = params[2] as number;
        row.remaining_in_rule = params[3] as number;
        row.enabled = params[4] as boolean;
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [] }; },
  };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  const instructions = [];
  for (let index = 1; index <= 4; index += 1) {
    instructions.push(await store.consumeUserInstruction(
      row.user_id,
      `00000000-0000-0000-0000-00000000000${index}`,
    ));
  }

  assert.deepEqual(instructions, [
    {
      target: "win", strategy: "lowest_multiplier",
      minMultiplier: 1.25, maxMultiplier: 2.5,
    },
    {
      target: "win", strategy: "lowest_multiplier",
      minMultiplier: 1.25, maxMultiplier: 2.5,
    },
    {
      target: "loss", strategy: "highest_multiplier",
      minMultiplier: 3, maxMultiplier: 8,
    },
    null,
  ]);
  assert.equal(row.enabled, false);
});

test("idempotent retries preserve a global rule's range and provenance", async () => {
  const instruction = {
    target: "loss",
    strategy: "lowest_multiplier",
    minMultiplier: 1.1,
    maxMultiplier: 1.8,
    source: "global",
  };
  const client = {
    async query(text: string) {
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        return { rows: [] };
      }
      if (text.includes("SELECT user_id, instruction")) {
        return { rows: [{ user_id: "test-user-123", instruction }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  assert.deepEqual(
    await store.consumeUserInstruction(
      "test-user-123",
      "00000000-0000-0000-0000-000000000001",
    ),
    instruction,
  );
});

test("flow writes reject reversed ranges and one-shot randomized rules", async () => {
  let queryCount = 0;
  const pool = {
    async query() {
      queryCount += 1;
      return { rows: [] };
    },
  };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  await assert.rejects(
    store.setUserFlow(
      "test-user-123",
      "tester",
      [{
        target: "any", strategy: "random", count: 1,
        minMultiplier: 3, maxMultiplier: 2,
      }],
      true,
      false,
      true,
      "motha",
    ),
    /Invalid battle test user rules/,
  );
  await assert.rejects(
    store.setUserFlow(
      "test-user-123",
      "tester",
      [{
        target: "loss", strategy: "random", count: 1,
        minMultiplier: null, maxMultiplier: null,
      }],
      false,
      true,
      true,
      "motha",
    ),
    /must repeat/,
  );
  assert.equal(queryCount, 0);
});

test("transaction failures preserve the operation error and evict a broken client", async () => {
  const operationError = new Error("sequence query failed");
  const rollbackError = new Error("connection lost during rollback");
  let releasedWith: Error | undefined;
  const client = {
    async query(text: string) {
      if (text === "BEGIN") return { rows: [] };
      if (text === "ROLLBACK") throw rollbackError;
      throw operationError;
    },
    release(error?: Error) {
      releasedWith = error;
    },
  };
  const pool = { async connect() { return client; } };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  await assert.rejects(
    store.consumeUserInstruction(
      "test-user-123",
      "00000000-0000-0000-0000-000000000001",
    ),
    (error) => error === operationError,
  );
  assert.equal(releasedWith, rollbackError);
});

test("force-all-losses takes priority without advancing an enabled personal flow", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        return { rows: [{ battle_id: "test-battle" }] };
      }
      if (text.includes("FROM battle_test_user_sequences")) {
        return { rows: [{
          environment: "dev",
          user_id: "test-user-123",
          username: "tester",
          rules: [{ target: "win", strategy: "highest_multiplier", count: 3 }],
          current_rule_index: 0,
          remaining_in_rule: 3,
          persistent: true,
          randomized: false,
          enabled: true,
          force_losses: true,
          updated_at: new Date("2026-08-21T00:00:00.000Z"),
          updated_by: "motha",
        }] };
      }
      if (text.includes("SELECT force_all_losses FROM battle_test_config")) {
        return { rows: [{ force_all_losses: true }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [] }; },
  };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  assert.deepEqual(await store.consumeUserInstruction(
    "test-user-123",
    "00000000-0000-0000-0000-000000000001",
  ), {
    target: "loss",
    strategy: "lowest_profit",
    minMultiplier: null,
    maxMultiplier: null,
    source: "global",
    mode: "force_losses",
  });
  assert.equal(statements.some((statement) =>
    statement.includes("UPDATE battle_test_user_sequences SET current_rule_index")
  ), false);
});

test("per-user force-losses overrides a paused flow without advancing it", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        return { rows: [{ battle_id: "test-battle" }] };
      }
      if (text.includes("FROM battle_test_user_sequences")) {
        return { rows: [{
          environment: "prod",
          user_id: "test-user-123",
          username: "tester",
          rules: [{ target: "win", strategy: "highest_multiplier", count: 3 }],
          current_rule_index: 0,
          remaining_in_rule: 3,
          persistent: false,
          randomized: false,
          enabled: false,
          force_losses: true,
          updated_at: new Date("2026-08-22T00:00:00.000Z"),
          updated_by: "motha",
        }] };
      }
      if (text.includes("SELECT force_all_losses FROM battle_test_config")) {
        return { rows: [{ force_all_losses: false }] };
      }
      if (text.includes("SELECT user_only_loses")) {
        throw new Error("global flow must not be read during a per-user override");
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [] }; },
  };
  const store = new PgBattleTestConfigStore(pool as never, "prod");

  assert.deepEqual(await store.consumeUserInstruction(
    "test-user-123",
    "00000000-0000-0000-0000-000000000001",
  ), {
    target: "loss",
    strategy: "lowest_profit",
    minMultiplier: null,
    maxMultiplier: null,
    source: "user",
    mode: "force_losses",
  });
  assert.equal(statements.some((statement) =>
    statement.includes("UPDATE battle_test_user_sequences SET current_rule_index")
  ), false);
});

test("per-user force-losses updates only the environment-scoped override", async () => {
  let call: { text: string; params: unknown[] } | null = null;
  const pool = {
    async query(text: string, params: unknown[]) {
      call = { text, params };
      return { rows: [] };
    },
  };
  const store = new PgBattleTestConfigStore(pool as never, "prod");

  assert.equal(await store.setUserForceLosses(
    "test-user-123",
    true,
    "motha",
  ), null);
  assert.match(call!.text, /WHERE environment = \$1 AND user_id = \$2/);
  assert.doesNotMatch(call!.text, /current_rule_index\s*=/);
  assert.deepEqual(call!.params, ["prod", "test-user-123", true, "motha"]);
});

test("force-all-losses takes priority over an enabled global flow", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        return { rows: [{ battle_id: "test-battle" }] };
      }
      if (text.includes("FROM battle_test_user_sequences")) {
        return { rows: [] };
      }
      if (text.includes("SELECT force_all_losses FROM battle_test_config")) {
        return { rows: [{ force_all_losses: true }] };
      }
      if (text.includes("SELECT user_only_loses")) {
        throw new Error("normal global flow must not be read while override is active");
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [] }; },
  };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  const instruction = await store.consumeUserInstruction(
    "test-user-123",
    "00000000-0000-0000-0000-000000000001",
  );
  assert.equal(instruction?.target, "loss");
  assert.equal(instruction?.source, "global");
  assert.equal(statements.filter((statement) =>
    statement.includes("battle_test_config")
  ).length, 1);
});

test("an override instruction remains stable on a durable retry", async () => {
  const durableInstruction = {
    target: "loss",
    strategy: "lowest_profit",
    minMultiplier: null,
    maxMultiplier: null,
    source: "global",
  };
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes("INSERT INTO battle_test_eos_selections")) {
        return { rows: [] };
      }
      if (text.includes("SELECT user_id, instruction")) {
        return { rows: [{
          user_id: "test-user-123",
          instruction: durableInstruction,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const store = new PgBattleTestConfigStore(pool as never, "dev");

  assert.deepEqual(await store.consumeUserInstruction(
    "test-user-123",
    "00000000-0000-0000-0000-000000000001",
  ), durableInstruction);
  assert.equal(statements.some((statement) =>
    statement.includes("SELECT force_all_losses")
  ), false);
});

test("EOS control overview is environment scoped and maps separated currencies", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const trackingStartedAt = new Date("2026-08-21T00:00:00.000Z");
  const pool = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return {
        rows: [{
          period: "24h",
          currency: "real",
          tracking_started_at: trackingStartedAt,
          battle_count: "12",
          steered_battles: "10",
          matched_battles: "8",
          fallback_battles: "2",
          target_unavailable_battles: "1",
          range_unavailable_battles: "1",
          force_loss_battles: "3",
          creator_wins_avoided: "4",
          selected_wins: "2",
          selected_losses: "8",
          selected_creator_profit_loss: "-42.50",
          random_baseline_creator_profit_loss: "15.25",
          estimated_creator_profit_reduction: "57.75",
        }],
      };
    },
  };
  const store = new PgBattleTestConfigStore(pool as never, "prod");

  const overview = await store.getOverview();

  assert.equal(overview.environment, "prod");
  assert.equal(overview.trackingStartedAt, trackingStartedAt.toISOString());
  assert.deepEqual(overview.periods[0], {
    period: "24h",
    currency: "real",
    battleCount: 12,
    steeredBattles: 10,
    matchedBattles: 8,
    fallbackBattles: 2,
    targetUnavailableBattles: 1,
    rangeUnavailableBattles: 1,
    forceLossBattles: 3,
    creatorWinsAvoided: 4,
    selectedWins: 2,
    selectedLosses: 8,
    selectedCreatorProfitLoss: -42.5,
    randomBaselineCreatorProfitLoss: 15.25,
    estimatedCreatorProfitReduction: 57.75,
  });
  assert.deepEqual(calls[0]!.params, ["prod"]);
  assert.match(calls[0]!.text, /s\.environment = \$1/);
  assert.match(calls[0]!.text, /s\.audit IS NOT NULL AND s\.response IS NOT NULL/);
  assert.match(calls[0]!.text, /s\.selected_at >= now\(\) - interval '30 days'/);
  assert.match(calls[0]!.text, /valid\.control_kind <> 'random'/);
  assert.match(calls[0]!.text, /valid\.baseline_profit - valid\.selected_profit/);
  assert.match(calls[0]!.text, /valid\.currency = currencies\.currency/);
});
