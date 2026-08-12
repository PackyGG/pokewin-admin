import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const DELIVERY = "services/antifraud-monitor/src/ingest-delivery.ts";
const CONTAINMENT_VALIDATORS = [
  "src/lib/antifraud/critical-signup-containment.ts",
  "src/lib/antifraud/behavioral-withdrawal-containment.ts",
  "src/lib/antifraud/risky-free-battle-containment.ts",
  "src/lib/antifraud/abstract-catchall-containment.ts",
  "src/lib/antifraud/email-domain-containment.ts",
  "src/lib/antifraud/fiat-identity-containment.ts",
  "src/lib/antifraud/fiat-eligibility-containment.ts",
  "src/lib/antifraud/identifier-blocklist-containment.ts",
];

function preservedKeys(): Set<string> {
  const source = read(DELIVERY);
  const block = source.match(/const preservedKeys = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "preservedKeys array must exist in the delivery truncator");
  return new Set(
    [...block[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]),
  );
}

/**
 * Regression: the evidence-payload truncator dropped `riskBand`, `reasonCode`
 * (singular) and `actions`, which `criticalSignupContainmentTarget` requires.
 * A truncated critical-signup command therefore failed validation, the
 * dashboard recorded the alert and skipped containment PERMANENTLY, and no
 * outbox row was written so nothing ever retried. The accounts affected were
 * exactly the 70-100 risk-score signups whose provider evidence is large
 * enough to exceed MAX_EVIDENCE_PAYLOAD_BYTES.
 *
 * This test derives the requirement from the validators themselves, so a new
 * containment validator that reads a new payload key fails here instead of
 * silently losing containment in production.
 */
