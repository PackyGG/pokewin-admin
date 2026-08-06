import assert from "node:assert/strict";
import test from "node:test";

import {
  postPaymentObservationSignals,
  prePaymentObservationSignals,
} from "../src/fiat-observations.js";

test("pre-payment heuristics are evidence-only and cannot act", () => {
  const signals = prePaymentObservationSignals({
    status: "complete",
    ipAttempts10m: 5,
    deviceAttempts10m: 5,
    platformAttempts10m: 50,
    ipDistinctUsers24h: 5,
    deviceDistinctUsers24h: 4,
    linkedActiveRiskUsers: 2,
    amountAttempts30m: 8,
    amountDistinctUsers30m: 5,
  });
  assert.ok(signals.length >= 7);
  assert.ok(signals.every((signal) => signal.evidenceOnly === true));
  assert.ok(signals.every((signal) => signal.points === 0));
  assert.ok(signals.every((signal) => !signal.blocking && !signal.containing));
});

test("post-payment correlations are evidence-only and cannot change risk", () => {
  const signals = postPaymentObservationSignals({
    paymentIdentityHistoryStatus: "complete",
    authorizedNetworkHistoryStatus: "complete",
    payerEmailStatus: "available",
    threeDsStatus: "verified",
    stablePaymentIdentityStatus: "available",
    checkoutEmailDiffersFromAccount: true,
    disposableCheckoutEmailDomain: "temporary.example",
    billingCountryMismatch: true,
    checkoutEmailSharedUsers: 3,
    whopCustomerSharedUsers: 2,
    paymentMethodSharedUsers: 4,
    cardSignatureSharedUsers: 6,
    checkoutIpSharedUsers: 3,
    checkoutDeviceSharedUsers: 2,
    exactAmountAttempts30m: 10,
    exactAmountDistinctUsers30m: 7,
    exactAmountSettled7d: 12,
    exactAmountRefunded7d: 8,
    tipsAfterDeposit: 2,
    tipsAfterDepositUsd: 18,
    minutesToFirstTip: 4,
  });
  assert.ok(signals.length >= 10);
  assert.ok(signals.every((signal) => signal.evidenceOnly === true));
  assert.ok(signals.every((signal) => signal.points === 0));
});

test("weak card signatures need three linked accounts before surfacing", () => {
  const base = {
    paymentIdentityHistoryStatus: "complete" as const,
    authorizedNetworkHistoryStatus: "complete" as const,
    payerEmailStatus: "available" as const,
    threeDsStatus: "verified" as const,
    stablePaymentIdentityStatus: "available" as const,
    checkoutEmailDiffersFromAccount: false,
    disposableCheckoutEmailDomain: null,
    billingCountryMismatch: false,
    checkoutEmailSharedUsers: 0,
    whopCustomerSharedUsers: 0,
    paymentMethodSharedUsers: 0,
    checkoutIpSharedUsers: 0,
    checkoutDeviceSharedUsers: 0,
    exactAmountAttempts30m: 0,
    exactAmountDistinctUsers30m: 0,
    exactAmountSettled7d: 0,
    exactAmountRefunded7d: 0,
    tipsAfterDeposit: 0,
    tipsAfterDepositUsd: 0,
    minutesToFirstTip: null,
  };
  assert.equal(postPaymentObservationSignals({
    ...base,
    cardSignatureSharedUsers: 2,
  }).some((signal) => signal.key === "observe_card_signature_reuse"), false);
  assert.equal(postPaymentObservationSignals({
    ...base,
    cardSignatureSharedUsers: 3,
  }).some((signal) => signal.key === "observe_card_signature_reuse"), true);
});

test("missing and partial observations stay explicit and evidence-only", () => {
  const pre = prePaymentObservationSignals({
    status: "unavailable",
    ipAttempts10m: 0,
    deviceAttempts10m: 0,
    platformAttempts10m: 0,
    ipDistinctUsers24h: 0,
    deviceDistinctUsers24h: 0,
    linkedActiveRiskUsers: 0,
    amountAttempts30m: 0,
    amountDistinctUsers30m: 0,
  });
  assert.deepEqual(pre.map((signal) => signal.key), [
    "observe_pre_payment_evidence_unavailable",
  ]);

  const post = postPaymentObservationSignals({
    checkoutEmailDiffersFromAccount: false,
    disposableCheckoutEmailDomain: null,
    billingCountryMismatch: false,
    checkoutEmailSharedUsers: 0,
    whopCustomerSharedUsers: 0,
    paymentMethodSharedUsers: 0,
    cardSignatureSharedUsers: 0,
    checkoutIpSharedUsers: 0,
    checkoutDeviceSharedUsers: 0,
    exactAmountAttempts30m: 0,
    exactAmountDistinctUsers30m: 0,
    exactAmountSettled7d: 0,
    exactAmountRefunded7d: 0,
    tipsAfterDeposit: 0,
    tipsAfterDepositUsd: 0,
    minutesToFirstTip: null,
    paymentIdentityHistoryStatus: "partial",
    authorizedNetworkHistoryStatus: "unavailable",
    payerEmailStatus: "unavailable",
    threeDsStatus: "unavailable",
    stablePaymentIdentityStatus: "unavailable",
  });
  const keys = new Set(post.map((signal) => signal.key));
  assert.ok(keys.has("observe_payment_identity_history_partial"));
  assert.ok(keys.has("observe_authorized_network_history_unavailable"));
  assert.ok(keys.has("observe_checkout_email_unavailable"));
  assert.ok(keys.has("observe_3ds_result_unavailable"));
  assert.ok(keys.has("observe_stable_payment_identity_unavailable"));
  assert.ok(post.every((signal) => signal.evidenceOnly && signal.points === 0));
});
