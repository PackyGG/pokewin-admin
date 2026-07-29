import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCreatorRisk,
  crossedRiskBand,
  serializeCreatorRisks,
} from "../src/free-battle-risk.js";

const creator = {
  creator_kyc_required: false,
  creator_kyc_status: "none",
  creator_kyc_admin_decision: "pending",
  creator_kyc_reason: null,
  creator_is_suspected_alt: false,
};

test("ordinary compliance KYC does not mark a battle creator as fraudulent", () => {
  assert.equal(
    classifyCreatorRisk({
      ...creator,
      creator_kyc_required: true,
      creator_kyc_reason:
        "Lifetime fiat deposits reached $100.00 (current: $100.00)",
    }),
    null,
  );
});

test("fraud KYC, rejected KYC, alt flags, and active Antifraud scores are detected", () => {
  assert.deepEqual(
    classifyCreatorRisk({
      ...creator,
      creator_kyc_required: true,
      creator_kyc_reason:
        "Fiat deposit risk review: 87e65d49-1c35-4e57-a49a-c91402e245e2",
    }),
    {
      kind: "fraud_kyc_required",
      detail:
        "Fiat deposit risk review: 87e65d49-1c35-4e57-a49a-c91402e245e2",
      points: 40,
    },
  );
  assert.equal(
    classifyCreatorRisk({
      ...creator,
      creator_kyc_status: "rejected",
    })?.points,
    80,
  );
  assert.equal(
    classifyCreatorRisk({
      ...creator,
      creator_is_suspected_alt: true,
    })?.kind,
    "suspected_alt",
  );
  assert.equal(
    classifyCreatorRisk(creator, 60)?.kind,
    "antifraud_flagged",
  );
});

test("risk events emit only when evidence crosses a review band", () => {
  assert.equal(crossedRiskBand(0, 40), 40);
  assert.equal(crossedRiskBand(0, 80), 80);
  assert.equal(crossedRiskBand(40, 80), 80);
  assert.equal(crossedRiskBand(80, 120), 120);
  assert.equal(crossedRiskBand(120, 120), null);
});

test("creator cursor input is serialized as JSON for the jsonb recordset", () => {
  const serialized = serializeCreatorRisks(new Map([
    ["creator-1", {
      kind: "fraud_kyc_required",
      detail: "scammer",
      points: 40,
    }],
  ]));
  assert.equal(typeof serialized, "string");
  assert.deepEqual(JSON.parse(serialized), [{
    creator_user_id: "creator-1",
    creator_risk_kind: "fraud_kyc_required",
    creator_risk_detail: "scammer",
    risk_points: 40,
  }]);
});
