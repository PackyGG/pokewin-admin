import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyBlacklistedCheckoutEmail,
  applyMaxMindFiatRisk,
  FiatRiskService,
  likeContains,
  parseWhopEvidence,
  scoreFiatDeposit,
  type FiatScoreInput,
} from "../src/fiat-risk.js";
import type { Databases } from "../src/db.js";
import type { MaxMindEvaluation } from "../src/maxmind.js";

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

test("fiat refresh searches the Whop checkout email through indexed resources", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const source = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
  const service = new FiatRiskService({
    source,
    antifraud: {},
  } as unknown as Databases);

  const result = await service.refresh({ search: "Buyer@Example.com" });

  assert.deepEqual(result, { ids: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /payment_webhook_events checkout_event/);
  assert.match(calls[0]?.sql ?? "", /paid\.checkout_email/);
  assert.match(
    calls[0]?.sql ?? "",
    /checkout_event\.provider_resource_id IN \(\s*fdi\.provider_checkout_id,\s*fdi\.provider_payment_id\s*\)/,
  );
  assert.match(
    calls[0]?.sql ?? "",
    /checkout_event\.payload#>>'\{data,user,email\}'/,
  );
  assert.ok(calls[0]?.values.includes("%buyer@example.com%"));
});

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
    amountUsd: 500,
    funding: { ...safeInput.funding, currentVsAverageRatio: 5 },
  });
  const recent = scoreFiatDeposit({
    ...safeInput,
    amountUsd: 500,
    funding: { ...safeInput.funding, currentVsAverageRatio: 5 },
    account: {
      ...safeInput.account,
      accountAgeDays: 14,
    },
  });
  const cryptoDust = scoreFiatDeposit({
    ...safeInput,
    amountUsd: 500,
    funding: {
      ...safeInput.funding,
      priorCryptoDeposits: 1,
      priorCryptoUsd: 1,
      currentVsAverageRatio: 5,
    },
  });

  assert.equal(established.riskScore, 0);
  assert.equal(recent.riskScore, 15);
  assert.equal(cryptoDust.riskScore, 15);
});

