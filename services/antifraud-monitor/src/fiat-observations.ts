import type {
  FiatEligibilitySignal,
} from "./fiat-eligibility-policy.js";
import type { FiatSignal } from "./fiat-risk.js";

export type FiatPrePaymentObservationEvidence = {
  status: "complete" | "unavailable";
  ipAttempts10m: number;
  deviceAttempts10m: number;
  platformAttempts10m: number;
  ipDistinctUsers24h: number;
  deviceDistinctUsers24h: number;
  linkedActiveRiskUsers: number;
  amountAttempts30m: number;
  amountDistinctUsers30m: number;
};

export type FiatPostPaymentDetectionEvidence = {
  paymentIdentityHistoryStatus:
    | "complete"
    | "partial"
    | "unavailable"
    | "not_applicable";
  authorizedNetworkHistoryStatus:
    | "complete"
    | "unavailable"
    | "not_applicable";
  payerEmailStatus: "available" | "unavailable" | "not_applicable";
  threeDsStatus:
    | "verified"
    | "failed"
    | "unavailable"
    | "not_applicable";
  stablePaymentIdentityStatus:
    | "available"
    | "unavailable"
    | "not_applicable";
  checkoutEmailDiffersFromAccount: boolean;
  disposableCheckoutEmailDomain: string | null;
  billingCountryMismatch: boolean;
  checkoutEmailSharedUsers: number;
  whopCustomerSharedUsers: number;
  paymentMethodSharedUsers: number;
  cardSignatureSharedUsers: number;
  checkoutIpSharedUsers: number;
  checkoutDeviceSharedUsers: number;
  exactAmountAttempts30m: number;
  exactAmountDistinctUsers30m: number;
  exactAmountSettled7d: number;
  exactAmountRefunded7d: number;
  tipsAfterDeposit: number;
  tipsAfterDepositUsd: number;
  minutesToFirstTip: number | null;
};

function preSignal(
  key: string,
  detail: string,
  source: FiatEligibilitySignal["source"],
): FiatEligibilitySignal {
  return {
    key,
    detail,
    points: 0,
    blocking: false,
    containing: false,
    evidenceOnly: true,
    source,
  };
}

/**
 * Heuristic pre-payment detections. Every result is evidence-only by contract:
 * no score, checkout decision, lock, KYC, refund, or withdrawal action may be
 * derived from this function until an explicit policy is approved separately.
 */
export function prePaymentObservationSignals(
  evidence: FiatPrePaymentObservationEvidence,
): FiatEligibilitySignal[] {
  const signals: FiatEligibilitySignal[] = [];
  if (evidence.status === "unavailable") {
    signals.push(preSignal(
      "observe_pre_payment_evidence_unavailable",
      "Historical pre-payment observations were unavailable for this check.",
      "history",
    ));
  }
  if (evidence.ipAttempts10m >= 3) {
    signals.push(preSignal(
      "observe_checkout_ip_velocity",
      `${evidence.ipAttempts10m} checkout checks used this IP in ten minutes.`,
      "network",
    ));
  }
  if (evidence.deviceAttempts10m >= 3) {
    signals.push(preSignal(
      "observe_checkout_device_velocity",
      `${evidence.deviceAttempts10m} checkout checks used this device in ten minutes.`,
      "fingerprint",
    ));
  }
  if (evidence.platformAttempts10m >= 20) {
    signals.push(preSignal(
      "observe_platform_checkout_burst",
      `${evidence.platformAttempts10m} checkout checks occurred platform-wide in ten minutes.`,
      "history",
    ));
  }
  if (evidence.ipDistinctUsers24h >= 3) {
    signals.push(preSignal(
      "observe_checkout_ip_account_cluster",
      `${evidence.ipDistinctUsers24h} accounts used this checkout IP in 24 hours.`,
      "network",
    ));
  }
  if (evidence.deviceDistinctUsers24h >= 2) {
    signals.push(preSignal(
      "observe_checkout_device_account_cluster",
      `${evidence.deviceDistinctUsers24h} accounts used this checkout device in 24 hours.`,
      "fingerprint",
    ));
  }
  if (evidence.linkedActiveRiskUsers > 0) {
    signals.push(preSignal(
      "observe_linked_active_fraud_cases",
      `${evidence.linkedActiveRiskUsers} linked account(s) have an active high or critical Fraud case.`,
      "history",
    ));
  }
  if (evidence.amountDistinctUsers30m >= 3) {
    signals.push(preSignal(
      "observe_requested_amount_cluster",
      `${evidence.amountDistinctUsers30m} accounts requested the same amount across ${evidence.amountAttempts30m} checks in 30 minutes.`,
      "history",
    ));
  }
  return signals;
}

function postSignal(
  key: string,
  label: string,
  detail: string,
  category: FiatSignal["category"],
): FiatSignal {
  return {
    key,
    label,
    detail,
    points: 0,
    tone: "warning",
    category,
    evidenceOnly: true,
  };
}

