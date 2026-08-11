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
const EMAIL_DOMAIN = "src/lib/antifraud/email-domain-containment.ts";
const CATCHALL = "src/lib/antifraud/abstract-catchall-containment.ts";
const BLOCKLIST = "src/lib/antifraud/identifier-blocklist-containment.ts";
const FREE_BATTLE = "src/lib/antifraud/risky-free-battle-containment.ts";
const BEHAVIORAL = "src/lib/antifraud/behavioral-withdrawal-containment.ts";
const CRITICAL = "src/lib/antifraud/critical-signup-containment.ts";
const CRON = "src/app/api/cron/antifraud-containment-retry/route.ts";

const ALL_KINDS = [
  "fiat_eligibility_containment",
  "fiat_deposit_identity_containment",
  "fiat_blacklisted_email_domain",
  "abstract_email_catchall",
  "signup_policy_recommendation",
  "risky_free_battle_containment",
  "behavioral_withdrawal_containment",
  "critical_risk_signup",
] as const;

test("all eight containment kinds are never applied inside the ADMIN ingest transaction", () => {
  const route = source(ROUTE);
  const outbox = source(OUTBOX);

  // Old in-transaction MAIN-write helpers must be gone from the route; only
  // the pure admission check and the pending-marker run inside the tx.
  assert.doesNotMatch(route, /async function containFiatEligibilityAccount/);
  assert.doesNotMatch(route, /async function containFiatIdentityAccount/);
  assert.doesNotMatch(route, /async function containBlacklistedEmailDomainAccount/);
  assert.doesNotMatch(route, /async function containAbstractCatchallAccount/);
  assert.doesNotMatch(route, /async function containIdentifierBlocklistAccount/);
  assert.doesNotMatch(route, /async function containRiskyFreeBattleAccount/);
  assert.doesNotMatch(route, /async function containBehavioralRiskAccount/);
  assert.doesNotMatch(route, /async function containCriticalSignupAccount/);
  assert.doesNotMatch(route, /getProdPrimaryDrizzleDb/);
  assert.doesNotMatch(route, /updateUserRewardLocks/);
  assert.doesNotMatch(route, /getUserFeatureLocks/);

  for (const kind of ALL_KINDS) {
    assert.ok(
      outbox.includes(`"${kind}"`),
      `CONTAINMENT_OUTBOX_KINDS must include ${kind}`,
    );
  }

  // Ordering proof: `adminDrizzle.transaction(` opens, its closing `});`
  // (committing the ADMIN transaction) appears BEFORE the call that performs
  // the deferred external containment.
  const txOpen = route.indexOf("adminDrizzle.transaction(async (tx): Promise<IngestResult> => {");
  const txClose = route.indexOf("\n  });", txOpen);
  const deferredCall = route.indexOf("await runDeferredContainment({", txClose);
  assert.ok(txOpen >= 0, "transaction open not found");
  assert.ok(txClose > txOpen, "transaction close not found after open");
  assert.ok(
    deferredCall > txClose,
    "runDeferredContainment must be called after the ADMIN transaction closes, not before",
  );

  // Between tx open and close: only validate + mark pending — no MAIN I/O,
  // no backend tip-lock / KYC apply helpers.
  const txBody = route.slice(txOpen, txClose);
  assert.doesNotMatch(txBody, /getProdPrimaryDrizzleDb/);
  assert.doesNotMatch(txBody, /db\.execute/);
  assert.doesNotMatch(txBody, /updateUserRewardLocks/);
  assert.doesNotMatch(txBody, /getUserFeatureLocks/);
  assert.doesNotMatch(txBody, /apply\w+Containment\(/);
  assert.doesNotMatch(txBody, /requireUserKyc/);

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
  const fnStart = outbox.indexOf("export async function runDeferredContainment");
  const tryStart = outbox.indexOf("try {", fnStart);
  const catchStart = outbox.indexOf("} catch (error) {", tryStart);
  assert.ok(fnStart >= 0 && tryStart > fnStart && catchStart > tryStart);
  assert.match(
    outbox.slice(catchStart),
    /await recordContainmentOutcome\(signal\.signalRowId, "failed", message\)/,
  );
  assert.match(outbox, /return "failed";/);

  assert.match(
    outbox,
    /FAILED to persist containment failure state/,
  );
});

test("crash between commit and the external call is recovered by the cron sweep, not lost", () => {
  const outbox = source(OUTBOX);
  const cron = source(CRON);

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
  for (const kind of ALL_KINDS) {
    assert.ok(
      outbox.includes(`'${kind}'`),
      `claimPendingContainmentRows kind IN must include ${kind}`,
    );
  }

  assert.match(cron, /claimPendingContainmentRows/);
  assert.match(cron, /runDeferredContainment/);
  assert.match(cron, /attemptAlreadyCounted: true/);
  assert.match(
    outbox,
    /if \(options\.attemptAlreadyCounted !== true\)/,
    "a cron-claimed retry must consume exactly one attempt",
  );
  assert.match(cron, /reconcileConfirmedCatchallPromotions/);
  assert.match(cron, /CRON_SECRET/);
  assert.match(cron, /process\.env\.NODE_ENV === "production"/);
});

test("all containment targets are pure (no MAIN I/O) so they can validate inside the ADMIN tx", () => {
  const modules = [
    { path: ELIGIBILITY, target: "fiatEligibilityContainmentTarget", apply: "applyFiatEligibilityContainment" },
    { path: IDENTITY, target: "fiatIdentityContainmentTarget", apply: "applyFiatIdentityContainment" },
    { path: EMAIL_DOMAIN, target: "emailDomainContainmentTarget", apply: "applyEmailDomainContainment" },
    { path: CATCHALL, target: "abstractCatchallContainmentTarget", apply: "applyAbstractCatchallContainment" },
    { path: BLOCKLIST, target: "identifierBlocklistContainmentTarget", apply: "applyIdentifierBlocklistContainment" },
    { path: FREE_BATTLE, target: "riskyFreeBattleContainmentTarget", apply: "applyRiskyFreeBattleContainment" },
    { path: BEHAVIORAL, target: "behavioralWithdrawalContainmentTarget", apply: "applyBehavioralWithdrawalContainment" },
    { path: CRITICAL, target: "criticalSignupContainmentTarget", apply: "applyCriticalSignupContainment" },
  ];

  for (const mod of modules) {
    const body = source(mod.path);
    assert.match(body, new RegExp(`export function ${mod.target}`));
    assert.match(body, new RegExp(`export async function ${mod.apply}`));
    const targetFn = body.slice(
      body.indexOf(`export function ${mod.target}`),
      body.indexOf(`export async function ${mod.apply}`),
    );
    assert.doesNotMatch(targetFn, /getProdPrimaryDrizzleDb/);
    assert.doesNotMatch(targetFn, /db\.execute/);
    assert.doesNotMatch(targetFn, /getUserFeatureLocks|updateUserRewardLocks/);
  }
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
