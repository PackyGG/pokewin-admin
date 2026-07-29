import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(
  new URL(
    "../../src/app/(admin)/transactions/deposits/refund-actions.ts",
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
