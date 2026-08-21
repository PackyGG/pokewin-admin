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

  assert.deepEqual(first, { target: "loss", strategy: "lowest_profit" });
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