test("Whop raw risk score is retained as evidence but never affects scoring", () => {
  const low = scoreFiatDeposit({
    ...safeInput,
    provider: { ...safeInput.provider, riskScore: 0 },
  });
  const high = scoreFiatDeposit({
    ...safeInput,
    provider: { ...safeInput.provider, riskScore: 100 },
  });
  assert.equal(high.riskScore, low.riskScore);
  assert.equal(
    high.signals.some((signal) => signal.key === "whop_risk_score"),
    false,
  );
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

test("assessment refresh loads settled, staff-review, and paid-unreconciled fiat", async () => {
  const source = await readFile(
    new URL("../src/fiat-risk.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /FIAT_ASSESSMENT_STATUSES/);
  assert.match(source, /"completed"/);
  assert.match(source, /"partially_refunded"/);
  assert.match(source, /"refunded"/);
  assert.match(source, /"disputed"/);
  assert.match(source, /"review"/);
  assert.match(source, /"paid_unreconciled"/);
  assert.match(source, /event_type='payment\.succeeded'/);
  assert.match(source, /processing_status='failed'/);
  assert.match(
    source,
    /payload#>>'\{data,metadata,deposit_intent_id\}'/,
  );
  assert.match(source, /paid\.checkout_email/);
  assert.doesNotMatch(
    source,
    /FIAT_ASSESSMENT_STATUSES[\s\S]{0,200}"checkout_ready"/,
  );
  assert.match(source, /current\.intent_id=ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(source, /current\.intent_id=ANY\(\$1::uuid\[\]\)/);
});

const cleanMaxMind: MaxMindEvaluation = {
  status: "success",
  minfraudId: "11111111-1111-1111-1111-111111111111",
  riskScore: 1,
  ipRisk: 0.5,
  disposition: null,
  signals: [],
  response: null,
  errorCode: null,
};

test("the MaxMind low-risk credit cannot erode an already-bad verdict", () => {
  const blocked = applyBlacklistedCheckoutEmail(scoreFiatDeposit(safeInput), {
    deposit_intent_id: "deposit-1",
    checkout_email: "buyer@blocked.example",
    domain: "blocked.example",
    match_type: "blacklisted_domain",
    lock_delivered_at: new Date("2026-07-29T12:00:00.000Z"),
  });
  assert.equal(blocked.riskScore, 100);

  // A low MaxMind score is weak absence-of-evidence. Before the fix the -5
  // credit persisted this blocked-domain checkout as 95 while the dashboard
  // reported 100 for the same match.
  const enriched = applyMaxMindFiatRisk(blocked, cleanMaxMind);
  assert.equal(enriched.riskScore, 100);
  assert.equal(enriched.verdict, "bad");

  // The positive path is untouched.
  const raised = applyMaxMindFiatRisk(scoreFiatDeposit(safeInput), {
    ...cleanMaxMind,
    riskScore: 90,
  });
  assert.ok(raised.riskScore >= 72);
  assert.equal(raised.verdict, "bad");

  // And a low score still discounts a result that is not already hard.
  const discounted = applyMaxMindFiatRisk(
    scoreFiatDeposit({
      ...safeInput,
      provider: { ...safeInput.provider, disputeCount: 0 },
    }),
    cleanMaxMind,
  );
  assert.ok(discounted.riskScore < 60);
});

test("no score category is ever persisted below zero", () => {
  // The established-crypto trust credit is negative and lands in `funding`.
  // Left unclamped it persisted a negative category and quietly subtracted
  // from unrelated risk.
  const result = scoreFiatDeposit({
    ...safeInput,
    account: { ...safeInput.account, accountAgeDays: 400 },
    funding: {
      ...safeInput.funding,
      priorCryptoDeposits: 5,
      priorCryptoUsd: 500,
    },
  });
  for (const [category, value] of Object.entries(result.scoreBreakdown)) {
    assert.ok(value >= 0, `${category} went negative: ${value}`);
    assert.ok(value <= 100, `${category} exceeded 100: ${value}`);
  }
});

test("LIKE search patterns escape the wildcards a human can paste", () => {
  assert.equal(likeContains("abc"), "%abc%");
  assert.equal(likeContains("_"), String.raw`%\_%`);
  assert.equal(likeContains("100%"), String.raw`%100\%%`);
  assert.equal(likeContains(String.raw`a\b`), String.raw`%a\\b%`);
  assert.equal(likeContains("MiXeD"), "%mixed%");
});

test("the fiat trust credit uses the same weighted crypto sum as the gate", async () => {
  const source = await readFile(
    new URL("../src/fiat-risk.ts", import.meta.url),
    "utf8",
  );
  // 25 x $1 crypto deposits must not buy the same -20 credit as one real $25
  // deposit: the eligibility gate already discounts small deposits and the
  // fiat scorer has to agree, or a prepared mule walks from review to good.
  assert.match(
    source,
    /SMALL_CRYPTO_DEPOSIT_USD\}::numeric[\s\S]*SMALL_CRYPTO_TRUST_WEIGHT\}::numeric[\s\S]*AS prior_crypto_usd/,
  );
  assert.doesNotMatch(source, /const MEANINGFUL_PRIOR_CRYPTO_USD/);
  assert.doesNotMatch(source, /const ESTABLISHED_ACCOUNT_DAYS/);
});

test("the exact-amount lateral is bounded and the refund ratio cannot exceed one", async () => {
  const source = await readFile(
    new URL("../src/fiat-risk.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /f\.requested_amount_cents=t\.requested_amount_cents[\s\S]*f\.created_at >= t\.created_at - interval '7 days'[\s\S]*f\.created_at <= t\.created_at \+ interval '15 minutes'[\s\S]*\) amounts ON TRUE/,
  );
  assert.match(
    source,
    /WHERE f\.paid_at IS NOT NULL\s*\n\s*AND f\.status::text IN \(\s*\n\s*'refunded','partially_refunded','disputed'/,
  );
});

test("a MaxMind enrichment failure never rejects the workspace refresh", async () => {
  const source = await readFile(
    new URL("../src/fiat-risk.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\}\)\.catch\(\(\) => null\);/);
  assert.match(source, /if \(result\) maxmindByIntent\.set\(id, result\);/);
  assert.match(source, /status='failed'\s*\n\s*AND checked_at > now\(\) - interval/);
});
