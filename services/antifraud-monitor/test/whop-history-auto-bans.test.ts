import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { whopHistoryEvidence } from "../src/whop-history-auto-bans.js";

function payment(signals: Array<{ key: string; value: unknown }>) {
  return {
    data: {
      id: "pay_SXNDaNAMpP09y3",
      status: "open",
      substatus: "failed",
      risk_score: 69,
      decline_code: "three_d_secure_failed",
      three_ds_verified: false,
      metadata: {
        internal_user_id: "H2jcpXT4v4PuxDfSfe6qVQUZ4DEXFMYP",
        deposit_intent_id: "63f11d7b-5337-4de7-98b4-497eec6359a8",
      },
      risk_signals: { signals },
    },
  };
}

test("Whop prior dispute/refund history becomes an automatic-ban command", () => {
  const evidence = whopHistoryEvidence(
    payment([
      { key: "prior_dispute_count", value: 1 },
      { key: "prior_refund_count", value: 1 },
      { key: "prior_fraud_declines", value: 3 },
      { key: "user_high_risk_sessions", value: 15 },
    ]),
    "pay_SXNDaNAMpP09y3",
  );

  assert.deepEqual(evidence, {
    paymentId: "pay_SXNDaNAMpP09y3",
    depositIntentId: "63f11d7b-5337-4de7-98b4-497eec6359a8",
    priorDisputeCount: 1,
    priorRefundCount: 1,
    priorFraudDeclines: 3,
    highRiskSessions: 15,
    providerRiskScore: 69,
    paymentStatus: "failed",
    declineCode: "three_d_secure_failed",
    threeDsVerified: false,
  });
});

test("either a prior dispute or prior refund is sufficient", () => {
  assert.equal(
    whopHistoryEvidence(
      payment([{ key: "prior_dispute_count", value: 1 }]),
      null,
    )?.priorDisputeCount,
    1,
  );
  assert.equal(
    whopHistoryEvidence(
      payment([{ key: "prior_refund_count", value: "2" }]),
      null,
    )?.priorRefundCount,
    2,
  );
});

test("ordinary payments and malformed Packy bindings fail closed", () => {
  assert.equal(
    whopHistoryEvidence(
      payment([
        { key: "prior_dispute_count", value: 0 },
        { key: "prior_refund_count", value: 0 },
      ]),
      null,
    ),
    null,
  );
  const malformed = payment([{ key: "prior_dispute_count", value: 1 }]);
  malformed.data.metadata.deposit_intent_id = "not-an-intent";
  assert.equal(whopHistoryEvidence(malformed, null), null);
});

test("current-payment dispute arrays do not impersonate prior buyer history", () => {
  const payload = payment([]) as Record<string, unknown> & {
    data: Record<string, unknown>;
  };
  payload.data.disputes = [{ id: "dp_current" }];
  payload.data.refunds = [{ id: "rf_current" }];
  assert.equal(whopHistoryEvidence(payload, null), null);
});

test("automatic bans jump ahead of historical containment delivery backlog", () => {
  const delivery = readFileSync(
    new URL("../src/ingest-delivery.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    delivery,
    /CASE WHEN re\.event_type = 'whop_history_auto_ban' THEN 0 ELSE 1 END/,
  );
});
