import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Ingest and containment regressions from the antifraud/runtime audit. Each
 * assertion pins a failure that production could not show: a merge silently
 * skipped on the losing side of a race, a bound payload printed into the log
 * sink, an obligation retired without confirmation, a re-lock that wrote
 * nothing and reported a no-op.
 */

const repoRoot = process.cwd();
// Checked out with CRLF on Windows; normalise so the shape assertions below
// can anchor on `\n` the way the source reads.
const read = (relative: string): string =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

const ingest = read("src/app/api/antifraud/ingest/route.ts");
const drizzleQuery = read("src/lib/drizzle-query.ts");
const identifierBlocking = read("src/lib/antifraud/user-identifier-blocking.ts");
const withdrawalRelease = read("src/lib/antifraud/withdrawal-release.ts");

test("every path onto a live case runs the same merge", () => {
  // Both conflict branches used to only stamp `review_id`, so a signal that
  // lost the create race lost its kind, its severity escalation, its risk
  // score and its case-trail note — invisibly, on the exact concurrency the
  // FOR UPDATE lock exists to survive.
  assert.equal([...ingest.matchAll(/await mergeOntoLiveCase\(/g)].length, 3);
  assert.equal([...ingest.matchAll(/await selectLiveCase\(/g)].length, 3);
  // The winner re-read must take the same row lock as the first lookup;
  // `selectLiveCase` is the only reader, and it ends in `.for("update")`.
  assert.match(ingest, /\.limit\(1\)\n(?:[^\n]*\n)*?\s+\.for\("update"\);/);
  assert.doesNotMatch(ingest, /\.select\(\{ id: antifraud_reviews\.id \}\)/);
});

test("a failed ingest never prints the throwable itself", () => {
  // A DrizzleQueryError's message carries the failed SQL and its bound
  // parameters — for this INSERT that is the account id, username, summary and
  // the whole enrichment payload. `logError` drops it.
  assert.match(ingest, /logError\("antifraud\.ingest", "failed to store signal", err\)/);
  assert.doesNotMatch(ingest, /console\.error\([^)]*,\s*err\)/);
});

test("post-commit audit appends cannot fail an already durable batch", () => {
  // The pre-flight `allowed` append still fails closed (503). After the ADMIN
  // transaction commits, a throwing audit sink would only turn a real success
  // into a 500 and make the backend redeliver finished work.
  assert.match(ingest, /async function appendOutcomeAudit\(/);
  assert.equal([...ingest.matchAll(/await appendOutcomeAudit\(\{/g)].length, 2);
  const helper = ingest.slice(ingest.indexOf("async function appendOutcomeAudit("));
  assert.match(helper, /try \{[\s\S]*catch \(err\) \{[\s\S]*logError\(/);
});

test("the MAIN read retry no longer reconnects in the same tick", () => {
  // `delayMs: 0` inside a 13-wide Promise.all turned one mirror blip into 26
  // back-to-back connection attempts against a tiny pool.
  // Anchored on the trailing comma so the prose above the helper, which quotes
  // the old value, does not satisfy the guard on its own.
  assert.doesNotMatch(drizzleQuery, /delayMs: 0\s*[,}]/);
  assert.match(drizzleQuery, /function mainReadRetryDelayMs\(\): number \{\n\s+return 100 \+ Math\.floor\(Math\.random\(\) \* 200\);/);
  assert.equal(
    [...drizzleQuery.matchAll(/delayMs: mainReadRetryDelayMs\(\)/g)].length,
    2,
  );
});

test("an identifier block is only acked once the monitor confirms it", () => {
  // `applyIdentifierBlockOperation` stamps the outbox row `applied` on return,
  // so returning true on an unverified response retired the obligation for
  // good. `value` is deliberately not compared — the monitor normalizes it,
  // and a cosmetic difference would retry forever.
  assert.match(
    identifierBlocking,
    /function assertBlockingRuleConfirmed\(saved: IdentifierBlocklistRule\): void \{\n\s+if \(!saved\.enabled \|\| saved\.effect !== "block" \|\| saved\.expiresAt !== null\)/,
  );
  assert.equal(
    [...identifierBlocking.matchAll(/assertBlockingRuleConfirmed\(saved\);/g)]
      .length,
    2,
  );
  assert.doesNotMatch(identifierBlocking, /saved\.value === value/);
});

test("a re-lock that matched no account is reported as failed", () => {
  // The INSERT selects FROM "user", so zero rows means the account is gone —
  // reporting that as `nothing_to_restore` told the analyst a reopened case
  // was contained when nothing had been written.
  const restore = withdrawalRelease.slice(
    withdrawalRelease.indexOf("export async function restoreWithdrawalLocksForReopenedCase("),
  );
  assert.match(
    restore,
    /if \(locked\.rows\.length === 0\) \{[\s\S]*logError\([\s\S]*return \{ status: "failed" \};/,
  );
  // The genuine no-op — this case's clear released nothing — must stay a no-op.
  assert.match(
    withdrawalRelease,
    /if \(released\.rows\.length === 0\) return \{ status: "nothing_to_restore" \};/,
  );
});
