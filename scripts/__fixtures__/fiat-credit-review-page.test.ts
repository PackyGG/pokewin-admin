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
const api = read("src/lib/backend-api/fiat-deposit-review.ts");
const middleware = read("src/middleware.ts");
const withdrawals = read("src/app/(admin)/withdrawals/page.tsx");
const nav = read("src/lib/nav-config.ts");
const sidebar = read(
  "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
);
const legacyPage = read("src/app/(admin)/transactions/deposits/page.tsx");

test("Deposits is a Fiat-only credit review queue", () => {
  assert.match(page, /title="Fiat Deposit Reviews"/);
  assert.match(page, /getFiatDepositReviewQueue/);
  assert.match(page, /GlobalFiatReviewCard/);
  assert.match(page, /Crypto deposits are not included/);
  assert.doesNotMatch(page, /getDepositTransactions/);
  assert.doesNotMatch(page, /BigDepositsToggle/);
  assert.doesNotMatch(page, /getWithdrawals/);
  assert.doesNotMatch(page, /tab ===/);
  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(sidebar, /label: "Deposit reviews"/);
  assert.doesNotMatch(nav, /id: "nav\.deposits"/);
  assert.match(legacyPage, /redirect\("\/antifraud\/fiat-deposits"\)/);
  assert.match(page, /fiat-deposits\/\$\{encodeURIComponent\(item\.id\)\}/);
});

test("review API mirrors the authoritative backend contract", () => {
  for (const status of [
    "review",
    "approval_processing",
    "refund_pending",
    "refund_failed",
  ]) {
    assert.match(api, new RegExp(`"${status}"`));
  }
  assert.match(api, /getFiatDepositReviewQueue/);
  assert.match(api, /\/admin\/fiat-deposits"/);
  assert.match(api, /\/admin\/fiat-deposits\/\$\{encodeURIComponent\(input\.intentId\)\}\/decision/);
  assert.match(api, /decision: "approve" \| "reject"/);
  assert.match(api, /"x-admin-user-id": input\.adminUserId/);
  assert.match(api, /safeParse\(response\)/);
});

test("money-moving decisions are admin, 2FA, reason, and audit protected", () => {
  assert.match(actions, /requireAntifraudManager\(/);
  assert.match(actions, /require2FA\(session\.userId, parsed\.data\.stepUpCredential\)/);
  assert.match(actions, /reason: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(500\)/);
  assert.match(actions, /createAdminAuditEvent/);
  assert.match(actions, /fiat_deposit_credit_approved/);
  assert.match(actions, /fiat_deposit_credit_rejected/);
  assert.match(actions, /revalidatePath\("\/antifraud\/fiat-deposits"\)/);
  assert.match(controls, /Approve balance credit/);
  assert.match(controls, /Reject and refund/);
  assert.match(controls, /StepUpField/);
  assert.match(controls, /status === "refund_failed"/);
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
