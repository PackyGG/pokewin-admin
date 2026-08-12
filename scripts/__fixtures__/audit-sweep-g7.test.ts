import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const MIGRATE = "services/antifraud-monitor/src/migrate.ts";
const BANNED_USERS = "src/app/(antifraud)/antifraud/banned-users/actions.ts";
const USER_ACTIONS = "src/app/(admin)/users/[id]/actions.ts";

test("a migration client whose session cleanup failed is destroyed, not pooled", () => {
  const migrate = source(MIGRATE);

  // `SET statement_timeout = 0` and `pg_advisory_lock()` are both session
  // scoped. If the unlock or the RESET fails on a still-live connection, that
  // client must never go back into the shared runtime pool: it would carry an
  // unbounded statement_timeout and/or the migration lock into unrelated work.
  assert.match(migrate, /client\.release\(cleanupError\)/);
  assert.doesNotMatch(migrate, /client\.release\(\)/);

  const unlock = migrate.indexOf("pg_advisory_unlock");
  const reset = migrate.indexOf("RESET statement_timeout");
  const release = migrate.indexOf("client.release(cleanupError)");
  assert.ok(unlock > 0 && reset > unlock && release > reset);

  // Both cleanup statements must record the failure; swallowing either one
  // silently is what let a poisoned client back into the pool.
  const cleanup = migrate.slice(unlock, release);
  assert.equal(cleanup.match(/cleanupError\s*(?:\?\?)?=/g)?.length, 2);
});

test("a no-op ban tells the operator its identifier blocks are still queued", () => {
  const banned = source(BANNED_USERS);

  // The obligation is committed before the guarded UPDATE and is deliberately
  // never rolled back with it, so `updated === 0` is not "nothing happened".
  const noop = banned.indexOf("if (updated === 0) {");
  assert.ok(noop > 0);
  const block = banned.slice(noop, noop + 900);
  assert.match(block, /queued for blocking and will still be applied/);
  // Only claim it when there was something to queue.
  assert.match(block, /queuedIdentifiers > 0/);

  // The failed security-audit row has to carry the same fact.
  const failure = banned.indexOf('outcome: "failed"');
  assert.ok(failure > 0);
  const failureBlock = banned.slice(failure, failure + 900);
  assert.match(failureBlock, /identifier_blocklist_queued/);
  assert.match(failureBlock, /queued_identifier_count/);
  // appendAntifraudSecurityAudit hashes any metadata key matching its PII
  // pattern, so an "ip"/"fingerprint" key would store an unreadable digest.
  assert.doesNotMatch(failureBlock, /blacklisted_ip_count/);
  assert.doesNotMatch(failureBlock, /blacklisted_fingerprint_count/);
});

test("the balance_fill webhook lookup is awaited before adjustBalance returns", () => {
  const actions = source(USER_ACTIONS);

  const marker = actions.indexOf("SELECT url, secret FROM creator_webhooks");
  assert.ok(marker > 0);
  const start = actions.lastIndexOf("if (!isUltraLossback) {", marker);
  const block = actions.slice(start, marker + 2_500);

  // Un-awaited, this kept a connection checked out of the max:1 admin pool
  // after the action returned — on a serverless isolate frozen at response
  // time the checkout outlives the query.
  assert.match(block, /await adminDrizzle\.execute</);
  assert.doesNotMatch(block, /\.then\(\(\{ rows: webhooks \}\)/);

  // The HTTP dispatch itself stays fire-and-forget, as before.
  assert.match(block, /fetch\(webhook\.url, \{/);
  assert.doesNotMatch(block, /await fetch\(/);
});
