import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const auditSource = readFileSync(
  "src/lib/antifraud/security-audit.ts",
  "utf8",
);
const middlewareSource = readFileSync("src/middleware.ts", "utf8");
const migration = readFileSync(
  "drizzle/admin/migrations/20260730_antifraud_security_audit.sql",
  "utf8",
);
const accessSource = readFileSync("src/lib/antifraud/access.ts", "utf8");
const gateSource = readFileSync("src/lib/require-antifraud-access.ts", "utf8");
const stepUpSource = readFileSync("src/lib/require-2fa.ts", "utf8");

test("rate-limit denial is thrown only after its audit transaction commits", () => {
  const transaction = auditSource.indexOf(
    "const rateLimited = await adminDrizzle.transaction",
  );
  const transactionEnd = auditSource.indexOf(
    "if (rateLimited)",
    transaction,
  );
  assert.ok(transaction >= 0);
  assert.ok(transactionEnd > transaction);
  const transactionBody = auditSource.slice(transaction, transactionEnd);
  assert.match(transactionBody, /return limited/);
  assert.doesNotMatch(transactionBody, /throw new Error/);
});

test("middleware replaces untrusted antifraud audit context", () => {
  for (const header of [
    "x-antifraud-path",
    "x-antifraud-method",
    "x-antifraud-search-keys",
  ]) {
    assert.match(
      middlewareSource,
      new RegExp(`forwardedHeaders\\.delete\\("${header}"\\)`),
    );
  }
  assert.match(
    middlewareSource,
    /forwardedHeaders\.set\("x-antifraud-path", pathname/,
  );
  assert.match(
    middlewareSource,
    /forwardedHeaders\.set\("x-antifraud-method", request\.method/,
  );
});

test("security audit tables reject update, delete, and truncate", () => {
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /BEFORE TRUNCATE/);
  assert.match(migration, /append-only/);
});

test("dashboard authorization is role based and never uses Discord ids", () => {
  assert.match(accessSource, /getEffectiveRoles/);
  assert.match(gateSource, /isAntifraudAllowed/);
  assert.doesNotMatch(accessSource, /discord/i);
  assert.doesNotMatch(gateSource, /discord/i);
});

test("step-up replay storage failures fail closed", () => {
  assert.doesNotMatch(stepUpSource, /failed \(allowing\)/);
  assert.match(
    stepUpSource,
    /Verification replay protection is unavailable\. Try again later\./,
  );
});

test("new KYC requirements are restricted to currently locked accounts", () => {
  const eligibility = readFileSync(
    "src/lib/antifraud/kyc-eligibility.ts",
    "utf8",
  );
  const kycActions = readFileSync(
    "src/app/(antifraud)/antifraud/kyc/actions.ts",
    "utf8",
  );
  const fiatActions = readFileSync(
    "src/app/(antifraud)/antifraud/fiat-deposits/actions.ts",
    "utf8",
  );

  assert.match(eligibility, /locked_withdrawals_items = TRUE/);
  assert.match(
    eligibility,
    /cardinality\(locked_withdrawals_crypto\), 0\) > 0/,
  );
  assert.match(kycActions, /isLockedAccountEligibleForKyc\(userId\)/);
  assert.doesNotMatch(fiatActions, /requireUserKyc|backend-api\/kyc/);
});

test("historical blacklist matches open review without automatic containment", () => {
  const monitor = readFileSync(
    "services/antifraud-monitor/src/fiat-email-domains.ts",
    "utf8",
  );
  const routes = readFileSync(
    "services/antifraud-monitor/src/fiat-email-domain-routes.ts",
    "utf8",
  );
  const ingest = readFileSync(
    "src/app/api/antifraud/ingest/route.ts",
    "utf8",
  );

  assert.doesNotMatch(routes, /expires_at, backfill_completed_at/);
  assert.match(monitor, /\{ reviewOnly: true \}/);
  assert.match(
    monitor,
    /CASE WHEN \$12::boolean THEN now\(\) ELSE NULL END/,
  );
  assert.match(ingest, /signal\.payload\?\.reviewOnly !== true/);
});

test("every antifraud Server Action file has a live server-side gate", () => {
  const root = "src/app/(antifraud)/antifraud";
  const actionFiles: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      // Any `*actions.ts`, not just the two canonical names: a rename must not
      // be able to quietly drop a Server Action file out of this gate check.
      else if (/actions\.ts$/.test(entry.name)) {
        actionFiles.push(path);
      }
    }
  };
  walk(root);
  assert.ok(actionFiles.length >= 12);
  for (const file of actionFiles) {
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /requireAntifraud(?:Access|Manager)\(/,
      `${file} must enforce the live Antifraud gate`,
    );
  }
});
