import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Account Reviews use the three counted operational tabs", () => {
  const page = source("src/app/(antifraud)/antifraud/reviews/page.tsx");

  assert.match(page, /REVIEW_TABS = \["reviews", "in_review", "postponed"\]/);
  assert.match(page, /REVIEW_TABS\.map/);
  assert.match(page, /getAccountReviewTabCounts/);
  assert.match(page, /severities: \["critical", "high"\]/);
  assert.match(page, /severityFirst: true/);
  assert.match(page, /review:\s*review\.id/);
  assert.match(page, /<ReviewCaseDialog/);
});

test("dismissing a live review postpones it unless an action completed", () => {
  const dialog = source(
    "src/app/(antifraud)/antifraud/reviews/_components/review-case-dialog.tsx",
  );
  const quickActions = source(
    "src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
  );

  assert.match(dialog, /actionCompletedRef\.current \|\| !dismissHandler/);
  assert.match(dialog, /void dismissHandler\(\)/);
  assert.match(quickActions, /dismissal\.registerDismissHandler\(\(\) =>/);
  assert.match(quickActions, /expectedStatus: status/);
  assert.match(quickActions, /onActionCompleted\?\.\(\)/);
});

test("case facts show lifetime fiat, crypto, and wager totals", () => {
  const reviews = source("src/lib/antifraud/reviews.ts");
  const workspace = source(
    "src/app/(antifraud)/antifraud/reviews/_components/review-case-workspace.tsx",
  );

  assert.match(reviews, /crypto_asset IS NULL/);
  assert.match(reviews, /crypto_asset IS NOT NULL/);
  assert.match(reviews, /SELECT total_wagered::numeric/);
  assert.match(workspace, /label: "Fiat deposits"/);
  assert.match(workspace, /label: "Crypto deposits"/);
  assert.match(workspace, /label: "Wagered money"/);
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

test("review reminders and postponement run after 2 hours", () => {
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
  assert.match(policy, /postponed:\s*2 \* 60 \* 60 \* 1_000/);
  assert.match(policy, /normal:\s*2 \* 60 \* 60 \* 1_000/);
  assert.match(policy, /urgent:\s*2 \* 60 \* 60 \* 1_000/);
  assert.match(reminders, /review\.created_at \+ interval '2 hours'/);
  assert.match(reminders, /workflow\.postponed_until > now\(\)/);
  assert.doesNotMatch(reminders, /escalate:/);
  assert.doesNotMatch(reminders, /48\s*\*\s*60\s*\*\s*60/);
});

test("KYC eligibility remains server-side after review actions are simplified", () => {
  const eligibility = source("src/lib/antifraud/kyc-eligibility.ts");
  const actions = source("src/app/(antifraud)/antifraud/kyc/actions.ts");

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
