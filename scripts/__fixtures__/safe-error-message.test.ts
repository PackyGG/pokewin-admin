import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { safeErrorMessage } from "../../src/lib/errors/safe-error-message";

/**
 * Reproduces the real shape: drizzle-orm's DrizzleQueryError message is
 * `Failed query: <SQL>\nparams: <bound values>`, wrapping the node-postgres
 * error that carries the SQLSTATE. The SQL selects a column named `reason` on
 * purpose — that word is on the antifraud operator allowlist, which is how the
 * statement and the bound email used to reach staff.
 */
function drizzleQueryError(): Error {
  const query =
    'select "id", "reason" from "antifraud_signals" where "email" = $1';
  const cause = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "users_email_key"',
    ),
    { code: "23505" },
  );
  return Object.assign(
    new Error(`Failed query: ${query}\nparams: analyst@packy.gg`),
    { query, params: ["analyst@packy.gg"], cause },
  );
}

test("driver errors persisted to admin columns keep the SQLSTATE, not the SQL", () => {
  const safe = safeErrorMessage(drizzleQueryError());

  assert.doesNotMatch(safe, /analyst@packy\.gg/);
  assert.doesNotMatch(safe, /select|antifraud_signals|params:|Failed query/i);
  assert.doesNotMatch(safe, /users_email_key/);
  assert.match(safe, /23505/);
  assert.match(safe, /unique violation/);
});

test("the antifraud allowlist can never see a driver-shaped message", () => {
  const source = readFileSync(
    path.resolve("src/lib/antifraud/action-error-message.ts"),
    "utf8",
  );

  // Both the staff-facing formatter and the Discord "was this expected?"
  // classifier must run layer 0 first, or they disagree on the same error.
  assert.match(source, /function classifiableMessage/);
  assert.match(source, /return safeErrorMessage\(error, ""\)/);
  const usages = source.match(/classifiableMessage\(error\)/g) ?? [];
  assert.equal(usages.length, 2);
  assert.doesNotMatch(source, /INFRASTRUCTURE_NOISE\.test\(error\.message\)/);

  // The collapsed output carries the literal token INFRASTRUCTURE_NOISE
  // matches, so every database failure lands on the fallback.
  const collapsed = safeErrorMessage(drizzleQueryError());
  const infrastructureNoise = /SQLSTATE/;
  assert.match(collapsed, infrastructureNoise);
  assert.match(safeErrorMessage(new Error("Failed query: select 1")), /SQLSTATE/);
});

test("authored operator messages still pass through unchanged", () => {
  assert.equal(safeErrorMessage(new Error("Invalid 2FA code")), "Invalid 2FA code");
  assert.equal(
    safeErrorMessage(new Error("You do not have permission to do that.")),
    "You do not have permission to do that.",
  );
  assert.equal(
    safeErrorMessage(new Error("Rain payout is not configured")),
    "Rain payout is not configured",
  );
  assert.equal(
    safeErrorMessage(new Error("Monitor API returned 503")),
    "Monitor API returned 503",
  );
});

test("timeout, permission and constraint failures stay distinguishable", () => {
  const withCode = (code: string) =>
    safeErrorMessage(Object.assign(new Error("boom"), { code }));

  assert.match(withCode("57014"), /57014.*statement timeout/);
  assert.match(withCode("42501"), /42501.*insufficient privilege/);
  assert.match(withCode("23503"), /23503.*foreign key violation/);
  assert.match(withCode("53300"), /53300.*too many connections/);
  // An unlisted code still names its SQLSTATE class.
  assert.match(withCode("08006"), /08006.*connection failure/);
});

test("identifier shapes are redacted from non-database errors", () => {
  const safe = safeErrorMessage(
    new Error(
      "monitor rejected fp 9f2c1ab4d7e05613bb90aa7712ff3c48 for user@example.com from 203.0.113.9 via postgres://admin:hunter2@db.internal:5432/main",
    ),
  );

  assert.doesNotMatch(safe, /user@example\.com/);
  assert.doesNotMatch(safe, /203\.0\.113\.9/);
  assert.doesNotMatch(safe, /hunter2|db\.internal/);
  assert.doesNotMatch(safe, /9f2c1ab4d7e05613bb90aa7712ff3c48/);
  assert.match(safe, /monitor rejected fp/);
});

test("the helper is total", () => {
  assert.equal(safeErrorMessage(null), "Unknown error");
  assert.equal(safeErrorMessage(undefined), "Unknown error");
  assert.equal(safeErrorMessage({}), "Unknown error");
  assert.equal(safeErrorMessage(42, "fallback"), "fallback");
  assert.equal(safeErrorMessage("plain string failure"), "plain string failure");

  const cyclic: { message: string; cause?: unknown } = { message: "cyclic" };
  cyclic.cause = cyclic;
  assert.equal(safeErrorMessage(cyclic), "cyclic");

  const hostile = {
    get message(): string {
      throw new Error("hostile getter");
    },
  };
  assert.doesNotThrow(() => safeErrorMessage(hostile));
});
