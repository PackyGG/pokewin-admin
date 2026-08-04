import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Account Reviews use the exact four operational tabs", () => {
  const workflow = source("src/lib/antifraud/review-workflow.ts");
  const page = source("src/app/(antifraud)/antifraud/reviews/page.tsx");

  assert.match(
    workflow,
    /REVIEW_QUEUE_STATES = \[\s*"priority",\s*"normal",\s*"waiting_kyc",\s*"postponed",\s*\]/,
  );
  assert.match(page, /: "priority"/);
  assert.match(page, /REVIEW_QUEUE_STATES\.map/);
  assert.match(page, /review:\s*review\.id/);
  assert.match(page, /<ReviewCaseDialog/);
});

test("priority and waiting classification use lock, KYC, and 70+ evidence", () => {
  const workflow = source("src/lib/antifraud/review-workflow.ts");

  assert.match(workflow, /ULTRA_HIGH_REVIEW_SCORE = 70/);
  assert.match(workflow, /fullyLocked:\s*cryptoLocked && itemLocked/);
  assert.match(workflow, /evidence\.withdrawalsLocked/);
  assert.match(workflow, /evidence\.kycFinished/);
  assert.match(workflow, /return "waiting_kyc"/);
  assert.match(workflow, /return "priority"/);
  assert.match(workflow, /return "normal"/);
  assert.match(workflow, /getReadDrizzleDb\(\)/);
  assert.match(workflow, /user_feature_locks/);
  assert.match(workflow, /user_kyc/);
});

test("review reminders run every 2 hours while postponement remains 2.5 hours", () => {
  const actions = source(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const reminders = source(
    "src/lib/discord-notifications/review-reminders.ts",
  );
  const policy = source(
    "src/lib/discord-notifications/antifraud-policy.ts",
  );
  const migration = source(
    "drizzle/admin/migrations/20260730_antifraud_review_workflow.sql",
  );

  assert.match(actions, /export async function postponeReview/);
  assert.match(actions, /antifraud_review_postponed/);
  assert.match(actions, /antifraud_review_notes/);
  assert.match(actions, /onConflictDoNothing\(\)/);
  assert.match(migration, /admin_audit_review_postponed_idempotency_idx/);
  assert.match(policy, /postponed:\s*2\.5 \* 60 \* 60 \* 1_000/);
  assert.match(policy, /normal:\s*2 \* 60 \* 60 \* 1_000/);
  assert.match(policy, /urgent:\s*2 \* 60 \* 60 \* 1_000/);
  assert.match(reminders, /review\.created_at \+ interval '2 hours'/);
  assert.match(reminders, /workflow\.postponed_until > now\(\)/);
  assert.doesNotMatch(reminders, /escalate:/);
  assert.doesNotMatch(reminders, /48\s*\*\s*60\s*\*\s*60/);
});

test("KYC request is shown only for a fully locked account and rechecked server-side", () => {
  const workspace = source(
    "src/app/(antifraud)/antifraud/reviews/_components/review-case-workspace.tsx",
  );
  const eligibility = source("src/lib/antifraud/kyc-eligibility.ts");
  const actions = source("src/app/(antifraud)/antifraud/kyc/actions.ts");

  assert.match(workspace, /workflow\?\.evidence\.fullyLocked/);
  assert.match(workspace, /!detail\.detail\.workflow\.evidence\.kycRequired/);
  assert.match(workspace, /<RequireKycDialog/);
  assert.match(eligibility, /locked_withdrawals_items = TRUE/);
  assert.match(eligibility, /cardinality\(locked_withdrawals_crypto\), 0\) > 0/);
  assert.match(actions, /isLockedAccountEligibleForKyc\(userId\)/);
});

test("IP and fingerprint cluster detection never requests KYC automatically", () => {
  for (const path of [
    "services/antifraud-monitor/src/network-risk.ts",
    "services/antifraud-monitor/src/monitor.ts",
    "src/app/api/antifraud/ingest/route.ts",
  ]) {
    const detector = source(path);
    assert.doesNotMatch(
      detector,
      /requireUserKyc|requireAccountKyc/,
      `${path} must leave KYC as a locked-account staff action`,
    );
  }
});
