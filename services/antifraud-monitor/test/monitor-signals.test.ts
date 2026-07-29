import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import { persistRuleMatch, storedSignals } from "../src/monitor.js";

const signal = {
  key: "proxy",
  title: "Proxy detected",
  detail: "The signup IP is a proxy.",
  points: 25,
};

test("stored signals accept native json arrays", () => {
  assert.deepEqual(storedSignals([signal]), [signal]);
});

test("stored signals recover legacy double-encoded arrays", () => {
  assert.deepEqual(storedSignals(JSON.stringify([signal])), [signal]);
});

test("stored signals reject malformed values", () => {
  assert.deepEqual(storedSignals({ signal }), []);
  assert.deepEqual(storedSignals("not json"), []);
});

function rulePoolFixture(options?: {
  duplicate?: boolean;
  failCaseUpdate?: boolean;
  failAlertInsert?: boolean;
}): {
  pool: pg.Pool;
  statements: string[];
  released: () => boolean;
} {
  const statements: string[] = [];
  let wasReleased = false;
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (normalized.startsWith("INSERT INTO rule_matches")) {
        return options?.duplicate
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: "match-1" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE monitor_sessions")) {
        return { rows: [{ current_score: 45 }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE cases")) {
        if (options?.failCaseUpdate) throw new Error("case update failed");
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO rule_alert_outbox")) {
        if (options?.failAlertInsert) throw new Error("alert insert failed");
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    },
    release() {
      wasReleased = true;
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    } as unknown as pg.Pool,
    statements,
    released: () => wasReleased,
  };
}

const ruleWrite = {
  ruleId: "rule-1",
  caseId: "case-1",
  sessionId: "session-1",
  scoreDelta: 20,
  actionType: "manual_review",
  evidence: { sequence: ["deposit"] },
  alert: {
    title: "Rule matched",
    description: "Review required",
    userId: "user-1",
  },
};

test("rule match, score, and case outcome commit atomically", async () => {
  const fixture = rulePoolFixture();
  const score = await persistRuleMatch(fixture.pool, ruleWrite);

  assert.equal(score, 45);
  assert.deepEqual(
    fixture.statements.map((statement) => statement.split(" ", 2).join(" ")),
    [
      "BEGIN",
      "INSERT INTO",
      "UPDATE monitor_sessions",
      "UPDATE cases",
      "INSERT INTO",
      "COMMIT",
    ],
  );
  assert.equal(fixture.released(), true);
});

test("a failed rule outcome rolls the match back for a safe retry", async () => {
  const fixture = rulePoolFixture({ failCaseUpdate: true });

  await assert.rejects(
    persistRuleMatch(fixture.pool, ruleWrite),
    /case update failed/,
  );
  assert.equal(fixture.statements.at(-1), "ROLLBACK");
  assert.equal(fixture.statements.includes("COMMIT"), false);
  assert.equal(fixture.released(), true);
});

test("a failed rule alert reservation rolls the match back for a safe retry", async () => {
  const fixture = rulePoolFixture({ failAlertInsert: true });

  await assert.rejects(
    persistRuleMatch(fixture.pool, ruleWrite),
    /alert insert failed/,
  );
  assert.equal(fixture.statements.at(-1), "ROLLBACK");
  assert.equal(fixture.statements.includes("COMMIT"), false);
});

test("an existing rule match is an idempotent no-op", async () => {
  const fixture = rulePoolFixture({ duplicate: true });
  const score = await persistRuleMatch(fixture.pool, ruleWrite);

  assert.equal(score, null);
  assert.equal(
    fixture.statements.some((statement) =>
      statement.startsWith("UPDATE monitor_sessions")),
    false,
  );
  assert.equal(fixture.statements.at(-1), "COMMIT");
});
