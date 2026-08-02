import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  maxMindRiskPoints,
  verifyMaxMindAlertSignature,
} from "../src/maxmind.js";

test("MaxMind Factors risk is trusted once without treating it as a hard ban", () => {
  assert.equal(maxMindRiskPoints(2), -5);
  assert.equal(maxMindRiskPoints(24.99), 0);
  assert.equal(maxMindRiskPoints(50), 25);
  assert.equal(maxMindRiskPoints(75), 40);
  assert.equal(maxMindRiskPoints(90), 55);
});

test("MaxMind alert signatures bind the untouched query string", () => {
  const secret = "alert-secret-at-least-32-characters";
  const raw = "minfraud_id=11111111-1111-1111-1111-111111111111&new_risk_score=80";
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(verifyMaxMindAlertSignature(secret, raw, signature), true);
  assert.equal(
    verifyMaxMindAlertSignature(secret, `${raw}&reason=changed`, signature),
    false,
  );
});
