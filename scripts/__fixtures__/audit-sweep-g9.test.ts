import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Guardrails for the g9 audit sweep.
 *
 * These are source-shape assertions on purpose: every behaviour pinned here
 * only manifests against a live PostgreSQL/Redis/monitor endpoint, which this
 * suite must never touch. What they protect is the reason each edit was made,
 * so a future "cleanup" cannot silently undo it.
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function source(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("MAIN pools are pinned to globalThis in every environment", () => {
  const db = source("src/lib/db.ts");
  // A NODE_ENV-gated pin means production pool identity depends on the module
  // being evaluated exactly once per isolate. A second copy builds a second
  // `max: 2` mirror pool and doubles the isolate's share of the 30-session role.
  assert.ok(
    !/NODE_ENV[^\n]*\n\s*globalForMainDb\./.test(db),
    "db.ts must not gate its globalThis pool pin on NODE_ENV",
  );
  for (const key of [
    "mainReadDbPools",
    "mainReadDrizzleClients",
    "mainPrimaryDbPools",
    "mainPrimaryDrizzleClients",
  ]) {
    assert.ok(
      db.includes(`globalForMainDb.${key} = `),
      `db.ts must pin ${key} to globalThis`,
    );
  }
});

test("the admin migration runner keeps an applied-migration ledger", () => {
  const runner = source("scripts/apply-admin-sql.mjs");
  assert.match(
    runner,
    /CREATE TABLE IF NOT EXISTS admin_schema_migrations/,
    "the runner must create the ledger it reads",
  );
  assert.match(
    runner,
    /INSERT INTO admin_schema_migrations/,
    "an applied migration must be recorded, or 'what is unapplied?' is unanswerable",
  );
  // The ledger check has to sit inside the advisory-locked transaction, or two
  // concurrent applies can both read "not applied yet".
  const lockIndex = runner.indexOf("pg_advisory_xact_lock");
  const ledgerIndex = runner.indexOf("SELECT checksum FROM admin_schema_migrations");
  assert.ok(lockIndex > 0 && ledgerIndex > lockIndex);
});

test("the live outbox drain logs the row it gave up on", () => {
  const live = source("services/antifraud-monitor/src/live.ts");
  const drain = live.slice(
    live.indexOf("async drainOutbox("),
    live.indexOf("private async broadcastResync("),
  );
  assert.ok(drain.length > 0, "drainOutbox must still exist");
  assert.ok(
    !/\}\s*catch\s*\{/.test(drain),
    "a bare catch turns a poison outbox row into a silent permanent stall",
  );
  assert.match(drain, /outboxRowId: row\.id/);
});

test("monitor request failures bind the throwable", () => {
  const api = source("src/lib/antifraud/monitor-api.ts");
  assert.ok(
    !/\}\s*catch\s*\{\s*\n\s*console\.error/.test(api),
    "DNS failure, abort, non-2xx and Zod drift must not collapse to one log line",
  );
});

test("the decision failure messages stay inside the operator allowlist", () => {
  // `actionErrorMessage` only forwards phrases on OPERATOR_MESSAGES to the
  // toast; everything else becomes DEFAULT_ACTION_ERROR. Reword either message
  // past "did not respond" and the analyst silently loses the real reason.
  const allowlist = source("src/lib/antifraud/action-error-message.ts");
  assert.match(allowlist, /\/did not respond\/i/);

  const api = source("src/lib/antifraud/monitor-api.ts");
  const messages = api.match(/"The monitor service did not respond[^"]*"/g) ?? [];
  assert.ok(messages.length >= 2, "both decision-failure branches must exist");
  assert.ok(
    messages.some((message) => message.includes("may or may not have been recorded")),
    "an upstream timeout must not claim the decision was not recorded",
  );
});

test("the decision path never logs the raw upstream body", () => {
  const api = source("src/lib/antifraud/monitor-api.ts");
  assert.ok(
    !/console\.error\([^)]*response\.text\(\)/s.test(api),
    "the monitor's error body is unbounded and can echo the request",
  );
  assert.match(api, /await response\.text\(\)\.catch\(\(\) => ""\)\)\.slice\(0, 300\)/);
});
