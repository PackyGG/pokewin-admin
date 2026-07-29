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
  new URL("../../src/app/(antifraud)/antifraud/refunds/page.tsx", import.meta.url),
  "utf8",
);
const refundsPanel = readFileSync(
  new URL(
    "../../src/app/(antifraud)/antifraud/refunds/refunds-panel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const transactionsPage = readFileSync(
  new URL("../../src/app/(admin)/transactions/deposits/page.tsx", import.meta.url),
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
  assert.match(sidebar, /isOwner\s*\?\s*\[\.\.\.TRANSACTION_NAV, OWNER_TRANSACTION_NAV\]/);
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

test("the database prevents one Whop payment entering two refund batches", () => {
  assert.match(
    migration,
    /UNIQUE \(provider_payment_id\)/,
  );
  assert.match(actions, /ON CONFLICT \(provider_payment_id\) DO NOTHING/);
});

test("refund scope is limited to current fraud flags and paid deposit states", () => {
  assert.match(queries, /antifraud_reviews\.status, "flagged"/);
  assert.match(queries, /kyc_required = true/);
  assert.match(queries, /system:antifraud-/);
  assert.match(queries, /i\.status IN \('completed', 'partially_refunded'\)/);
});
