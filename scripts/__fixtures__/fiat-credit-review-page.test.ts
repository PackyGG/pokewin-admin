import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

const page = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/credit-review-page.tsx",
);
// Shell-first split: `page.tsx` owns the access gate + searchParams and paints
// the static shell; `credit-review-page.tsx` owns the queue behind <Suspense>.
const shell = read("src/app/(antifraud)/antifraud/fiat-deposits/page.tsx");
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
  assert.match(page, /scanFirstPage/);
  assert.match(page, /scanRestPages/);
  assert.doesNotMatch(page, /remainingPages|Math\.min\(Math\.max/);
  // The upstream walk stays BOUNDED. The monitor keeps staff-declined intents
  // in `status='review'` forever, so an all-pages loop grows without limit.
  assert.match(page, /const MAX_UPSTREAM_PAGES = \d+/);
  assert.match(page, /Math\.min\(pageCount, MAX_UPSTREAM_PAGES\)/);
  // Page 1 must survive a failing tail. Throwing on any page discarded rows
  // the operator could have decided, and rendered the queue empty on a money
  // surface — the one wrong answer this page must never give.
  assert.match(page, /if \(result\.error\) break;/);
  // The tail is fetched SERIALLY. Every list GET makes the monitor re-run a
  // full refresh pass, so a parallel wave multiplies that work per page and
  // is what pushed the scan past its budget in production.
  assert.doesNotMatch(page, /Promise\.all\(\s*Array\.from/);
  // The outer budget for page 1 must exceed the monitor client's own fetch
  // timeout. A smaller outer bound aborts requests that were still in flight
  // and reports a healthy monitor as a failure.
  const firstBudget = Number(
    /const FIRST_PAGE_TIMEOUT_MS = ([\d_]+)/.exec(page)?.[1]?.replace(/_/g, ""),
  );
  const clientTimeout = Number(
    /const TIMEOUT_MS = ([\d_]+)/
      .exec(read("src/lib/antifraud/fiat-deposits-api.ts"))?.[1]
      ?.replace(/_/g, ""),
  );
  assert.ok(
    Number.isFinite(firstBudget) && Number.isFinite(clientTimeout),
    "could not read the two timeout constants",
  );
  assert.ok(
    firstBudget > clientTimeout,
    `first-page budget ${firstBudget}ms must exceed the client fetch timeout ${clientTimeout}ms`,
  );
  // …and every read is timeout-bounded and degrades LOUDLY (money surface).
  assert.match(page, /safeQuery\(/);
  assert.match(page, /DegradedNotice/);
  assert.match(shell, /requireAntifraudPageAccess\(\)/);
  assert.match(shell, /<Suspense/);
  assert.match(shell, /FiatDepositReviewsSkeleton/);
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
  assert.match(actions, /requireWhopCompanyId/);
  assert.match(actions, /creditReviewedFiatDeposit/);
  assert.match(actions, /completeReviewedFiatPostCreditEffects/);
  assert.match(workflow, /UPDATE fiat_deposit_intents/);
  assert.match(workflow, /coin_deposit_grant/);
  assert.match(workflow, /payment\.metadata\?\.deposit_intent_id !== input\.depositIntentId/);
  assert.match(workflow, /Whop amount mismatch/);
  assert.match(workflow, /payment_method_type/);
  assert.match(workflow, /affiliate_code_usages/);
  assert.match(workflow, /type = 'deposit_bonus'/);
  assert.match(workflow, /payment_provider_fees/);
  assert.match(workflow, /deposit_completed:/);
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
  assert.match(actions, /Date\.now\(\) - 5 \* 60_000/);
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
  // The declined queue streams behind <Suspense> with a timeout-bounded read.
  assert.match(adminPage, /<Suspense/);
  assert.match(adminPage, /safeQuery\(/);
  assert.match(adminPage, /antifraud\.admin\.declined-deposits/);
  assert.match(adminActions, /requireAntifraudManager\(/);
  assert.match(adminActions, /require2FA\(session\.userId, parsed\.data\.credential\)/);
  assert.match(adminActions, /whopAdminClient/);
  assert.match(adminActions, /blockKnownUserIdentifiers/);
  assert.match(adminActions, /safeWhopError/);
  assert.match(adminActions, /requireWhopCompanyId/);
  assert.match(adminActions, /INTERVAL '5 minutes'/);
  assert.match(adminActions, /refund_status IN \('processing', 'unknown'\)/);
  assert.match(adminActions, /secondary admin audit failed/);
  assert.match(adminControls, /Refund only/);
  assert.match(adminControls, /Ban only/);
  assert.match(adminControls, /Refund \+ ban/);
  assert.match(adminControls, /Refund outcome needs provider reconciliation/);
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
