import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

test("review queue prefix search and COUNT have trigram coverage", () => {
  const migration = read(
    "drizzle/admin/migrations/20260726_antifraud_review_search_indexes.sql",
  );
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
  for (const column of ["target_username", "target_user_id", "reason"]) {
    assert.match(
      migration,
      new RegExp(`\\(${column} gin_trgm_ops\\)`, "i"),
      `${column} must have pg_trgm coverage`,
    );
  }

  const source = read("src/lib/antifraud/reviews.ts");
  assert.match(source, /const prefix = `\$\{term\}%`;/);
  assert.doesNotMatch(
    source,
    /const pattern = `%\$\{term\}%`;/,
    "leading-wildcard queue search must not return",
  );
  assert.match(
    source,
    /const conditions = buildReviewConditions\(filters\);[\s\S]*?const pageConditions = \[\.\.\.conditions\];[\s\S]*?count\(\*\)/,
    "page and COUNT must share one predicate set",
  );
});

test("antifraud command audit mirrors are globally idempotent", () => {
  const migration = read(
    "drizzle/admin/migrations/20260726_antifraud_audit_idempotency.sql",
  );
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS/i);
  assert.match(migration, /metadata\s*->>\s*'idempotencyKey'/i);
  assert.match(migration, /antifraud_monitor_case_decision/);
  assert.match(migration, /antifraud_review_status_changed/);

  const monitorAction = read(
    "src/app/(antifraud)/antifraud/monitor/cases/[id]/actions.ts",
  );
  assert.match(monitorAction, /await mirrorDecisionAudit\(/);
  assert.doesNotMatch(
    monitorAction,
    /if\s*\(!result\.idempotent\)/,
    "an upstream replay must still retry the ADMIN audit mirror",
  );

  const reviewAction = read(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  assert.match(reviewAction, /idempotencyKey: z\.string\(\)\.uuid/);
  assert.match(reviewAction, /return \{ kind: "replayed" \}/);
  assert.match(
    reviewAction,
    /tx\.insert\(antifraud_review_notes\)[\s\S]*?tx\.insert\(staff_profiles\)|tx\.insert\(staff_profiles\)[\s\S]*?tx\.insert\(antifraud_review_notes\)/,
    "status note and resolver credit must stay in the review transaction",
  );
});

test("manual case open keeps case, trail and audit in one transaction", () => {
  const source = read(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const start = source.indexOf("export async function openReview");
  const end = source.indexOf("/** Verdict statuses", start);
  const body = source.slice(start, end);

  assert.match(body, /adminDrizzle\.transaction/);
  assert.match(body, /tx\.insert\(antifraud_reviews\)/);
  assert.match(body, /tx\.insert\(antifraud_review_notes\)/);
  assert.match(body, /tx\.insert\(admin_audit_events\)/);
  assert.match(body, /isPostgresError\(err, UNIQUE_VIOLATION\)/);
  assert.match(body, /conflictReviewId/);
});

test("Antifraud revocation outages fail closed and assignments recheck access", () => {
  const access = read("src/lib/antifraud/access.ts");
  assert.match(access, /if \(userAccess\?\.loaded === false\) return false;/);
  assert.match(
    access,
    /unavailableAntifraudUserAccess[\s\S]*loaded: false/,
  );

  for (const file of [
    "src/lib/require-antifraud-access.ts",
    "src/lib/app-access.ts",
    "src/app/(antifraud)/antifraud/layout.tsx",
    "src/app/(admin)/layout.tsx",
  ]) {
    assert.match(
      read(file),
      /unavailableAntifraudUserAccess\(\)/,
      `${file} must preserve unknown revocations as unavailable`,
    );
  }

  const actions = read(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  assert.match(actions, /function isAssignableAnalyst/);
  assert.match(actions, /getAntifraudAccessSettings\(\)/);
  assert.match(actions, /getAntifraudUserAccess\(\)/);
  assert.match(actions, /canAccessAntifraud\(identity, settings, userAccess\)/);
  assert.doesNotMatch(actions, /body: applied\.reason/);
});

test("signed signal ingestion reserves id and mutates its case atomically", () => {
  const source = read("src/app/api/antifraud/ingest/route.ts");
  const start = source.indexOf("async function ingestOne");
  const end = source.indexOf("/**\n * Health probe", start);
  const body = source.slice(start, end);

  assert.match(body, /adminDrizzle\.transaction/);
  assert.match(body, /tx[\s\S]*?insert\(antifraud_signals\)/);
  assert.match(body, /onConflictDoNothing/);
  assert.match(
    body,
    /if \(!stored\) return \{ outcome: "duplicate", lockSkipped: false \}/,
  );
  assert.match(
    body,
    /if \(!stored\) return[\s\S]*?containBlacklistedEmailDomainAccount\(signal\)/,
    "containment lock must run AFTER the dedupe check so re-sent duplicates never re-lock",
  );
  assert.match(body, /tx[\s\S]*?update\(antifraud_reviews\)/);
  assert.match(body, /tx[\s\S]*?insert\(antifraud_review_notes\)/);
  assert.match(body, /update\(antifraud_signals\)[\s\S]*?review_id: reviewId/);
});

test("free-battle containment requires two battles and applies KYC plus withdrawal locks", () => {
  const source = read("src/app/api/antifraud/ingest/route.ts");
  const containmentStart = source.indexOf(
    "async function containRiskyFreeBattleAccount",
  );
  const containmentEnd = source.indexOf("type IngestResult", containmentStart);
  const containment = source.slice(containmentStart, containmentEnd);
  const ingestStart = source.indexOf("async function ingestOne");
  const ingestEnd = source.indexOf("/**\n * Health probe", ingestStart);
  const ingest = source.slice(ingestStart, ingestEnd);

  assert.match(containment, /qualifyingBattleCount/);
  assert.match(containment, /matchCount < 2/);
  assert.match(containment, /battleCount < 2/);
  assert.match(containment, /containmentRequired !== true/);
  assert.match(containment, /INSERT INTO user_feature_locks/);
  assert.match(containment, /locked_withdrawals_crypto = ARRAY\['all'\]/);
  assert.match(containment, /locked_withdrawals_items = TRUE/);
  assert.match(containment, /requireUserKyc/);
  assert.match(source, /system:antifraud-free-battle-containment/);
  assert.match(
    ingest,
    /if \(!stored\) return[\s\S]*?containRiskyFreeBattleAccount\(signal\)/,
    "containment must run only after the signed event id is reserved",
  );
});

test("Abstract catch-all signup containment requires signed provider evidence", () => {
  const source = read("src/app/api/antifraud/ingest/route.ts");
  const helper = read(
    "src/lib/antifraud/abstract-catchall-containment.ts",
  );
  const containmentStart = source.indexOf(
    "async function containAbstractCatchallAccount",
  );
  const containmentEnd = source.indexOf(
    "function containmentCount",
    containmentStart,
  );
  const containment = source.slice(containmentStart, containmentEnd);
  const ingestStart = source.indexOf("async function ingestOne");
  const ingestEnd = source.indexOf("/**\n * Health probe", ingestStart);
  const ingest = source.slice(ingestStart, ingestEnd);

  assert.match(helper, /containmentRequired !== true/);
  assert.match(helper, /provider !== "abstract_email"/);
  assert.match(containment, /UPDATE "user"/);
  assert.match(containment, /is_locked = TRUE/);
  assert.match(containment, /WHEN is_locked THEN locked_by ELSE NULL/);
  assert.match(containment, /WHEN is_locked THEN locked_until ELSE NULL/);
  assert.match(containment, /INSERT INTO user_feature_locks/);
  assert.match(containment, /locked_withdrawals_crypto = ARRAY\['all'\]/);
  assert.match(containment, /locked_withdrawals_items = TRUE/);
  assert.match(containment, /requireUserKyc/);
  assert.match(source, /system:antifraud-abstract-email/);
  assert.match(
    ingest,
    /if \(!stored\) return[\s\S]*?containAbstractCatchallAccount\(signal\)/,
    "catch-all containment must run only after the signed event id is reserved",
  );
});
