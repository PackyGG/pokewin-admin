import assert from "node:assert/strict";
import test from "node:test";

import {
  postPaymentObservationSignals,
  prePaymentObservationSignals,
} from "../src/fiat-observations.js";

test("pre-payment velocity scores strong reuse without containing accounts", () => {
  const signals = prePaymentObservationSignals({
    status: "complete",
    ipAttempts10m: 5,
    deviceAttempts10m: 5,
    platformAttempts10m: 50,
    ipDistinctUsers24h: 5,
    deviceDistinctUsers24h: 4,
    ipLinkedActiveRiskUsers: 1,
    deviceLinkedActiveRiskUsers: 2,
    amountAttempts30m: 8,
    amountDistinctUsers30m: 5,
  });
  assert.ok(signals.length >= 7);
  assert.ok(signals.some((signal) => !signal.evidenceOnly));
  assert.ok(signals.some((signal) => signal.points > 0));
  assert.ok(signals.every((signal) => !signal.blocking && !signal.containing));
  assert.ok(signals.find(
    (signal) => signal.key === "checkout_device_linked_active_fraud_cases",
  )?.points === 70);
});

test("post-payment status gaps stay evidence-only; reuse signals now score", () => {
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
    checkoutIp: "203.0.113.10",
    checkoutFingerprint: "fp_checkout_1",
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

  const reuseKeys = new Set([
    "checkout_whop_customer_shared",
    "checkout_payment_method_shared",
    "checkout_device_shared",
    "checkout_email_shared",
    "checkout_ip_shared",
    "checkout_card_signature_shared",
  ]);
  const reuseSignals = signals.filter((signal) => reuseKeys.has(signal.key));
  const otherSignals = signals.filter((signal) => !reuseKeys.has(signal.key));

  // All six reuse signals fire at these evidence levels.
  assert.equal(reuseSignals.length, 6);
  assert.ok(reuseSignals.every((signal) => !signal.evidenceOnly));
  assert.ok(reuseSignals.every((signal) => signal.points > 0));

  // Everything else (disposable email, billing mismatch, amount burst, etc.)
  // is untouched and still cannot change risk.
  assert.ok(otherSignals.every((signal) => signal.evidenceOnly === true));
  assert.ok(otherSignals.every((signal) => signal.points === 0));
});

test("reuse signals are tiered by how exact the match is", () => {
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
    cardSignatureSharedUsers: 0,
    checkoutIp: null,
    checkoutFingerprint: null,
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

  // Weak card-signature match needs three linked accounts before it counts.
  assert.equal(postPaymentObservationSignals({
    ...base,
    cardSignatureSharedUsers: 2,
  }).some((signal) => signal.key === "checkout_card_signature_shared"), false);
  assert.equal(postPaymentObservationSignals({
    ...base,
    cardSignatureSharedUsers: 3,
  }).some((signal) => signal.key === "checkout_card_signature_shared"), true);

  // Exact Whop identity outweighs the weak card signature at the same count.
  const customerSignal = postPaymentObservationSignals({
    ...base,
    whopCustomerSharedUsers: 2,
  }).find((signal) => signal.key === "checkout_whop_customer_shared");
  const cardSignal = postPaymentObservationSignals({
    ...base,
    cardSignatureSharedUsers: 3,
  }).find((signal) => signal.key === "checkout_card_signature_shared");
  assert.ok(customerSignal && cardSignal);
  assert.ok(customerSignal.points > cardSignal.points);
});

test("missing and partial observations stay explicit and evidence-only", () => {
  const pre = prePaymentObservationSignals({
    status: "unavailable",
    ipAttempts10m: 0,
    deviceAttempts10m: 0,
    platformAttempts10m: 0,
    ipDistinctUsers24h: 0,
    deviceDistinctUsers24h: 0,
    ipLinkedActiveRiskUsers: 0,
    deviceLinkedActiveRiskUsers: 0,
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
    checkoutIp: null,
    checkoutFingerprint: null,
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
