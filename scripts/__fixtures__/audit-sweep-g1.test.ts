import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Delivery-path regressions found in the antifraud ingest audit. Each assertion
 * below pins a failure that was invisible in production: an expiry with no
 * receipt, an event withheld by a decorative join, a transaction released back
 * to the pool still open.
 */

const repoRoot = process.cwd();
const DELIVERY = path.join(
  repoRoot,
  "services/antifraud-monitor/src/ingest-delivery.ts",
);
const source = fs.readFileSync(DELIVERY, "utf8");

test("the one-hour cutoff returns what it wrote off", () => {
  // Silent before: the UPDATE result was discarded, so an outage longer than
  // the window expired an unknown number of signals — containment commands
  // among them — while the tick still recorded a clean success.
  assert.match(source, /WITH aged_out AS \(/);
  assert.match(source, /RETURNING event_type/);
  assert.match(source, /this\.reportExpiredEvents\(expired\.rows\)/);
  assert.match(source, /expiredContainment/);
  assert.match(source, /this\.log\.error\(/);
  // The policy itself must not drift: one hour, both halves of the window.
  assert.match(source, /const DELIVERY_MAX_AGE_SQL = "1 hour"/);
  assert.match(source, /occurred_at < now\(\) - \$1::interval/);
});

test("the subject join only decorates and never withholds an event", () => {
  // `username` is nullable end to end; an inner join turned a missing subject
  // row into an event no delivery read ever returns, which the cutoff then
  // acked without it ever reaching Account Review.
  assert.equal(
    [...source.matchAll(/LEFT JOIN subjects s ON s\.user_id = re\.user_id/g)]
      .length,
    3,
  );
  assert.doesNotMatch(source, /\n\s+JOIN subjects s ON s\.user_id = re\.user_id/);
});

test("no delivery path returns with the leader transaction still open", () => {
  const body = source
    .slice(
      source.indexOf("async flushOnce("),
      source.indexOf("private reportExpiredEvents("),
    )
    // Comments mention COMMIT/ROLLBACK, so strip them before scanning or the
    // guard passes on prose instead of on the statement that actually runs.
    .replace(/\/\/[^\n]*/g, "")
    .replace(/--[^\n]*/g, "");
  assert.ok(body.length > 0, "flushOnce body must be locatable");
  // `finally` releases the client unconditionally, so a return that skips both
  // COMMIT and ROLLBACK hands the pool a connection inside BEGIN that is still
  // holding the advisory leader lease.
  for (const match of body.matchAll(/return [^;\n]*;/g)) {
    const before = body.slice(0, match.index);
    assert.match(
      before.slice(-260),
      /(COMMIT|ROLLBACK)/,
      "every flushOnce return must first close the transaction",
    );
  }
});

test("a permanently unparseable batch is dead-lettered rather than replayed", () => {
  // The dashboard reports these as `skipped`. Excluding them from the
  // confirmation sum blocked the head of the ordered stream until the cutoff.
  assert.match(source, /const skipped = Number\(result\.skipped \?\? 0\)/);
  assert.match(source, /stale \+\s+skipped;/);
  assert.match(source, /skipped\?: unknown/);
  assert.match(source, /dashboard discarded events from an accepted delivery batch/);
});
