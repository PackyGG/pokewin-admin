import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

const page = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/credit-review-page.tsx",
);
const actions = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/actions.ts",
);
const controls = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/review-decision.tsx",
);
const workflow = read("src/lib/antifraud/fiat-credit-review.ts");
const adminPage = read("src/app/(antifraud)/antifraud/admin/deposits/page.tsx");
const adminActions = read("src/app/(antifraud)/antifraud/admin/deposits/actions.ts");
const adminControls = read("src/app/(antifraud)/antifraud/admin/deposits/declined-deposit-decision.tsx");
const retiredDetail = read("src/app/(antifraud)/antifraud/fiat-deposits/[id]/page.tsx");
const middleware = read("src/middleware.ts");
const withdrawals = read("src/app/(admin)/withdrawals/page.tsx");
const nav = read("src/lib/nav-config.ts");
const sidebar = read(
  "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
);
const legacyPage = read("src/app/(admin)/transactions/deposits/page.tsx");

test("Deposits is an active-only Antifraud Fiat credit review queue", () => {
  assert.match(page, /listFiatAssessments/);
  assert.match(page, /status: "review"/);
  assert.match(page, /getFiatCreditReviewStates/);
  assert.doesNotMatch(page, /QUEUE_STATUSES|Review status filters|refund_pending/);
  assert.doesNotMatch(page, /GlobalFiatReviewCard/);
  assert.doesNotMatch(page, /getFiatDepositAutomaticCreditConfig/);
  assert.doesNotMatch(page, /title="Fiat Deposit Reviews"/);
  assert.doesNotMatch(page, /title="Credit review queue"/);
  assert.doesNotMatch(page, /Review authorized Whop payments/);
  assert.doesNotMatch(page, /getDepositTransactions/);
  assert.doesNotMatch(page, /BigDepositsToggle/);
  assert.doesNotMatch(page, /getWithdrawals/);
  assert.doesNotMatch(page, /tab ===/);
  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(sidebar, /label: "Deposit reviews"/);
  assert.doesNotMatch(nav, /id: "nav\.deposits"/);
  assert.match(legacyPage, /redirect\("\/antifraud\/fiat-deposits"\)/);
  assert.doesNotMatch(page, /fiat-deposits\/\$\{encodeURIComponent\(item\.id\)\}/);
  assert.match(retiredDetail, /redirect\("\/antifraud\/fiat-deposits"\)/);
});

test("review decisions do not use the customer backend", () => {
  assert.doesNotMatch(actions, /backend-api/);
  assert.doesNotMatch(actions, /decideFiatDepositReview/);
  assert.match(actions, /getFiatAssessment/);
  assert.match(actions, /whopAdminClient/);
  assert.match(actions, /creditReviewedFiatDeposit/);
  assert.match(workflow, /UPDATE fiat_deposit_intents/);
  assert.match(workflow, /coin_deposit_grant/);
});

test("staff decisions require Fraud access, 2FA, reason, idempotency, and audit", () => {
  assert.match(actions, /requireAntifraudAccess\(\)/);
  assert.match(actions, /require2FA\(session\.userId, parsed\.data\.stepUpCredential\)/);
  assert.match(actions, /reason: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\)/);
  assert.match(actions, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(actions, /createAdminAuditEvent/);
  assert.match(actions, /fiat_deposit_credit_approved/);
  assert.match(actions, /fiat_deposit_declined_for_admin_review/);
  assert.match(actions, /futureAutoApprovalChanged: false/);
  assert.match(workflow, /locked_deposits_fiat = ARRAY\['all'\]/);
  assert.match(workflow, /locked_withdrawals_crypto = ARRAY\['all'\]/);
  assert.match(workflow, /locked_withdrawals_items = TRUE/);
  assert.doesNotMatch(workflow, /locked_deposits_crypto/);
  assert.match(actions, /revalidatePath\("\/antifraud\/fiat-deposits"\)/);
  assert.match(controls, /Approve balance credit/);
  assert.match(controls, /Decline and lock account/);
  assert.match(controls, /Future Fiat deposits will still require their own review/);
  assert.doesNotMatch(controls, /Reject and refund|Retry refund/);
  assert.match(controls, /StepUpField/);
});

test("Admin Deposits is manager-only and supports independent refund and ban decisions", () => {
  assert.match(adminPage, /requireAntifraudManagerPage\(\)/);
  assert.match(adminPage, /getDeclinedFiatCreditReviews/);
  assert.match(adminActions, /requireAntifraudManager\(/);
  assert.match(adminActions, /require2FA\(session\.userId, parsed\.data\.credential\)/);
  assert.match(adminActions, /whopAdminClient/);
  assert.match(adminActions, /blockKnownUserIdentifiers/);
  assert.match(adminActions, /safeWhopError/);
  assert.match(adminControls, /Refund only/);
  assert.match(adminControls, /Ban only/);
  assert.match(adminControls, /Refund \+ ban/);
  assert.match(adminControls, /Ban-only keeps the payment without crediting or refunding it/);
});

test("withdrawals remain available outside the Fiat review page", () => {
  assert.match(withdrawals, /requirePageAccess\("\/withdrawals"\)/);
  assert.match(withdrawals, /getWithdrawals/);
  assert.doesNotMatch(
    middleware,
    /if \(pathname === "\/withdrawals"\)[\s\S]{0,500}transactions\/deposits/,
  );
});

test("the retired Admin deposits route redirects to the Fraud webapp", () => {
  assert.match(middleware, /pathname === "\/transactions\/deposits"/);
  assert.match(middleware, /: "fiat-deposits"/);
  assert.match(middleware, /entry\.basePath === "\/antifraud"/);
  assert.match(middleware, /NextResponse\.redirect\(url, 308\)/);
});
