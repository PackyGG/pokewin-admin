import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyBlacklistedCheckoutEmail,
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
    checkoutEmail: "checkout@example.com",
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
  assert.equal(
    result.signals.find((signal) => signal.key === "known_crypto_history")
      ?.points,
    -20,
  );
  assert.ok(result.signals.some((signal) => signal.key === "three_ds_verified"));
  assert.ok(result.flowChecks.every((check) => check.status === "pass"));
});

test("established accounts with meaningful prior crypto funding receive lower fiat risk", () => {
  const established = scoreFiatDeposit({
    ...safeInput,
    provider: { ...safeInput.provider, riskScore: 60 },
  });
  const recent = scoreFiatDeposit({
    ...safeInput,
    provider: { ...safeInput.provider, riskScore: 60 },
    account: { ...safeInput.account, accountAgeDays: 14 },
  });
  const cryptoDust = scoreFiatDeposit({
    ...safeInput,
    provider: { ...safeInput.provider, riskScore: 60 },
    funding: {
      ...safeInput.funding,
      priorCryptoDeposits: 1,
      priorCryptoUsd: 1,
    },
  });

  assert.equal(established.riskScore, 0);
  assert.equal(recent.riskScore, 20);
  assert.equal(cryptoDust.riskScore, 20);
});

test("blocked checkout email is an unconditional critical lock", () => {
  const scored = scoreFiatDeposit(safeInput);
  const blocked = applyBlacklistedCheckoutEmail(scored, {
    deposit_intent_id: "deposit-1",
    checkout_email: "buyer@blocked.example",
    domain: "blocked.example",
    match_type: "blacklisted_domain",
    lock_delivered_at: new Date("2026-07-29T12:00:00.000Z"),
  });

  assert.equal(blocked.riskScore, 100);
  assert.equal(blocked.verdict, "bad");
  assert.equal(blocked.scoreBreakdown.provider, 100);
  assert.equal(
    blocked.signals[0]?.key,
    "blacklisted_checkout_email_domain",
  );
  assert.match(blocked.recommendation, /withdrawals locked/);
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
        user: { email: "buyer@checkout.example" },
        risk_score: 71,
        three_ds_verified: true,
        phone: "+1-secret",
        card: { last4: "1234" },
        payment: { payment_method_type: "Apple Pay" },
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
  assert.equal(result.checkoutEmail, "buyer@checkout.example");
  assert.equal(result.billingCountry, "US");
  assert.equal(result.paymentMethodType, "apple_pay");
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

test("paid webhook failures remain visible until MAIN reconciliation succeeds", () => {
  const result = scoreFiatDeposit({
    ...safeInput,
    status: "paid_unreconciled",
  });
  assert.equal(result.verdict, "review");
  assert.equal(
    result.signals.some(
      (signal) => signal.key === "payment_reconciliation_failed",
    ),
    true,
  );
  assert.match(result.recommendation, /Reconcile the successful Whop payment/);
});

test("assessment refresh loads settled and paid-unreconciled fiat", async () => {
  const source = await readFile(
    new URL("../src/fiat-risk.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /FIAT_ASSESSMENT_STATUSES/);
  assert.match(source, /"completed"/);
  assert.match(source, /"partially_refunded"/);
  assert.match(source, /"refunded"/);
  assert.match(source, /"disputed"/);
  assert.match(source, /"paid_unreconciled"/);
  assert.match(source, /event_type='payment\.succeeded'/);
  assert.match(source, /processing_status='failed'/);
  assert.match(
    source,
    /payload#>>'\{data,metadata,deposit_intent_id\}'/,
  );
  assert.doesNotMatch(
    source,
    /FIAT_ASSESSMENT_STATUSES[\s\S]{0,200}"checkout_ready"/,
  );
});
