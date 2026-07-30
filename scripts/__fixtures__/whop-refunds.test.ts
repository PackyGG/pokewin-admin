import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/refunds/refund-actions.ts",
    import.meta.url,
  ),
  "utf8",
);
const client = readFileSync(
  new URL("../../src/lib/whop-admin.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../drizzle/admin/migrations/20260729_whop_refund_operations.sql",
    import.meta.url,
  ),
  "utf8",
);
const queries = readFileSync(
  new URL("../../src/lib/queries/whop-refunds.ts", import.meta.url),
  "utf8",
);
const refundPage = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/refunds/page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const refundsPanel = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/refunds/refunds-panel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const fiatDetail = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/fiat-deposits/[id]/page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const fiatList = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/fiat-deposits/page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const fiatApi = readFileSync(
  new URL(
    "../../src/lib/antifraud/fiat-deposits-api.ts",
    import.meta.url,
  ),
  "utf8",
);
const transactionsPage = readFileSync(
  new URL(
    "../../src/app/(admin)/transactions/deposits/page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const sidebar = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
    import.meta.url,
  ),
  "utf8",
);
const appHosts = readFileSync(
  new URL("../../src/lib/app-hosts.ts", import.meta.url),
  "utf8",
);
const middleware = readFileSync(
  new URL("../../src/middleware.ts", import.meta.url),
  "utf8",
);

test("Whop refunds live only in the owner-only Fraud workspace", () => {
  assert.match(refundPage, /await requireOwner\(\)/);
  assert.match(refundsPanel, /Whop refunds for currently flagged accounts/);
  assert.match(sidebar, /label: "Whop Refunds"/);
  assert.match(
    sidebar,
    /isOwner\s*\?\s*\[\.\.\.TRANSACTION_NAV, OWNER_TRANSACTION_NAV\]/,
  );
  assert.match(appHosts, /"refunds"/);
  assert.doesNotMatch(transactionsPage, /RefundsPanel|value: "refunds"/);
  assert.match(
    middleware,
    /retiredTransactionsTab === "refunds"[\s\S]*\? "refunds"/,
  );
  assert.match(actions, /revalidatePath\("\/antifraud\/refunds"\)/);
  assert.doesNotMatch(actions, /revalidatePath\("\/transactions\/deposits"\)/);
});

test("refund batches require owner access and fresh step-up before expansion", () => {
  const owner = actions.indexOf("await requireOwner()");
  const stepUp = actions.indexOf("await require2FA");
  const expansion = actions.indexOf("await resolveRefundSelection");
  assert.ok(owner >= 0);
  assert.ok(stepUp > owner);
  assert.ok(expansion > stepUp);
});

test("refund confirmation needs only owner step-up", () => {
  assert.doesNotMatch(
    refundsPanel,
    /refund-reason|refund-confirmation|Type REFUND/,
  );
  assert.doesNotMatch(refundsPanel, /Textarea|@\/components\/ui\/input/);
  assert.match(refundsPanel, /disabled=\{working \|\| !credential\}/);
  assert.match(actions, /REFUND_BATCH_AUDIT_REASON/);
  assert.doesNotMatch(actions, /reason:\s*string/);
});

test("Whop mutations disable SDK retries and retrieve before refunding", () => {
  assert.match(client, /maxRetries:\s*0/);
  const retrieve = actions.indexOf("client.payments.retrieve");
  const refund = actions.indexOf("client.payments.refund");
  assert.ok(retrieve >= 0);
  assert.ok(refund > retrieve);
  assert.match(
    actions,
    /safe\.outcomeUnknown \|\| refundRequested \? "unknown" : "failed"/,
  );
});

test("successful refund batches ban accounts and recover only attributable value", () => {
  assert.match(
    actions,
    /await recoverRefundedAccountsForBatch\(\s*batchId,\s*adminUserId,\s*\)/,
  );
  assert.match(actions, /is_banned = TRUE/);
  assert.match(actions, /DELETE FROM session/);
  assert.match(
    actions,
    /remainingCents = Math\.max\(0, refundedCreditCents - priorRecoveredCents\)/,
  );
  assert.match(actions, /metadata->>'kind' = 'whop_refund_recovery'/);
  assert.match(actions, /adjustment_category: "fraud_abuse"/);
  assert.match(actions, /adjustment_category: "remove_locked_balance"/);
  assert.match(actions, /initiated_by_admin_user_id: adminUserId/);
  assert.doesNotMatch(actions, /sender_user_id|recipient_user_id/);
});

