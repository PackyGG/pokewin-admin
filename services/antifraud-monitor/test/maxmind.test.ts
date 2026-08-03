import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  MaxMindService,
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

test("MaxMind requests omit an unknown payment processor", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "11111111-1111-1111-1111-111111111111",
      risk_score: 1,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const pool = {
    query: async () => ({ rows: [] }),
  };
  try {
    const service = new MaxMindService({
      MAXMIND_ACCOUNT_ID: "1386436",
      MAXMIND_LICENSE_KEY: "test-license-key-long-enough",
    } as never, pool as never);
    const result = await service.evaluate({
      eventKey: "test:fiat:1",
      transactionId: "test:fiat:1",
      eventType: "purchase",
      userId: "user-1",
      occurredAt: new Date(),
      shopId: "test:packy",
      paymentMethod: "card",
      paymentWasAuthorized: true,
    });
    assert.equal(result.status, "success");
    assert.deepEqual(requestBody?.payment, {
      method: "card",
      was_authorized: true,
    });
    assert.equal("processor" in (requestBody?.payment as object), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
