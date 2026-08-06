import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const ROUTE = "src/app/api/antifraud/ingest/route.ts";
const OUTBOX = "src/lib/antifraud/containment-outbox.ts";
const ELIGIBILITY = "src/lib/antifraud/fiat-eligibility-containment.ts";
const IDENTITY = "src/lib/antifraud/fiat-identity-containment.ts";
const CRON = "src/app/api/cron/antifraud-containment-retry/route.ts";

test("the two external containment kinds are never applied inside the ADMIN ingest transaction", () => {
  const route = source(ROUTE);

  // The old in-transaction MAIN-write helpers for the two external kinds must
  // be gone; only the pure, DB-free admission check and the pending-marker
  // run inside the tx now. (Other signal kinds still lock MAIN in-tx
  // unchanged — this is a pure reordering fix for the two external kinds
  // only, not a behavior change for the rest.)
  assert.doesNotMatch(route, /async function containFiatEligibilityAccount/);
  assert.doesNotMatch(route, /async function containFiatIdentityAccount/);

  // Ordering proof: `adminDrizzle.transaction(` opens, its closing `});`
  // (committing the ADMIN transaction) appears BEFORE the call that performs
  // the deferred external containment. A regression that moved the
  // MAIN write / KYC call back inside the transaction would put
  // `runDeferredContainment(` before the transaction's closing brace instead
  // of after it.
  const txOpen = route.indexOf("adminDrizzle.transaction(async (tx): Promise<IngestResult> => {");
  const txClose = route.indexOf("\n  });", txOpen);
  const deferredCall = route.indexOf("await runDeferredContainment({", txClose);
  assert.ok(txOpen >= 0, "transaction open not found");
  assert.ok(txClose > txOpen, "transaction close not found after open");
  assert.ok(
    deferredCall > txClose,
    "runDeferredContainment must be called after the ADMIN transaction closes, not before",
  );

  // The two kinds only validate + mark `pending` inside the transaction —
  // no MAIN I/O, no KYC call, in that scope.
  assert.match(route, /requiresContainmentOutbox\(\{/);
  assert.match(route, /await markContainmentPending\(tx, stored\.id\)/);
  assert.ok(
    route.indexOf("await markContainmentPending(tx, stored.id)") < txClose,
    "markContainmentPending must run inside the ADMIN transaction",
  );
  assert.ok(
    route.indexOf("requiresContainmentOutbox({") < txClose,
    "requiresContainmentOutbox must run inside the ADMIN transaction (it is pure, no MAIN I/O)",
  );
});

test("deferred containment never throws out of ingestOne and is recorded durably on failure", () => {
  const outbox = source(OUTBOX);

  assert.match(outbox, /export async function runDeferredContainment/);
  // The whole body is wrapped in try/catch — a thrown error from the MAIN
  // write or the KYC call must not propagate out of this function.
  const fnStart = outbox.indexOf("export async function runDeferredContainment");
  const tryStart = outbox.indexOf("try {", fnStart);
  const catchStart = outbox.indexOf("} catch (error) {", tryStart);
  assert.ok(fnStart >= 0 && tryStart > fnStart && catchStart > tryStart);
  assert.match(
    outbox.slice(catchStart),
    /await recordContainmentOutcome\(signal\.signalRowId, "failed", message\)/,
  );
  assert.match(outbox, /return "failed";/);

  // The failure floor: even if persisting the failure itself fails, it is
  // logged loudly, not swallowed — and the row is left recoverable because it
  // was already marked `pending` before commit.
  assert.match(
    outbox,
    /FAILED to persist containment failure state/,
  );
});

test("crash between commit and the external call is recovered by the cron sweep, not lost", () => {
  const outbox = source(OUTBOX);
  const cron = source(CRON);

  // The pre-commit intent write is the recovery anchor: a process that dies
  // right after commit leaves the row `pending`, which the cron also claims.
  assert.match(outbox, /export async function markContainmentPending/);
  assert.match(
    outbox,
    /SET containment_outbox_status = 'pending'/,
  );
  assert.match(
    outbox,
    /WHERE containment_outbox_status IN \('pending', 'failed'\)/,
  );
  assert.match(outbox, /containment_outbox_attempts < \$\{CONTAINMENT_OUTBOX_MAX_ATTEMPTS\}/);
  assert.match(outbox, /FOR UPDATE SKIP LOCKED/);

  // The cron route claims + retries using only columns already durable on
  // the row, requires no extra reconstructed state, and is auth-gated the
  // same way the existing warm cron is (fail closed in prod).
  assert.match(cron, /claimPendingContainmentRows/);
  assert.match(cron, /runDeferredContainment/);
  assert.match(cron, /CRON_SECRET/);
  assert.match(cron, /process\.env\.NODE_ENV === "production"/);
});

test("fiat eligibility and identity containment targets are pure (no MAIN I/O) so they can validate inside the ADMIN tx", () => {
  const eligibility = source(ELIGIBILITY);
  const identity = source(IDENTITY);

  assert.match(eligibility, /export function fiatEligibilityContainmentTarget/);
  assert.match(eligibility, /export async function applyFiatEligibilityContainment/);
  const targetFn = eligibility.slice(
    eligibility.indexOf("export function fiatEligibilityContainmentTarget"),
    eligibility.indexOf("export async function applyFiatEligibilityContainment"),
  );
  assert.doesNotMatch(targetFn, /getProdPrimaryDrizzleDb/);
  assert.doesNotMatch(targetFn, /db\.execute/);

  // Identity's split already existed before this change; confirm it is what
  // the outbox reuses (not a fresh duplicate implementation).
  assert.match(identity, /export function fiatIdentityContainmentTarget/);
  assert.match(identity, /export async function applyFiatIdentityContainment/);
});

test("vercel.json registers the containment retry cron alongside the existing warm cron", () => {
  const vercelConfig = JSON.parse(source("vercel.json")) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const paths = vercelConfig.crons.map((c) => c.path);
  assert.ok(paths.includes("/api/cron/warm"));
  assert.ok(paths.includes("/api/cron/antifraud-containment-retry"));
});

test("containment migration adds the outbox columns antifraud_signals needs", () => {
  const migration = source(
    "drizzle/admin/migrations/20260806_antifraud_signals_containment_outbox.sql",
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS containment_outbox_status text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS containment_outbox_error text/);
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS containment_outbox_attempts integer NOT NULL DEFAULT 0/,
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS containment_applied_at timestamptz/);
});
