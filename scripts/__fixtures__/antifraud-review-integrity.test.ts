import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("Account Review commands remain globally idempotent", () => {
  const migration = read(
    "drizzle/admin/migrations/20260726_antifraud_audit_idempotency.sql",
  );
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS/i);
  assert.match(migration, /metadata\s*->>\s*'idempotencyKey'/i);
  assert.match(migration, /antifraud_monitor_case_decision/);
  assert.match(migration, /antifraud_review_status_changed/);

  const reviewAction = read(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  assert.match(reviewAction, /idempotencyKey: z\.string\(\)\.uuid/);
  assert.match(reviewAction, /kind: "replayed",\s*targetUserId: /);
  assert.match(
    reviewAction,
    /tx\.insert\(antifraud_review_notes\)[\s\S]*?tx\.insert\(staff_profiles\)|tx\.insert\(staff_profiles\)[\s\S]*?tx\.insert\(antifraud_review_notes\)/,
    "status note and resolver credit must stay in the review transaction",
  );
});

test("legacy monitor case pages are retired into the Account Review popup", () => {
  const legacyRoute = path.join(
    root,
    "src/app/(antifraud)/antifraud/monitor/cases/[id]/page.tsx",
  );
  assert.equal(existsSync(legacyRoute), false);

  const monitor = read(
    "src/app/(antifraud)/antifraud/monitor/monitor-console.tsx",
  );
  const reviews = read("src/app/(antifraud)/antifraud/reviews/page.tsx");
  const reviewQueries = read("src/lib/antifraud/reviews.ts");
  assert.match(monitor, /\/antifraud\/reviews\?monitorCaseId=/);
  assert.match(reviews, /getReviewIdForMonitorCase\(monitorCaseId\)/);
  assert.match(reviewQueries, /payload ->> 'caseId'/);
  assert.match(reviewQueries, /payload ->> 'monitorCaseId'/);
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

test("approving a case releases every antifraud-owned automatic lock", () => {
  const release = read("src/lib/antifraud/withdrawal-release.ts");
  assert.match(release, /UPDATE user_feature_locks/);
  assert.match(release, /AUTOMATIC_FRAUD_LOCK_REASON_PREFIX/);
  assert.match(release, /locked_withdrawals_crypto = CASE/);
  assert.match(release, /locked_withdrawals_items = CASE/);
  assert.match(release, /locked_deposits_fiat = CASE/);
  assert.match(release, /locked_reward_categories\.length > 0/);
  assert.match(release, /antifraud_catchall_reward_lock_snapshot/);
  assert.match(release, /antifraud_catchall_lock_snapshot/);
  assert.match(release, /previousCategories/);
  assert.match(release, /previousMain/);
  assert.match(release, /savedMain\.appliedReason/);
  // Idempotent: only a genuinely locked row is touched, so a replay is a no-op.
  assert.match(
    release,
    /COALESCE\(array_length\(previous\.crypto, 1\), 0\) > 0[\s\S]*?OR previous\.items/,
  );
  assert.match(release, /locked_withdrawals_crypto_disabled/);
  assert.match(release, /locked_withdrawals_items_disabled/);
  assert.match(release, /antifraud_withdrawals_unlocked/);
  // Automatic Fiat locks are released; manual deposit and withdrawal locks
  // remain protected because they do not carry the automatic ownership prefix.
  assert.match(release, /previous\.deposits_reason LIKE/);
  assert.match(release, /previous\.withdrawals_reason LIKE/);
  // Release must match EVERY reason prefix the containment pipeline writes,
  // not just "Automatic fraud lock: ". The blocked-email-domain path writes
  // "Automatic fraud ban: " into the same columns, and while release compared a
  // single literal those locks survived a cleared case forever — the UI
  // reported "review locks removed" while the account stayed locked. The
  // pattern list is bound as one text[] via pgArrayParam (house array rule).
  assert.match(
    release,
    /previous\.withdrawals_reason LIKE ANY \(\$\{pgArrayParam\(AUTOMATIC_FRAUD_LOCK_REASON_PATTERNS\)\}::text\[\]\)/,
  );
  assert.match(release, /const AUTOMATIC_FRAUD_LOCK_REASON_PREFIXES = \[/);
  assert.match(release, /"Automatic fraud ban: "/);
  // A KYC gate is owner/admin + 2FA only. An analyst's clear must never lift
  // it, and an unreadable KYC state fails CLOSED.
  assert.match(
    release,
    /kyc\?\.required === true && kyc\.decision !== "safe"[\s\S]*?return \{ status: "kyc_gated" \}/,
  );
  assert.match(
    release,
    /KYC gate check failed[\s\S]*?return \{ status: "failed" \}/,
  );
  // The verdict is already committed — a MAIN failure must not throw past it.
  assert.match(release, /return \{ status: "failed" \}/);

  // Leaving `cleared` withdraws the release with the verdict, but only ever
  // restores what THIS case released — reopening must not invent a lock on an
  // account nobody had locked.
  assert.match(release, /export async function restoreWithdrawalLocksForReopenedCase/);
  assert.match(
    release,
    /event_type = 'antifraud_critical_signup_restrictions_unlocked'[\s\S]*?metadata ->> 'reviewId' = \$\{reviewId\}[\s\S]*?return \{ status: "nothing_to_restore" \}/,
  );
  assert.match(release, /INSERT INTO user_feature_locks/);
  assert.match(release, /releasedRewardCategories/);
  assert.match(release, /restoreFiat/);
  assert.match(release, /restoreWithdrawals/);

  const actions = read("src/app/(antifraud)/antifraud/reviews/actions.ts");
  assert.match(
    actions,
    /outcome\.previousStatus === "cleared"[\s\S]*?restoreReopenedCaseWithdrawals\(/,
    "leaving cleared must re-lock",
  );
  // A replay knows what it moved away from only from the recorded `from`.
  assert.match(actions, /function replayedFromStatus/);
  // ONE clearing path: the quick action delegates to updateReviewStatus, so
  // both entry points release through the same function.
  assert.match(
    actions,
    /status === "cleared"[\s\S]*?releaseClearedCaseWithdrawals\(/,
  );
  assert.equal(
    actions.match(/releaseWithdrawalLocksForClearedCase\(/g)?.length,
    1,
  );
  assert.match(actions, /if \(!result\.ok\) throw new Error\(result\.message\);\s*return \{ withdrawalRelease: result\.withdrawalRelease \}/);
  assert.match(actions, /promoteConfirmedCatchallDomainsForReview/);
  assert.match(actions, /catch-all promotion queued for retry/);

  const promotion = read("src/lib/antifraud/catchall-domain-promotion.ts");
  assert.match(promotion, /status = 'flagged'/);
  assert.match(promotion, /antifraud_catchall_domain_promoted/);
  assert.match(promotion, /promotionIdempotencyKey\(params\.reviewId, domain\)/);
  assert.match(promotion, /NOT EXISTS/);
  // The release runs after the ADMIN transaction commits, including on a
  // replay — that is what repairs a clear whose release never ran.
  assert.match(actions, /kind: "replayed";[\s\S]*?targetUserId: string/);

  for (const surface of [
    "src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
  ]) {
    const source = read(surface);
    assert.match(source, /withdrawalRelease === "failed"/, `${surface} must surface a failed release`);
    assert.match(source, /locks removed/i, `${surface} must tell the analyst what approving does`);
  }
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
  const analysts = read("src/lib/antifraud/review-analysts.ts");
  assert.match(actions, /import \{ isAssignableAnalyst \}/);
  assert.match(actions, /getAntifraudAccessSettings\(\)/);
  assert.match(actions, /getAntifraudUserAccess\(\)/);
  assert.match(analysts, /function isAssignableAnalyst/);
  assert.match(
    analysts,
    /canAccessAntifraud\(identity, settings, userAccess\)/,
  );
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
    /if \(!stored\) return[\s\S]*?requiresContainmentOutbox\(/,
    "containment admission must run AFTER the dedupe check so re-sent duplicates never re-lock",
  );
  assert.match(
    body,
    /if \(!stored\) return[\s\S]*?markContainmentPending\(tx, stored\.id\)/,
    "outbox pending mark must run AFTER the dedupe check",
  );
  assert.match(body, /tx[\s\S]*?update\(antifraud_reviews\)/);
  assert.match(body, /tx[\s\S]*?insert\(antifraud_review_notes\)/);
  assert.match(body, /update\(antifraud_signals\)[\s\S]*?review_id: reviewId/);
});

test("free-battle containment requires two battles and locks withdrawals without automatic KYC", () => {
  const containment = read(
    "src/lib/antifraud/risky-free-battle-containment.ts",
  );
  const ingest = read("src/app/api/antifraud/ingest/route.ts");
  const ingestStart = ingest.indexOf("async function ingestOne");
  const ingestEnd = ingest.indexOf("/**\n * Health probe", ingestStart);
  const ingestBody = ingest.slice(ingestStart, ingestEnd);

  assert.match(containment, /qualifyingBattleCount/);
  assert.match(containment, /matchCount < 2/);
  assert.match(containment, /battleCount < 2/);
  assert.match(containment, /containmentRequired !== true/);
  assert.match(containment, /INSERT INTO user_feature_locks/);
  assert.match(containment, /locked_withdrawals_crypto = ARRAY\['all'\]/);
  assert.match(containment, /locked_withdrawals_items = TRUE/);
  assert.doesNotMatch(containment, /requireUserKyc|getUserKyc/);
  assert.match(
    ingestBody,
    /if \(!stored\) return[\s\S]*?isContainmentOutboxKind\(signal\.kind\)/,
    "containment must run only after the signed event id is reserved",
  );
  assert.match(
    read("src/lib/antifraud/containment-outbox.ts"),
    /"risky_free_battle_containment"/,
  );
});

test("Abstract catch-all signup containment fully locks on signed provider evidence without KYC", () => {
  const helper = read(
    "src/lib/antifraud/abstract-catchall-containment.ts",
  );
  const ingest = read("src/app/api/antifraud/ingest/route.ts");
  const ingestStart = ingest.indexOf("async function ingestOne");
  const ingestEnd = ingest.indexOf("/**\n * Health probe", ingestStart);
  const ingestBody = ingest.slice(ingestStart, ingestEnd);

  assert.match(helper, /containmentRequired !== true/);
  assert.match(helper, /provider !== "abstract_email"/);
  assert.match(helper, /INSERT INTO user_feature_locks/);
  assert.match(helper, /locked_deposits_fiat = ARRAY\['all'\]/);
  assert.match(helper, /locked_withdrawals_items = TRUE/);
  assert.match(helper, /available_reward_categories/);
  assert.doesNotMatch(helper, /is_banned = TRUE|DELETE FROM session/);
  assert.doesNotMatch(helper, /is_locked = TRUE|requireUserKyc|getUserKyc/);
  assert.match(
    ingestBody,
    /if \(!stored\) return[\s\S]*?isContainmentOutboxKind\(signal\.kind\)/,
    "catch-all containment must run only after the signed event id is reserved",
  );
});
