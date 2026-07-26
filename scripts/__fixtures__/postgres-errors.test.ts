import assert from "node:assert/strict";
import test from "node:test";

import {
  isPostgresError,
  postgresErrorCode,
  postgresErrorMessages,
} from "../../src/lib/postgres-errors";

test("reads a direct PostgreSQL SQLSTATE", () => {
  assert.equal(postgresErrorCode({ code: "23505" }), "23505");
  assert.equal(isPostgresError({ code: "23505" }, "23505"), true);
});

test("reads a PostgreSQL SQLSTATE wrapped by Drizzle", () => {
  const cause = Object.assign(new Error("duplicate key"), { code: "23505" });
  const error = new Error("Failed query", { cause });

  assert.equal(postgresErrorCode(error), "23505");
  assert.equal(postgresErrorMessages(error), "Failed query\nduplicate key");
});

test("ignores non-SQLSTATE application error codes", () => {
  assert.equal(postgresErrorCode({ code: "P2002" }), undefined);
  assert.equal(postgresErrorCode({ code: "NOT_FOUND" }), undefined);
});

test("does not loop on a cyclic cause chain", () => {
  const error: Error & { cause?: unknown } = new Error("outer");
  error.cause = error;

  assert.equal(postgresErrorCode(error), undefined);
  assert.equal(postgresErrorMessages(error), "outer");
});
