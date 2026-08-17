import assert from "node:assert/strict";
import test from "node:test";

import { safeQuery, safeQueryOrNull } from "../../src/lib/errors/safe-query";

test("safeQuery still returns its fallback when the log sink throws", async () => {
  const originalConsoleError = console.error;
  console.error = () => {
    throw new Error("log sink unavailable");
  };
  try {
    const result = await safeQuery(
      async () => {
        throw new Error("query failed");
      },
      { total: 0 },
      "fixture.safe-query",
    );
    assert.deepEqual(result, {
      data: { total: 0 },
      error: "query failed",
      kind: "error",
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("safeQueryOrNull contains error serialization failures", async () => {
  const error = new Error("query failed");
  Object.defineProperty(error, "digest", {
    get() {
      throw new Error("digest unavailable");
    },
  });
  const result = await safeQueryOrNull(async () => {
    throw error;
  }, "fixture.safe-query-or-null");
  assert.deepEqual(result, {
    data: null,
    error: "query failed",
    kind: "error",
  });
});

test("safeQuery contains errors whose message getter throws", async () => {
  const error = new Error("query failed");
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("message unavailable");
    },
  });
  const result = await safeQuery(
    async () => {
      throw error;
    },
    "fallback",
    "fixture.hostile-error",
  );
  assert.deepEqual(result, {
    data: "fallback",
    error: "Unknown query error",
    kind: "error",
  });
});

test("safeQuery never returns Drizzle SQL or bound parameters", async () => {
  const error = Object.assign(
    new Error(
      "Failed query: SELECT email FROM users WHERE id = $1\nparams: private-user-id",
    ),
    {
      cause: Object.assign(new Error("too many connections"), {
        code: "53300",
      }),
    },
  );

  const result = await safeQuery(
    async () => {
      throw error;
    },
    null,
    "fixture.safe-query-redaction",
  );

  assert.deepEqual(result, {
    data: null,
    error: "Database error (SQLSTATE 53300: too many connections)",
    kind: "error",
  });
});
