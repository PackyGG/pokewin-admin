import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientPostgresReadError,
  withTransientPostgresReadRetry,
} from "@/lib/postgres-read-retry";

test("recognizes nested PostgreSQL connection and idle-session timeouts", () => {
  const error = new Error("Failed query", {
    cause: new Error("Connection terminated due to connection timeout"),
  });
  assert.equal(isTransientPostgresReadError(error), true);
  assert.equal(
    isTransientPostgresReadError(
      new Error("Failed query", {
        cause: Object.assign(
          new Error("terminating connection due to idle-session timeout"),
          { code: "57P05" },
        ),
      }),
    ),
    true,
  );
});

test("retries one transient read and returns the successful result", async () => {
  let attempts = 0;
  const result = await withTransientPostgresReadRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Failed query", {
          cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
        });
      }
      return 33;
    },
    { context: "test.read", delayMs: 0 },
  );

  assert.equal(result, 33);
  assert.equal(attempts, 2);
});

test("does not retry SQL or permission failures", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientPostgresReadRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("column does not exist"), {
          code: "42703",
        });
      },
      { context: "test.read", delayMs: 0 },
    ),
    /column does not exist/,
  );
  assert.equal(attempts, 1);
});

test("stops after the bounded transient retry", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientPostgresReadRetry(
      async () => {
        attempts += 1;
        throw new Error("Connection terminated unexpectedly");
      },
      { context: "test.read", delayMs: 0 },
    ),
    /Connection terminated unexpectedly/,
  );
  assert.equal(attempts, 2);
});