test("every payload key a containment validator reads survives truncation", () => {
  const preserved = preservedKeys();
  const missing: string[] = [];

  for (const file of CONTAINMENT_VALIDATORS) {
    let source: string;
    try {
      source = read(file);
    } catch {
      continue; // validator set may evolve; absent files are not a failure
    }
    for (const m of source.matchAll(/payload\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const key = m[1];
      if (!preserved.has(key)) missing.push(`${key} (read by ${file})`);
    }
  }

  assert.deepEqual(
    [...new Set(missing)],
    [],
    "these payload keys are read by a containment validator but are dropped " +
      "by the delivery truncator, which silently disables containment",
  );
});

test("the critical-signup admission fields are explicitly preserved", () => {
  const preserved = preservedKeys();
  for (const key of ["riskBand", "reasonCode", "actions", "containmentRequired"]) {
    assert.ok(
      preserved.has(key),
      `${key} must survive truncation or critical-signup containment is skipped`,
    );
  }
  // `reasonCode` and `reasonCodes` are DIFFERENT fields — keep both.
  assert.ok(preserved.has("reasonCodes"), "plural reasonCodes must also remain");
});

/**
 * Regression: the blacklist containment fast path gated on the LOCK receipt
 * (`match.lock_delivered_at IS NULL`) rather than the DELIVERY receipt. With a
 * LEFT JOIN, an event with no match row yielded NULL, passed the filter, and
 * could never be acknowledged — so it was redelivered every poll tick forever.
 * Because that branch returns before the ordinary stream is reached and
 * CONTAINMENT_BATCH_SIZE is 1, a single such event starved Account Review
 * delivery completely.
 */
test("the blacklist containment fast path is gated on the delivery receipt", () => {
  const source = read(DELIVERY);

  assert.match(
    source,
    /AND match\.source_event_id IS NOT NULL/,
    "the fast path must require a match row it can actually confirm",
  );
  assert.match(
    source,
    /AND re\.dashboard_delivered_at IS NULL/,
    "the fast path must be gated on the delivery receipt, not the lock receipt",
  );
  assert.doesNotMatch(
    source,
    /AND match\.lock_delivered_at IS NULL/,
    "gating delivery on the lock receipt is what forced the premature stamp",
  );
});

/**
 * Regression: delivery stamped `lock_delivered_at` unconditionally, even though
 * the dashboard answers HTTP 200 with `locksSkipped > 0` when containment
 * validation rejected the command or the lock otherwise did not happen. That
 * removed the row from confirmLocks()'s pending set — the only code that checks
 * `user_feature_locks` on MAIN — so a lock that never happened was recorded as
 * applied and was never retried or verified.
 *
 * Stamping on a CLEAN success stays correct and deliberate: confirmLocks()
 * reads the MAIN *mirror*, which lags, so requiring it for every row would
 * leave freshly-locked accounts pending and re-alerting. The contract is
 * therefore conditional, not absent.
 */
test("the lock receipt is withheld whenever the dashboard reports a skip", () => {
  const delivery = read(DELIVERY);
  const verifier = read("services/antifraud-monitor/src/fiat-email-domains.ts");

  // The worker must actually READ the skip count off the response.
  assert.match(
    delivery,
    /locksSkipped\?: unknown/,
    "IngestResponse must declare locksSkipped or it can never be read",
  );
  assert.match(delivery, /locksSkipped = Number\(result\.locksSkipped \?\? 0\)/);

  // …thread it into the confirmation…
  assert.match(
    delivery,
    /confirmContainmentEvents\(\s*\n?\s*client,\s*\n?\s*containmentRows,\s*\n?\s*containmentDelivery\.locksSkipped,/,
    "the skip count must reach the containment confirmation",
  );

  // …and bail out before stamping when a skip was reported.
  assert.match(
    delivery,
    /if \(locksSkipped > 0\) \{[\s\S]{0,400}?return;\s*\n\s*\}/,
    "a reported skip must prevent the lock receipt being written",
  );

  // The clean-success stamp is still present (mirror-lag contract).
  assert.match(delivery, /lock_delivered_at = COALESCE\(match\.lock_delivered_at, now\(\)\)/);

  // confirmLocks remains the authority that proves the lock exists on MAIN.
  assert.match(verifier, /lock_delivered_at = CASE\s*\n?\s*WHEN \$2::boolean THEN COALESCE\(lock_delivered_at, now\(\)\)/);
  assert.match(verifier, /FROM user_feature_locks/);
  assert.match(verifier, /'all' = ANY\(locked_withdrawals_crypto\)/);
});

/**
 * Regression: the five-minute containment watchdog re-applied locks for any
 * review still open/in_review, silently reversing a deliberate staff unlock.
 * And it re-stamped containment_applied_at on every sweep, so the displayed
 * "Automatically contained at" showed the last verification, not the action.
 */
test("the containment watchdog respects an audited staff unlock", () => {
  const source = read("src/lib/antifraud/containment-outbox.ts");

  assert.match(
    source,
    /NOT EXISTS \(\s*\n\s*SELECT 1\s*\n\s*FROM admin_audit_events AS unlocked/,
    "an explicit staff unlock must stand the watchdog down",
  );
  for (const eventType of [
    "antifraud_withdrawals_unlocked",
    "antifraud_critical_signup_restrictions_unlocked",
    "locked_withdrawals_crypto_enabled",
    "locked_withdrawals_items_enabled",
  ]) {
    assert.ok(
      source.includes(eventType),
      `${eventType} must be treated as a terminal staff release`,
    );
  }
  assert.match(source, /unlocked\.created_at > signal\.containment_applied_at/);
});

test("the containment action timestamp is written once, not per verification", () => {
  const source = read("src/lib/antifraud/containment-outbox.ts");

  assert.match(
    source,
    /containment_applied_at = CASE\s*\n\s*WHEN \$\{status\} = 'applied' THEN COALESCE\(containment_applied_at, now\(\)\)/,
    "containment_applied_at is a displayed action time and must be write-once",
  );
  // The per-verification timestamp keeps its own column.
  assert.match(source, /containment_last_verified_at = CASE/);
});

/**
 * Regression: the automatic containment pipeline writes TWO reason prefixes
 * ("Automatic fraud lock: " and "Automatic fraud ban: "), but the cleared-case
 * release only matched the first. A blocked-email-domain lock was therefore
 * invisible to release: clearing the case reported "review locks removed"
 * while the account stayed fiat- and withdrawal-locked permanently, with
 * nothing left in the queue to reveal it.
 *
 * Derived from the containment sources, so adding a new automatic reason
 * without teaching release about it fails here.
 */
test("cleared-case release matches every automatic lock reason the pipeline writes", () => {
  const release = read("src/lib/antifraud/withdrawal-release.ts");

  const declared = new Set(
    [
      ...(release.match(
        /const AUTOMATIC_FRAUD_LOCK_REASON_PREFIXES = \[([\s\S]*?)\] as const;/,
      )?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]),
  );
  // The list references the singular constant by name for the first entry.
  if (release.includes("AUTOMATIC_FRAUD_LOCK_REASON_PREFIX,")) {
    declared.add("Automatic fraud lock: ");
  }

  const written = new Set<string>();
  for (const file of [
    "src/lib/antifraud/email-domain-containment.ts",
    "src/lib/antifraud/fiat-identity-containment.ts",
    "src/lib/antifraud/critical-signup-containment.ts",
    "src/lib/antifraud/abstract-catchall-containment.ts",
    "src/lib/antifraud/behavioral-withdrawal-containment.ts",
    "src/lib/antifraud/risky-free-battle-containment.ts",
  ]) {
    let source: string;
    try {
      source = read(file);
    } catch {
      continue;
    }
    for (const m of source.matchAll(/(Automatic fraud [a-z]+: )/g)) {
      written.add(m[1]);
    }
  }

  const unmatched = [...written].filter((prefix) => !declared.has(prefix));
  assert.deepEqual(
    unmatched,
    [],
    "these automatic lock reasons are written by containment but are not " +
      "released when a case is cleared, so the account stays locked forever",
  );

  // The SQL must use the widened list, bound as one text[] via the house
  // array helper rather than a bare interpolated array.
  assert.match(
    release,
    /LIKE ANY \(\$\{pgArrayParam\(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS\)\}::text\[\]\)/,
  );
  assert.doesNotMatch(
    release,
    /LIKE \$\{AUTOMATIC_FRAUD_LOCK_REASON_PREFIX \+ "%"\}/,
    "the single-prefix comparison must not come back",
  );
});