/** Post-authorization detections. These deliberately cannot change risk. */
export function postPaymentObservationSignals(
  evidence: FiatPostPaymentDetectionEvidence,
): FiatSignal[] {
  const signals: FiatSignal[] = [];
  if (evidence.paymentIdentityHistoryStatus === "partial") {
    signals.push(postSignal(
      "observe_payment_identity_history_partial",
      "Partial payment-identity history",
      "Payment-identity reuse was checked against a bounded history window; older records were not included.",
      "provider",
    ));
  } else if (evidence.paymentIdentityHistoryStatus === "unavailable") {
    signals.push(postSignal(
      "observe_payment_identity_history_unavailable",
      "Payment-identity history unavailable",
      "Historical payment-identity reuse could not be checked for this assessment.",
      "provider",
    ));
  }
  if (evidence.authorizedNetworkHistoryStatus === "unavailable") {
    signals.push(postSignal(
      "observe_authorized_network_history_unavailable",
      "Authorized network history unavailable",
      "Historical checkout IP and device reuse could not be checked for this assessment.",
      "network",
    ));
  }
  if (evidence.payerEmailStatus === "unavailable") {
    signals.push(postSignal(
      "observe_checkout_email_unavailable",
      "Checkout email unavailable",
      "The completed payment did not include a payer email to compare or screen.",
      "provider",
    ));
  }
  if (evidence.threeDsStatus === "unavailable") {
    signals.push(postSignal(
      "observe_3ds_result_unavailable",
      "3DS result unavailable",
      "The completed payment did not include a definitive 3DS result.",
      "provider",
    ));
  }
  if (evidence.stablePaymentIdentityStatus === "unavailable") {
    signals.push(postSignal(
      "observe_stable_payment_identity_unavailable",
      "Stable payment identity unavailable",
      "The completed payment did not include a Whop customer or payment-method identity.",
      "provider",
    ));
  }
  if (evidence.checkoutEmailDiffersFromAccount) {
    signals.push(postSignal(
      "observe_checkout_email_changed",
      "Different checkout email",
      "The payer email differs from the account email.",
      "provider",
    ));
  }
  if (evidence.disposableCheckoutEmailDomain) {
    signals.push(postSignal(
      "observe_disposable_checkout_email",
      "Disposable checkout email",
      `The payer used the disposable domain ${evidence.disposableCheckoutEmailDomain}.`,
      "provider",
    ));
  }
  if (evidence.billingCountryMismatch) {
    signals.push(postSignal(
      "observe_billing_country_mismatch",
      "Billing-country mismatch",
      "The Whop billing country differs from the account country.",
      "provider",
    ));
  }
  const reuse: Array<[number, number, string, string]> = [
    [evidence.checkoutEmailSharedUsers, 2, "observe_checkout_email_reuse", "payer email"],
    [evidence.whopCustomerSharedUsers, 2, "observe_whop_customer_reuse", "Whop customer identity"],
    [evidence.paymentMethodSharedUsers, 2, "observe_payment_method_reuse", "payment-method identity"],
    [evidence.cardSignatureSharedUsers, 3, "observe_card_signature_reuse", "weak card brand and last-four signature"],
    [evidence.checkoutIpSharedUsers, 2, "observe_authorized_ip_reuse", "checkout IP"],
    [evidence.checkoutDeviceSharedUsers, 2, "observe_authorized_device_reuse", "checkout device"],
  ];
  for (const [users, threshold, key, label] of reuse) {
    if (users < threshold) continue;
    signals.push(postSignal(
      key,
      "Cross-account payment link",
      `${users} accounts share this ${label}. This is evidence only and may be legitimate.`,
      key.includes("ip") || key.includes("device") ? "network" : "provider",
    ));
  }
  if (evidence.exactAmountDistinctUsers30m >= 3) {
    signals.push(postSignal(
      "observe_authorized_amount_burst",
      "Coordinated amount burst",
      `${evidence.exactAmountDistinctUsers30m} accounts created ${evidence.exactAmountAttempts30m} same-amount payments in 30 minutes.`,
      "velocity",
    ));
  }
  const refundRatio = evidence.exactAmountSettled7d > 0
    ? evidence.exactAmountRefunded7d / evidence.exactAmountSettled7d
    : 0;
  if (
    evidence.exactAmountRefunded7d >= 3
    && evidence.exactAmountSettled7d >= 5
    && refundRatio >= 0.5
  ) {
    signals.push(postSignal(
      "observe_amount_refund_concentration",
      "Refunded amount concentration",
      `${evidence.exactAmountRefunded7d} of ${evidence.exactAmountSettled7d} same-amount payments were refunded in seven days.`,
      "velocity",
    ));
  }
  if (
    evidence.tipsAfterDeposit > 0
    && evidence.minutesToFirstTip !== null
    && evidence.minutesToFirstTip < 60
  ) {
    signals.push(postSignal(
      "observe_rapid_post_deposit_tipping",
      "Rapid post-deposit tipping",
      `${evidence.tipsAfterDeposit} tip transaction(s) totaling $${evidence.tipsAfterDepositUsd.toFixed(2)} followed within ${Math.max(0, Math.round(evidence.minutesToFirstTip))} minutes.`,
      "behavior",
    ));
  }
  return signals;
}
