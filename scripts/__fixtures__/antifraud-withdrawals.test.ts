import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("withdrawals are exposed as their own Fraud transaction section", () => {
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  const middleware = read("src/middleware.ts");
  const nextConfig = read("next.config.ts");
  assert.match(sidebar, /label="Transactions"/);
  assert.match(sidebar, /\/antifraud\/withdrawals/);
  assert.match(hosts, /"withdrawals"/);
  assert.match(
    middleware,
    /pathname === "\/withdrawals"[\s\S]*?appHost\?\.basePath !== "\/antifraud"/,
  );
  assert.doesNotMatch(
    nextConfig,
    /source:\s*"\/withdrawals"[\s\S]*?destination:\s*"\/transactions\/deposits/,
  );
});

test("the page reads the monitor service and never imports MAIN DB access", () => {
  const page = read("src/app/(antifraud)/antifraud/withdrawals/page.tsx");
  const detail = read(
    "src/app/(antifraud)/antifraud/withdrawals/[id]/page.tsx",
  );
  const api = read("src/lib/antifraud/withdrawals-api.ts");
  const dialog = read(
    "src/app/(antifraud)/antifraud/withdrawals/review-dialog.tsx",
  );
  const excludedUsers = read("src/lib/excluded-users/fetch.ts");
  assert.match(page, /listWithdrawalAssessments/);
  assert.match(page, /Review flow/);
  assert.doesNotMatch(page, /90-day account activity/);
  assert.match(page, /Gross wagered/);
  assert.match(page, /TransactionRailTabs/);
  assert.match(page, /lifecycle: "pending"/);
  assert.match(page, /label="Confirmed"/);
  assert.match(page, /trace\.entries/);
  assert.match(page, /restricted source/);
  assert.match(page, /WithdrawalReviewDialog/);
  assert.doesNotMatch(page, /href=\{`\/antifraud\/withdrawals\/\$\{/);
  assert.match(dialog, /Allocated funding for this withdrawal/);
  assert.match(dialog, /Linked funding accounts/);
  assert.match(dialog, /WithdrawalReviewControls/);
  assert.doesNotMatch(dialog, /Unreviewed/i);
  assert.match(detail, /Withdrawal review flow/);
  assert.match(detail, /90-day account activity/);
  assert.match(detail, /gross totals/);
  assert.match(detail, /ledger-based assessment/);
  assert.match(detail, /WithdrawalReviewControls/);
  assert.doesNotMatch(detail, /redirect\(["']\/withdrawals/);
  assert.doesNotMatch(page, /@\/lib\/db/);
  assert.doesNotMatch(detail, /@\/lib\/db/);
  assert.match(api, /\/v1\/withdrawals/);
  assert.match(api, /getExcludedUserIdsStrict/);
  assert.match(api, /x-antifraud-excluded-users/);
  assert.match(api, /admin_user_tags/);
  assert.match(api, /antifraud_reviews/);
  assert.match(
    excludedUsers,
    /getExcludedUserIdsStrict[\s\S]*?await loadExcludedUserIdsFromDb\(\)/,
  );
  assert.doesNotMatch(api, /from ["']@\/lib\/db["']/);
});

test("the monitor service keeps the source pool read-only and persists assessments", () => {
  const database = read("services/antifraud-monitor/src/db.ts");
  const risk = read("services/antifraud-monitor/src/withdrawal-risk.ts");
  const routes = read("services/antifraud-monitor/src/withdrawal-routes.ts");
  const routeHelpers = read(
    "services/antifraud-monitor/src/route-helpers.ts",
  );
  const migration = read(
    "services/antifraud-monitor/migrations/009_withdrawal_assessments.sql",
  );
  const workflowMigration = read(
    "services/antifraud-monitor/migrations/010_withdrawal_review_workflow.sql",
  );
  const v2Migration = read(
    "services/antifraud-monitor/migrations/015_withdrawal_risk_v2.sql",
  );
  assert.match(database, /default_transaction_read_only=on/);
  assert.match(risk, /INSERT INTO withdrawal_assessments/);
  assert.match(risk, /loadTimeline/);
  assert.match(risk, /flowChecks/);
  assert.match(risk, /COALESCE\(u\.role::text,''\)<>'creator'/);
  assert.match(risk, /interval '90 days'/);
  assert.match(risk, /balance_ledger_coverage/);
  assert.match(risk, /balance_after::numeric/);
  assert.match(risk, /voucher_pack_borrow/);
  assert.match(risk, /loadFundingTraceRows/);
  assert.match(risk, /LIMIT 5000/);
  assert.match(risk, /sender_user_id/);
  assert.match(risk, /user_feature_locks/);
  assert.match(risk, /user_kyc/);
  assert.match(risk, /restricted_funding_account/);
  assert.match(routes, /excludedUserIds/);
  assert.match(routes, /userIsCreator/);
  assert.match(routes, /rail: z\.enum\(\["fiat", "crypto"\]\)/);
  assert.match(routes, /lifecycle: z\.enum\(\["pending", "confirmed", "all"\]\)/);
  assert.match(routes, /method<>'crypto'/);
  assert.match(routes, /method='crypto'/);
  assert.match(routeHelpers, /excludedUsersHeaderSchema/);
  assert.match(routeHelpers, /cachedCreatorUserIds/);
  assert.doesNotMatch(routes, /SELECT DISTINCT user_id/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS withdrawal_assessments/);
  assert.match(
    workflowMigration,
    /CREATE TABLE IF NOT EXISTS withdrawal_review_events/,
  );
  assert.match(v2Migration, /model_version/);
});
