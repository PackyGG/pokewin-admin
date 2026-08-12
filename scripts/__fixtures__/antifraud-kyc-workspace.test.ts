import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("the Antifraud sidebar exposes KYC reviews in the Main section", () => {
  const sidebar = source(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const loading = source("src/app/(antifraud)/antifraud/kyc/loading.tsx");
  const appHosts = source("src/lib/app-hosts.ts");

  assert.match(
    sidebar,
    /const MAIN_NAV[\s\S]*?label:\s*"KYC reviews",\s*href:\s*"\/antifraud\/kyc"/,
  );
  assert.match(sidebar, /label="Main"[\s\S]*?items=\{MAIN_NAV\}/);
  assert.doesNotMatch(sidebar, /label="KYC"/);
  assert.doesNotMatch(page, /max-w-7xl/);
  assert.doesNotMatch(loading, /max-w-7xl/);
  assert.doesNotMatch(page, /<h1[^>]*>KYC review<\/h1>/);
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"kyc"/,
  );
});

test("the KYC page is workspace-gated and never renders raw provider payloads", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /canManageAntifraud\(session\)/);
  assert.doesNotMatch(query, /payload:\s*sumsub_webhook_events\.payload/);
});

test("KYC mutations are manager-only and preserve the verification-cycle guard", () => {
  const actions = source("src/app/(antifraud)/antifraud/kyc/actions.ts");

  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /lockFiatAndWithdrawals\(/);
  assert.match(actions, /requireUserKyc\(/);
  assert.match(actions, /reviewUserKyc\(/);
  assert.match(actions, /expectedCycle:\s*parsed\.data\.expectedCycle/);
  // Durable (retry + fallback row), not a bare try/catch: a transient
  // ADMIN-DB blip must not leave a completed KYC mutation unaudited.
  assert.match(actions, /createAdminAuditEventDurable\(/);
  assert.match(actions, /outcome\.status === "lost"/);
  // Once the backend command commits, a transient status read must never be
  // reported as a command failure that invites a second verification cycle.
  assert.match(actions, /readKycAfterMutation/);
  assert.match(actions, /data: UserKycStatus \| null/);
  assert.match(actions, /verificationCycle = required\.verificationCycle/);
  assert.match(actions, /user_kyc_containment_incomplete/);
  assert.match(actions, /failedStage: "tips_lock"/);
  assert.match(actions, /failedStage: "kyc_requirement"/);
});

test("admins can ban an active KYC account while preserving its history", () => {
  const actions = source("src/app/(antifraud)/antifraud/kyc/actions.ts");
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const button = source(
    "src/app/(antifraud)/antifraud/kyc/_components/ban-kyc-account-button.tsx",
  );
  const start = actions.indexOf("export async function banAccountFromKyc");
  const banAction = actions.slice(start);

  assert.match(page, /<BanKycAccountButton/);
  assert.match(button, /Ban and remove from active KYC/);
  assert.match(button, /ANTIFRAUD_BAN_REASON_PRESETS/);
  assert.match(banAction, /requireAntifraudManager\(/);
  assert.match(banAction, /requireCapability\(session, "__can_ban_users"/);
  assert.match(
    banAction,
    /require2FA\(session\.userId, parsed\.data\.credential\)/,
  );
  assert.match(banAction, /blockKnownUserIdentifiers\(/);
  assert.match(banAction, /antifraud_ban_partial_failure/);
  assert.match(banAction, /decision: "rejected"/);
  assert.match(banAction, /DELETE FROM session/);
  assert.doesNotMatch(banAction, /DELETE FROM user_kyc/);
});

test("the dashboard reports both internal state and Sumsub evidence", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(query, /user_kyc/);
  assert.match(query, /sumsub_webhook_events/);
  assert.match(query, /usedLevels/);
  assert.match(query, /backendUrlConfigured/);
  assert.match(query, /automaticUnlock:\s*false/);
  assert.doesNotMatch(page, /How KYC works here/);
  assert.match(page, /active:\s*"Active"/);
  assert.match(page, /waiting:\s*"Waiting \(24h\+\)"/);
  assert.match(page, /History \/ Finished/);
  assert.match(page, /Finished KYC history/);
  assert.match(page, /Ready for admin decision/);
  assert.match(page, /<AccountRowEvidence account=\{account\}/);
  assert.match(page, /label:\s*"Decline type"/);
  assert.match(page, /Provider note:/);
  assert.match(page, /label:\s*"Last event"/);
  assert.doesNotMatch(page, /System details and webhook activity/);
  assert.doesNotMatch(page, /Configuration and policy/);
  assert.doesNotMatch(page, /Sumsub webhook evidence/);
  assert.doesNotMatch(page, /<SystemDetails/);
});

test("the KYC landing view defaults to the active records", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");

  assert.match(
    page,
    /isKycFilter\(params\.status\)\s*\?\s*params\.status\s*:\s*"active"/,
  );
  assert.match(page, /active:\s*"Active"/);
  assert.match(page, /waiting:\s*"Waiting \(24h\+\)"/);
  assert.match(page, /history:\s*"History \/ Finished"/);
  assert.match(page, /No KYC checks are currently active/);
  assert.match(page, /completed historical cycles/);
  assert.match(
    page,
    /Country:[\s\S]*?account\.countryCode\?\.toUpperCase\(\)\s*\?\?\s*"Unknown"/,
  );
});

test("untouched default KYC rows stay out of the review queue and totals", () => {
  const query = source("src/lib/antifraud/kyc.ts");

  assert.match(query, /function meaningfulKycRecordCondition\(\): SQL/);
  assert.match(
    query,
    /const conditions: SQL\[\] = \[meaningfulKycRecordCondition\(\)\]/,
  );
  assert.match(
    query,
    /FROM user_kyc\s+WHERE \$\{meaningfulKycRecordCondition\(\)\}/,
  );
  assert.match(query, /verification_cycle\} > 0/);
  assert.match(query, /status\} <> 'none'/);
});

test("the KYC queue exposes only the active, waiting and finished views", () => {
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");
  const query = source("src/lib/antifraud/kyc.ts");
  const labels = page.slice(
    page.indexOf("const FILTER_LABELS"),
    page.indexOf("const FILTER_TITLES"),
  );

  // Exact `key: "Label"` pairs, compared literally. Several labels carry regex
  // metacharacters, and the whole point of this guard is that the mapping
  // cannot drift without the fixture noticing — which is exactly what happened
  // when the Waiting tab was split out and this file was left behind.
  for (const pair of [
    'active: "Active"',
    'waiting: "Waiting (24h+)"',
    'history: "History / Finished"',
  ]) {
    assert.ok(labels.includes(pair), `FILTER_LABELS must contain ${pair}`);
  }
  for (const removed of [
    "All",
    "Withdrawals locked",
    "Decision open",
    "Waiting on Sumsub",
    "Sumsub approved",
    "Rejected / failed",
    "Cleared by admin",
  ]) {
    assert.doesNotMatch(labels, new RegExp(removed));
  }
  assert.match(
    query,
    /export const KYC_FILTERS = \["active", "waiting", "history"\] as const/,
  );
});

test("live Sumsub details stay admin-only, read-only, and sanitized", () => {
  const client = source("services/antifraud-monitor/src/sumsub-client.ts");
  const routes = source("services/antifraud-monitor/src/sumsub-routes.ts");
  const auth = source("services/antifraud-monitor/src/auth.ts");
  const dashboardApi = source("src/lib/antifraud/sumsub-review-api.ts");
  const card = source("src/app/(admin)/users/[id]/kyc-card.tsx");

  assert.match(client, /\.update\(`\$\{timestamp\}GET\$\{path\}`\)/);
  assert.match(client, /requiredIdDocsStatus/);
  assert.match(client, /review\/history/);
  assert.doesNotMatch(client, /firstName|lastName|dob|documentNumber|imageIds/);
  assert.match(
    routes,
    /app\.get\("\/v1\/kyc\/applicants\/:applicantId\/review"/,
  );
  assert.match(auth, /pathname\.startsWith\("\/v1\/kyc\/applicants\/"\)/);
  assert.match(dashboardApi, /ANTIFRAUD_MONITOR_API_ADMIN_TOKEN/);
  assert.match(card, /Live Sumsub review evidence/);
  assert.match(card, /Country mismatch/);
  assert.match(
    card,
    /Names, birth dates, document numbers, addresses and images are not/,
  );
});

test("finished KYC records save and expose account-country mismatches", () => {
  const service = source(
    "services/antifraud-monitor/src/kyc-country-reviews.ts",
  );
  const migration = source(
    "services/antifraud-monitor/migrations/034_kyc_country_reviews.sql",
  );
  const routes = source("services/antifraud-monitor/src/sumsub-routes.ts");
  const dashboardApi = source("src/lib/antifraud/sumsub-review-api.ts");
  const query = source("src/lib/antifraud/kyc.ts");
  const page = source("src/app/(antifraud)/antifraud/kyc/page.tsx");

  assert.match(service, /document\.reviewAnswer !== "RED"/);
  assert.match(service, /countries\.alpha3ToAlpha2/);
  assert.match(service, /countryMatch[\s\S]*?"mismatch"/);
  assert.doesNotMatch(
    service,
    /firstName|lastName|dateOfBirth|documentNumber|imageIds|address/,
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS kyc_country_reviews/);
  assert.match(migration, /PRIMARY KEY \(user_id, applicant_id\)/);
  assert.match(routes, /app\.post\("\/v1\/kyc\/country-checks\/refresh"/);
  assert.match(dashboardApi, /refreshKycCountryReviews/);
  assert.match(query, /account\.status === "approved"/);
  assert.match(page, /Country mismatch/);
  assert.match(page, /Country evidence saved/);
  assert.match(page, /Review the saved country evidence/);
});

test("account reviews keep KYC workflow sync outside the simplified queue", () => {
  const page = source("src/app/(antifraud)/antifraud/reviews/page.tsx");
  const reviews = source("src/lib/antifraud/reviews.ts");
  const workflow = source("src/lib/antifraud/review-workflow.ts");
  const ops = source("src/app/api/antifraud/ops/tick/route.ts");

  assert.match(page, /REVIEW_TABS = \["reviews", "postponed", "auto-banned"\]/);
  assert.doesNotMatch(page, /"in_review"/);
  assert.match(ops, /syncReviewWorkflowStates\(\)/);
  assert.doesNotMatch(page, /syncReviewWorkflowStates\(\)/);
  assert.doesNotMatch(page, /listKycRequiredUserIds/);
  assert.match(reviews, /queue\?: ReviewQueueState/);
  assert.match(workflow, /return "waiting_kyc"/);
  assert.match(workflow, /evidence\.kycRequired/);
  assert.match(workflow, /!evidence\.kycFinished/);
});
