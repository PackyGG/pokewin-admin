import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";
import { persistAbstractCatchallContainment } from "../src/monitor.js";
import type { Signal, Signup } from "../src/types.js";

const signup: Signup = {
  id: "user-1",
  username: "player",
  email: "Player@Example.com",
  image: null,
  signup_ip: "203.0.113.10",
  country: "DE",
  country_code: "DE",
  continent_code: "EU",
  state: "Berlin",
  city: "Berlin",
  affiliate_code: null,
  referred_by: null,
  is_suspected_alt: false,
  created_at: new Date("2026-07-30T12:00:00.000Z"),
  fingerprint_request_id: null,
  visitor_id: null,
  fingerprint_confidence: null,
  fingerprint_ip: null,
  user_agent: null,
};

const catchallSignal: Signal = {
  key: "abstract_email_catchall",
  title: "Catch-all email domain",
  detail: "Confirmed catch-all",
  points: 100,
  payload: { isCatchall: true },
};

type QueryCall = { text: string; values: unknown[] | undefined };

function fakePool(options?: { failInsert?: boolean; existing?: boolean }) {
  const calls: QueryCall[] = [];
  let released = false;
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes("SELECT EXISTS")) {
        return {
          rows: [{ exists: options?.existing === true }],
          rowCount: 1,
        };
      }
      if (
        options?.failInsert
        && text.includes("INSERT INTO risk_events")
      ) {
        throw new Error("database unavailable");
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    },
  };
  return {
    pool: {
      connect: async () => client,
    } as unknown as pg.Pool,
    calls,
    released: () => released,
  };
}

test("confirmed catch-all containment commits independently with signed evidence", async () => {
  const fake = fakePool();
  let opened = false;

  await persistAbstractCatchallContainment(
    fake.pool,
    {
      signup,
      catchallSignal,
      signals: [catchallSignal],
      score: 100,
      durationSeconds: 180,
    },
    async (_client, containedSignup, signals, score, durationSeconds) => {
      opened = true;
      assert.equal(containedSignup.id, signup.id);
      assert.deepEqual(signals, [catchallSignal]);
      assert.equal(score, 100);
      assert.equal(durationSeconds, 180);
      return { caseId: "case-1", sessionId: "session-1" };
    },
  );

  assert.equal(opened, true);
  assert.equal(fake.calls[0]?.text, "BEGIN");
  const insert = fake.calls.find((call) =>
    call.text.includes("INSERT INTO risk_events")
  );
  assert.ok(insert);
  assert.deepEqual(insert.values?.slice(0, 7), [
    "case-1",
    "session-1",
    "user-1",
    "user-1:abstract_email_catchall",
    100,
    catchallSignal.title,
    catchallSignal.detail,
  ]);
  assert.deepEqual(JSON.parse(String(insert.values?.[7])), {
    containmentRequired: true,
    emailDomain: "example.com",
    provider: "abstract_email",
    evidence: { isCatchall: true },
  });
  assert.equal(fake.calls.at(-1)?.text, "COMMIT");
  assert.equal(fake.released(), true);
});

test("catch-all containment rolls back and stays retryable when persistence fails", async () => {
  const fake = fakePool({ failInsert: true });

  await assert.rejects(
    persistAbstractCatchallContainment(
      fake.pool,
      {
        signup,
        catchallSignal,
        signals: [catchallSignal],
        score: 100,
        durationSeconds: 180,
      },
      async () => ({ caseId: "case-1", sessionId: "session-1" }),
    ),
    /database unavailable/,
  );

  assert.equal(fake.calls.at(-1)?.text, "ROLLBACK");
  assert.equal(fake.released(), true);
});

test("a replayed catch-all event does not open another monitor session", async () => {
  const fake = fakePool({ existing: true });
  let opened = false;

  await persistAbstractCatchallContainment(
    fake.pool,
    {
      signup,
      catchallSignal,
      signals: [catchallSignal],
      score: 100,
      durationSeconds: 180,
    },
    async () => {
      opened = true;
      return { caseId: "case-1", sessionId: "session-1" };
    },
  );

  assert.equal(opened, false);
  assert.equal(
    fake.calls.some((call) => call.text.includes("INSERT INTO risk_events")),
    false,
  );
  assert.equal(fake.calls.at(-1)?.text, "COMMIT");
  assert.equal(fake.released(), true);
});