test("account recovery is atomic per user and continues after a failure", () => {
  assert.match(actions, /for \(const target of targets\) \{[\s\S]*?try \{/);
  assert.match(actions, /failedUserIds\.push\(target\.userId\)/);
  assert.match(actions, /failedAccounts: failedUserIds\.length/);
  assert.match(actions, /complete: failedUserIds\.length === 0/);
  assert.match(actions, /RETURNING user_id::text/);
  assert.match(actions, /deletedVouchers\.length !== voucherIds\.length/);
  assert.match(actions, /updatedInventory\.length !== inventoryIds\.length/);
  assert.match(refundsPanel, /run this again to retry/);
  assert.match(actions, /recoveryFailedAccounts: recovery\.failedAccounts/);
  assert.match(refundsPanel, /account recoveries need a retry/);
});

test("completed-batch recovery is owner-only, step-up gated, and visible", () => {
  const recovery = actions.indexOf(
    "export async function recoverRefundedBatch",
  );
  const owner = actions.indexOf("await requireOwner()", recovery);
  const stepUp = actions.indexOf("await require2FA", recovery);
  assert.ok(recovery >= 0);
  assert.ok(owner > recovery);
  assert.ok(stepUp > owner);
  assert.match(actions, /export async function recoverAllRefundedAccounts/);
  assert.match(actions, /await loadAllRefundRecoveryTargets\(\)/);
  assert.match(refundsPanel, /Ban &amp; recover all successful refunds/);
  assert.match(refundsPanel, /id="refund-recovery-2fa"/);
});

test("the database prevents one Whop payment entering two refund batches", () => {
  assert.match(migration, /UNIQUE \(provider_payment_id\)/);
  assert.match(actions, /ON CONFLICT \(provider_payment_id\) DO NOTHING/);
});

test("refund scope includes every current KYC requirement and paid deposit state", () => {
  assert.match(queries, /antifraud_reviews\.status, "flagged"/);
  assert.match(queries, /kyc_required = true/);
  assert.doesNotMatch(
    queries,
    /system:antifraud-|kyc_required_reason[\s\S]*~\*/,
  );
  assert.match(queries, /i\.status IN \('completed', 'partially_refunded'\)/);
});

test("paid-but-uncredited Whop payments use the successful payment ID for refunds", () => {
  assert.match(queries, /WITH paid_unreconciled AS/);
  assert.match(queries, /event_type = 'payment\.succeeded'/);
  assert.match(queries, /processing_status = 'failed'/);
  assert.match(
    queries,
    /provider_resource_id AS provider_payment_id/,
  );
  assert.match(queries, /'paid_unreconciled'::text AS status/);
  assert.match(
    queries,
    /i\.status NOT IN \([\s\S]*'completed',[\s\S]*'refunded',[\s\S]*'disputed'/,
  );
  assert.match(refundsPanel, /paid · balance credit failed/);
  assert.match(refundsPanel, /no completed ledger[\s\S]*successful Whop/);
});

test("the Fiat review links owners into the exact guarded refund", () => {
  assert.match(fiatApi, /provider_payment_id: z\.string\(\)\.nullable\(\)/);
  assert.match(fiatDetail, /canRefund=\{isOwner\(session\)\}/);
  assert.match(fiatDetail, /unreconciled[\s\S]*item\.provider_payment_id/);
  assert.match(
    fiatDetail,
    /\/antifraud\/refunds\?payment=\$\{encodeURIComponent\(item\.provider_payment_id\)\}/,
  );
  assert.match(refundPage, /\^pay_\[A-Za-z0-9\]\+\$/);
  assert.match(refundsPanel, /requestedPaymentAvailable[\s\S]*mode: "payments"/);
  assert.match(
    fiatList,
    /isOwner\(session\)[\s\S]*\/antifraud\/refunds\?scope=paid_unreconciled/,
  );
  assert.match(refundPage, /params\.scope === "paid_unreconciled"/);
  assert.match(
    refundPage,
    /candidate\.status === "paid_unreconciled"/,
  );
  assert.match(
    refundsPanel,
    /reconciliationOnly[\s\S]*mode: "payments"[\s\S]*providerPaymentId/,
  );
  assert.match(refundsPanel, /Refund all reconciliation failures/);
});

test("Fiat review surfaces retain the durable refund outcome", () => {
  assert.match(queries, /export async function getWhopRefundStates/);
  assert.match(queries, /FROM admin_whop_refund_items/);
  assert.match(fiatList, /getWhopRefundStates/);
  assert.match(fiatList, /Refund queued/);
  assert.match(fiatList, /Refund needs review/);
  assert.match(fiatDetail, /getWhopRefundStates/);
  assert.match(fiatDetail, /Refunded/);
});

test("refund candidates expose the account location and KYC state", () => {
  assert.match(queries, /u\.country,/);
  assert.match(queries, /u\.country_code,/);
  assert.match(queries, /u\.state,/);
  assert.match(queries, /u\.city,/);
  assert.match(refundsPanel, /KYC required/);
  assert.match(refundsPanel, /accountLocation\(first\)/);
});
