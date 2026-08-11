import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Account Reviews isolate automatic bans in their own tab", () => {
  const page = source("src/app/(antifraud)/antifraud/reviews/page.tsx");
  const reviews = source("src/lib/antifraud/reviews.ts");

  assert.match(
    page,
    /REVIEW_TABS = \["reviews", "postponed", "auto-banned"\]/,
  );
  assert.doesNotMatch(page, /in_review: "In review"/);
  assert.match(page, /REVIEW_TABS\.map/);
  assert.match(page, /getAccountReviewTabCounts/);
  assert.match(
    reviews,
    /review\.status IN \('open', 'in_review', 'escalated'\)[\s\S]*?AS reviews/,
  );
  assert.match(
    reviews,
    /NOT review\.signals @> ARRAY\['whop_history_auto_ban'\]::text\[\]/,
  );
  assert.match(
    reviews,
    /review\.signals @> ARRAY\['whop_history_auto_ban'\]::text\[[\s\S]*?AS auto_banned/,
  );
  assert.match(page, /autoBanned: tab === "auto-banned"/);
  assert.doesNotMatch(reviews, /inReview: Number\(row\?\.in_review/);
  assert.match(page, /severities: \["critical", "high"\]/);
  assert.match(page, /severityFirst: true/);
  assert.match(page, /review:\s*review\.id/);
  assert.match(page, /<ReviewCaseDialog/);
});

test("opening a review navigates immediately and does not wait on queue data", () => {
  const button = source(
    "src/app/(antifraud)/antifraud/reviews/_components/start-review-button.tsx",
  );
  const page = source("src/app/(antifraud)/antifraud/reviews/page.tsx");

  const navigation = button.indexOf("router.push(href");
  const claimWait = button.indexOf("await startReview");
  assert.ok(navigation >= 0, "navigation must start immediately");
  assert.ok(claimWait > navigation, "navigation must not wait for the claim");
  assert.match(button, /router\.prefetch\(href\)/);

  const queueBoundary = page.indexOf('<Suspense key={filterKey}');
  const dialogBoundary = page.indexOf('key={selectedReviewId}');
  assert.ok(queueBoundary >= 0 && dialogBoundary > queueBoundary);
  assert.match(page, /queueData={queueData}/);
  assert.match(
    page,
    /fallback=\{[\s\S]*?<ReviewCaseDialog closeHref=\{closeHref\}>[\s\S]*?<CaseDialogSkeleton \/>/,
  );
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

test("every transition into In Review keeps or assigns an analyst", () => {
  const actions = source(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const migration = source(
    "drizzle/admin/migrations/20260805_backfill_in_review_assignees.sql",
  );

  assert.match(actions, /assigned_to: antifraud_reviews\.assigned_to/);
  assert.match(
    actions,
    /status === "in_review"[\s\S]*?current\.assigned_to \?\? session\.userId/,
  );
  assert.match(migration, /r\.status = 'in_review'/);
  assert.match(migration, /r\.assigned_to IS NULL/);
  assert.match(migration, /a\.metadata ->> 'to' = 'in_review'/);
  assert.match(migration, /SET assigned_to = candidate\.admin_user_id/);
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

test("case facts show one conditional box containing every active lock", () => {
  const reviews = source("src/lib/antifraud/reviews.ts");
  const workspace = source(
    "src/app/(antifraud)/antifraud/reviews/_components/review-case-workspace.tsx",
  );

  for (const field of [
    "locked_deposits_crypto",
    "locked_deposits_fiat",
    "locked_withdrawals_crypto",
    "locked_withdrawals_items",
    "locked_inventory_sales",
    "locked_exchanges",
    "locked_openings",
    "locked_vault",
  ]) {
    assert.match(reviews, new RegExp(field));
  }
  assert.match(workspace, /activeLocks\.length > 0/);
  assert.match(workspace, /Active locks/);
  assert.match(workspace, /lg:col-span-3/);
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

test("requiring KYC stays server-side and locks the account itself after review actions are simplified", () => {
  const actions = source("src/app/(antifraud)/antifraud/kyc/actions.ts");

  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /lockFiatAndWithdrawals\(/);
  assert.match(actions, /requireUserKyc\(/);
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
