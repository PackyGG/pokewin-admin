import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseWhopEvidence,
  scoreFiatDeposit,
  type FiatScoreInput,
} from "../src/fiat-risk.js";

const safeInput: FiatScoreInput = {
  status: "completed",
  amountUsd: 100,
  provider: {
    eventType: "payment.succeeded",
    eventReceivedAt: "2026-07-28T12:00:00.000Z",
    threeDsVerified: true,
    riskScore: 10,
    riskSignals: [],
    disputeCount: 0,
    refundCount: 0,
    autoRefunded: false,
    billingCountry: "DE",
    paymentMethodType: "card",
  },
  funding: {
    priorCryptoDeposits: 3,
    priorCryptoUsd: 250,
    priorFiatDeposits: 1,
    priorFiatUsd: 50,
    priorDepositAverageUsd: 75,
    currentVsAverageRatio: 1.33,
  },
  behavior: {
    observedHours: 72,
    gameWagerUsd: 120,
    gamePayoutUsd: 40,
    rewardsUsd: 0,
    gameEvents: 8,
    withdrawalRequests: 0,
    withdrawalUsd: 0,
    minutesToFirstWithdrawal: null,
    playthroughRatio: 1.2,
  },
  account: {
    accountAgeDays: 180,
    countryCode: "DE",
    kycRequired: true,
    kycStatus: "approved",
    kycAdminDecision: "approved",
    isBanned: false,
    isLocked: false,
    isSuspectedAlt: false,
    sharedDeviceUsers: 0,
    sharedSignupIpUsers: 0,
    fiatAttempts1h: 1,
    fiatAttempts24h: 1,
    failedFiatAttempts24h: 0,
    priorDisputedFiat: 0,
    priorRefundedFiat: 0,
  },
};

test("known crypto funding and verified 3DS produce a good assessment", () => {
  const result = scoreFiatDeposit(safeInput);
  assert.equal(result.riskScore, 0);
  assert.equal(result.verdict, "good");
  assert.ok(result.signals.some((signal) => signal.key === "known_crypto_history"));
  assert.ok(result.signals.some((signal) => signal.key === "three_ds_verified"));
  assert.ok(result.flowChecks.every((check) => check.status === "pass"));
});

test("a dispute independently makes the payment high risk", () => {
  const result = scoreFiatDeposit({
    ...safeInput,
    status: "disputed",
    provider: { ...safeInput.provider, disputeCount: 1 },
  });
  assert.equal(result.verdict, "bad");
  assert.ok(result.riskScore >= 70);
  assert.equal(
    result.flowChecks.find((check) => check.key === "provider")?.status,
    "block",
  );
});

test("rapid low-play cash-out is visible in behavior risk", () => {
  const result = scoreFiatDeposit({
    ...safeInput,
    behavior: {
      ...safeInput.behavior,
      gameWagerUsd: 2,
      withdrawalRequests: 1,
      withdrawalUsd: 100,
      minutesToFirstWithdrawal: 12,
      playthroughRatio: 0.02,
    },
  });
  assert.equal(result.signals.some((signal) => signal.key === "rapid_fiat_cashout"), true);
  assert.equal(result.scoreBreakdown.behavior, 45);
  assert.equal(result.verdict, "review");
});

test("shared devices make the assessment high risk", () => {
  const result = scoreFiatDeposit({
    ...safeInput,
    account: { ...safeInput.account, sharedDeviceUsers: 2 },
  });
  assert.equal(result.verdict, "bad");
  assert.equal(result.scoreBreakdown.network, 65);
});

test("Whop parsing allowlists risk evidence and strips payment identity", () => {
  const result = parseWhopEvidence(
    {
      data: {
        risk_score: 71,
        three_ds_verified: true,
        phone: "+1-secret",
        card: { last4: "1234" },
        billing_address: { country: "US", line_1: "secret street" },
        risk_signals: {
          signals: [
            { key: "prior_dispute_count", label: "Prior disputes", value: 2 },
            { key: "card_last4", label: "Card", value: "1234" },
          ],
        },
      },
    },
    "payment.succeeded",
    "2026-07-28T12:00:00.000Z",
  );
  assert.equal(result.riskScore, 71);
  assert.equal(result.billingCountry, "US");
  assert.deepEqual(result.riskSignals.map((signal) => signal.key), [
    "prior_dispute_count",
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("1234"), false);
});

test("assessment refresh excludes creators and protected users", async () => {
  const source = await readFile(
    new URL("../src/fiat-risk.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /COALESCE\(u\.role::text,''\)<>'creator'/);
  assert.match(source, /'creator'<>ALL\(COALESCE\(u\.roles::text\[\]/);
  assert.match(source, /fdi\.user_id<>ALL\(\$\$\{values\.length\}::text\[\]\)/);
  assert.match(source, /prior_crypto_deposits/);
  assert.match(source, /payment_webhook_events/);
});
