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

test("does not classify PostgreSQL capacity exhaustion as retryable", () => {
  assert.equal(
    isTransientPostgresReadError(
      Object.assign(new Error('too many connections for role "fraud_app"'), {
        code: "53300",
      }),
    ),
    false,
  );
  assert.equal(
    isTransientPostgresReadError(new Error("sorry, too many clients already")),
    false,
  );
});

test("retries PostgreSQL idle-session reclamation once", async () => {
  let attempts = 0;
  const idleTimeout = Object.assign(
    new Error("terminating connection due to idle-session timeout"),
    { code: "57P05" },
  );

  const result = await withTransientPostgresReadRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw idleTimeout;
      return "recovered";
    },
    { context: "test.idle-session", delayMs: 0 },
  );

  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
});

test("retries one transient read and returns the successful result", async () => {
  let attempts = 0;
  const result = await withTransientPostgresReadRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Failed query", {
          cause: Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
          }),
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

test("does not retry a capacity failure", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientPostgresReadRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("too many connections"), {
          code: "53300",
        });
      },
      { context: "test.capacity", delayMs: 0 },
    ),
    /too many connections/,
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

test("an aborted deadline cancels retry backoff before another checkout", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = withTransientPostgresReadRetry(
    async () => {
      attempts += 1;
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    },
    {
      context: "test.abort",
      delayMs: 10_000,
      signal: controller.signal,
    },
  );
  controller.abort(new Error("query deadline reached"));

  await assert.rejects(pending, /query deadline reached/);
  assert.equal(attempts, 1);
});
