import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isFiatAutoCreditEligible } from "../../src/lib/antifraud/fiat-auto-credit-eligibility";

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
const evidence = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/review-evidence.tsx",
);
const autoCreditControl = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/allow-auto-credit-action.tsx",
);
const autoCreditActions = read(
  "src/app/(antifraud)/antifraud/fiat-deposits/auto-credit-actions.ts",
);
const reviewUsers = read("src/lib/queries/fiat-deposit-review-users.ts");
const workflow = read("src/lib/antifraud/fiat-credit-review.ts");
const mainSchema = read("src/lib/db-schema/main/schema.ts");
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
// The Admin money-flow ledger. It shares the /transactions/deposits route
// with the Fiat credit queue's short-lived stay there, so it is asserted to
// carry NONE of the review-queue surface.
const adminLedgerPage = read("src/app/(admin)/transactions/deposits/page.tsx");

test("Deposits is an active-only Antifraud Fiat credit review queue", () => {
  assert.match(page, /listFiatAssessments/);
  assert.match(
    page,
    /listFiatAssessments\(\{[\s\S]{0,160}status: "review"/,
  );
  assert.doesNotMatch(page, /verdict: "review"/);
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
  // with `verdict='review'` forever, so an all-pages loop grows without limit.
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
  // The Admin sidebar keeps its Transactions ledger entry — moving the Fiat
  // credit queue into Fraud must not take the money-flow surface with it.
  // What the ledger must NOT contain is any part of the review queue.
  assert.match(nav, /id: "nav\.deposits"/);
  assert.match(nav, /href: "\/transactions\/deposits"/);
  assert.match(adminLedgerPage, /getDepositTransactions/);
  assert.match(adminLedgerPage, /getCardPayments/);
  assert.match(adminLedgerPage, /getWithdrawals/);
  assert.doesNotMatch(adminLedgerPage, /listFiatAssessments/);
  assert.doesNotMatch(adminLedgerPage, /getFiatCreditReviewStates/);
  assert.doesNotMatch(adminLedgerPage, /GlobalFiatReviewCard/);
  assert.doesNotMatch(adminLedgerPage, /FiatDepositReviewDecision/);
  assert.doesNotMatch(adminLedgerPage, /getFiatDepositAutomaticCreditConfig/);
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

test("simultaneous approvals cannot credit the same payment twice", () => {
  assert.match(actions, /pg_advisory_xact_lock/);
  assert.match(actions, /fiat-credit-review:\$\{snapshot\.depositIntentId\}/);
  assert.match(actions, /Another staff member already decided this deposit/);
  assert.match(workflow, /FROM fiat_deposit_intents[\s\S]*?FOR UPDATE/);
  assert.match(
    workflow,
    /WHERE external_tx_id = \$\{input\.providerPaymentId\}[\s\S]*?FOR UPDATE/,
  );
  assert.match(workflow, /existingLedger\?\.status === "completed"/);
  assert.match(
    mainSchema,
    /unique\("ledger_transactions_external_tx_id_unique"\)/,
  );
});

test("staff decisions require Fraud access, 2FA, decline reason, idempotency, and audit", () => {
  assert.match(actions, /requireAntifraudAccess\(\)/);
  assert.match(actions, /require2FA\(session\.userId, parsed\.data\.stepUpCredential\)/);
  assert.match(actions, /decision: z\.literal\("approve"\)/);
  assert.match(actions, /value\.length === 0 \|\| value\.length >= 3/);
  assert.match(actions, /decision: z\.literal\("decline"\)/);
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
  assert.match(controls, /decision === "decline" && \(/);
  assert.match(controls, /decision === "decline" && reason\.trim\(\)\.length < 3/);
  assert.match(controls, /Future Fiat deposits will still require their own review/);
  assert.doesNotMatch(controls, /Reject and refund|Retry refund/);
  assert.match(controls, /StepUpField/);
});

test("staff see the score, triggers, evidence gaps, and global cluster context before deciding", () => {
  assert.match(page, /<FiatReviewEvidence[\s\S]*?assessment=\{item\.assessment\}/);
  assert.match(evidence, /Risk \{assessment\.risk_score\}\/100/);
  assert.match(evidence, /assessment\.recommendation/);
  assert.doesNotMatch(evidence, /assessment\.summary/);
  assert.doesNotMatch(evidence, /post-deposit behavior are consistent/);
  assert.doesNotMatch(evidence, /No positive score driver returned/);
  assert.match(evidence, /Current safeguards/);
  assert.match(evidence, /Fiat deposits locked/);
  assert.match(evidence, /Withdrawals locked/);
  assert.match(reviewUsers, /LEFT JOIN user_feature_locks/);
  assert.match(reviewUsers, /locked_deposits_fiat/);
  assert.match(reviewUsers, /locked_withdrawals_crypto/);
  assert.match(reviewUsers, /FROM fingerprints fp/);
  assert.match(reviewUsers, /ORDER BY fp\.created_at DESC, fp\.id DESC/);
  assert.match(page, /label="Fingerprint"/);
  assert.match(page, /checkoutFingerprint/);
  assert.match(page, /latestFingerprint/);
  assert.match(evidence, /Every scored trigger/);
  assert.match(evidence, /Evidence incomplete/);
  assert.match(evidence, /payment identity history/);
  assert.match(evidence, /exactAmountDistinctUsers30m/);
  assert.match(evidence, /Identity and platform-wide clusters/);
  assert.match(evidence, /Approve credits only this payment/);
  assert.match(evidence, /Decline does not refund it/);
});

test("review amounts remain fully visible in the compact aligned header", () => {
  const amountFact = page.slice(
    page.indexOf("function AmountFact"),
    page.indexOf("function ComparisonFact"),
  );

  assert.match(amountFact, /h-12/);
  assert.match(amountFact, /whitespace-nowrap/);
  assert.doesNotMatch(amountFact, /truncate/);
  assert.doesNotMatch(page, /label="Customer paid"/);
  assert.match(page, /label="Balance credit"/);
  assert.match(page, /w-40 shrink-0/);
  assert.doesNotMatch(page, /min-w-40 flex-1/);
  assert.match(page, /h-12 w-12 shrink-0/);
  assert.match(page, /xl:items-start/);
  assert.match(page, /aria-label={`\$\{label\} matches`}/);
  assert.match(page, /aria-label={`\$\{label\} does not match`}/);
  assert.match(page, /matches === false && index === 0/);
  assert.match(page, /text-red-600 dark:text-red-400/);
  assert.match(page, /Open \$\{displayName\}'s profile in a new tab/);
  assert.match(page, /target="_blank"/);
  assert.match(page, /noopener noreferrer/);
  assert.match(controls, /h-12 w-28/);
  assert.match(read("src/app/(antifraud)/antifraud/fiat-deposits/require-kyc-action.tsx"), /h-12 w-28/);
});

test("future auto credit is offered only for mature clean Fiat history", () => {
  const now = Date.UTC(2026, 7, 12);
  const eligible = {
    fiatAutoApprovalEnabled: false,
    cleanFiatDeposits: 3,
    reversedFiatDeposits: 0,
    firstCleanFiatAt: new Date(now - 14 * 24 * 60 * 60 * 1_000).toISOString(),
    accountClean: true,
    fiatDepositsLocked: false,
    withdrawalsLocked: false,
  };

  assert.equal(isFiatAutoCreditEligible(eligible, now), true);
  assert.equal(isFiatAutoCreditEligible({ ...eligible, cleanFiatDeposits: 2 }, now), false);
  assert.equal(isFiatAutoCreditEligible({ ...eligible, reversedFiatDeposits: 1 }, now), false);
  assert.equal(isFiatAutoCreditEligible({
    ...eligible,
    firstCleanFiatAt: new Date(now - 13 * 24 * 60 * 60 * 1_000).toISOString(),
  }, now), false);
  assert.equal(isFiatAutoCreditEligible({ ...eligible, accountClean: false }, now), false);
  assert.equal(isFiatAutoCreditEligible({ ...eligible, fiatDepositsLocked: true }, now), false);
  assert.equal(isFiatAutoCreditEligible({ ...eligible, withdrawalsLocked: true }, now), false);
  assert.equal(isFiatAutoCreditEligible({ ...eligible, fiatAutoApprovalEnabled: true }, now), false);
  assert.match(page, /AllowFiatAutoCreditAction/);
  assert.match(page, /assessment\.verdict === "good"/);
  assert.match(page, /assessment\.risk_score < 50/);
  assert.match(autoCreditControl, /Allow future auto credit/);
  assert.match(autoCreditControl, /h-12 w-28/);
  assert.match(autoCreditControl, /does not approve the current deposit/);
  assert.match(autoCreditActions, /requireAntifraudManager/);
  assert.match(autoCreditActions, /require2FA/);
  assert.match(autoCreditActions, /updateUserFiatDepositAutoApproval/);
  assert.match(autoCreditActions, /user_fiat_auto_approval_updated/);
  assert.match(autoCreditActions, /isFiatAutoCreditEligible/);
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

test("retired Admin deposit-review deep links redirect to the Fraud webapp", () => {
  assert.match(middleware, /pathname === "\/transactions\/deposits"/);
  assert.match(middleware, /"fiat-deposits"/);
  assert.match(middleware, /entry\.basePath === "\/antifraud"/);
  assert.match(middleware, /NextResponse\.redirect\(url, 308\)/);
  // …but ONLY for the retired tab selectors. A redirect keyed on the
  // pathname alone removed the whole Transactions ledger from the
  // dashboard; the null branch is what keeps the bare route renderable.
  assert.match(middleware, /fraudTransactionsRoute !== null/);
  assert.match(middleware, /: null;/);
});

test("the bare Transactions route is not redirected away from Admin", async () => {
  process.env.SESSION_SECRET ??=
    "admin-transactions-ledger-regression-only-secret-32";
  const [{ NextRequest }, { encrypt }, { middleware: run }] = await Promise.all([
    import("next/server"),
    import("../../src/lib/session"),
    import("../../src/middleware"),
  ]);
  const token = await encrypt({
    userId: "ledger-regression",
    role: "admin",
    roles: ["admin"],
    email: "ledger-regression@packy.gg",
    username: "ledger-regression",
    isOwner: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const requestFor = (url: string) =>
    new NextRequest(url, {
      headers: { cookie: `admin_session=${token}`, host: "packydash.com" },
    });

  for (const url of [
    "https://packydash.com/transactions/deposits",
    "https://packydash.com/transactions/deposits?tab=withdrawals",
    "https://packydash.com/transactions/deposits?tab=card-payments",
  ]) {
    const response = await run(requestFor(url));
    assert.notEqual(
      response.status,
      308,
      `${url} must render the Admin ledger, not redirect to Fraud`,
    );
    assert.equal(response.headers.get("location"), null);
  }

  // The retired review deep link still forwards, query state intact.
  const retired = await run(
    requestFor("https://packydash.com/transactions/deposits?tab=reviews&page=3"),
  );
  assert.equal(retired.status, 308);
  assert.equal(
    retired.headers.get("location"),
    "https://fraud.packydash.com/fiat-deposits?page=3",
  );
});
