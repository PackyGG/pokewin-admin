import assert from "node:assert/strict";
import test from "node:test";

import { PgBattleTestConfigStore } from "../src/battle-test-config.js";

test("persistent user rules stay active without consuming their counter", async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
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
  const store = new PgBattleTestConfigStore(pool as never);

  const first = await store.consumeUserInstruction("test-user-123");
  const second = await store.consumeUserInstruction("test-user-123");

  assert.deepEqual(first, { target: "loss", strategy: "lowest_profit" });
  assert.deepEqual(second, first);
  assert.equal(
    statements.some((statement) =>
      statement.includes("UPDATE battle_test_user_sequences")
    ),
    false,
  );
});
