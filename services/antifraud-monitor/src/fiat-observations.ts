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
  ipLinkedActiveRiskUsers: number;
  deviceLinkedActiveRiskUsers: number;
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
  checkoutIp: string | null;
  checkoutFingerprint: string | null;
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
  points = 0,
): FiatEligibilitySignal {
  return {
    key,
    detail,
    points,
    blocking: false,
    containing: false,
    ...(points === 0 ? { evidenceOnly: true as const } : {}),
    source,
  };
}

/**
 * Pre-payment velocity detections. Strong account/device reuse now contributes
 * to the checkout score, but never contains an account by itself. Global
 * traffic is deliberately evidence-only: one attacker must not be able to
 * deny every customer by creating a platform-wide burst.
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
      evidence.ipAttempts10m >= 8 ? 45 : evidence.ipAttempts10m >= 5 ? 30 : 15,
    ));
  }
  if (evidence.deviceAttempts10m >= 3) {
    signals.push(preSignal(
      "observe_checkout_device_velocity",
      `${evidence.deviceAttempts10m} checkout checks used this device in ten minutes.`,
      "fingerprint",
      evidence.deviceAttempts10m >= 8 ? 60 : evidence.deviceAttempts10m >= 5 ? 45 : 25,
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
      evidence.ipDistinctUsers24h >= 10 ? 45 : 20,
    ));
  }
  if (evidence.deviceDistinctUsers24h >= 2) {
    signals.push(preSignal(
      "observe_checkout_device_account_cluster",
      `${evidence.deviceDistinctUsers24h} accounts used this checkout device in 24 hours.`,
      "fingerprint",
      evidence.deviceDistinctUsers24h >= 4 ? 70 : evidence.deviceDistinctUsers24h >= 3 ? 55 : 40,
    ));
  }
  if (evidence.ipLinkedActiveRiskUsers > 0) {
    signals.push(preSignal(
      "checkout_ip_linked_active_fraud_cases",
      `${evidence.ipLinkedActiveRiskUsers} account(s) sharing this checkout IP have an active high or critical Fraud case.`,
      "history",
      evidence.ipLinkedActiveRiskUsers >= 3 ? 50 : 25,
    ));
  }
  if (evidence.deviceLinkedActiveRiskUsers > 0) {
    signals.push(preSignal(
      "checkout_device_linked_active_fraud_cases",
      `${evidence.deviceLinkedActiveRiskUsers} account(s) sharing this checkout device have an active high or critical Fraud case.`,
      "history",
      evidence.deviceLinkedActiveRiskUsers >= 2 ? 70 : 55,
    ));
  }
  if (evidence.amountDistinctUsers30m >= 3) {
    signals.push(preSignal(
      "observe_requested_amount_cluster",
      `${evidence.amountDistinctUsers30m} accounts requested the same amount across ${evidence.amountAttempts30m} checks in 30 minutes.`,
      "history",
      evidence.amountDistinctUsers30m >= 5 ? 35 : 20,
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

/**
 * Cross-account reuse signals, tiered by how exact the match is.
 *
 * Whop's own customer and payment-method ids are exact provider-verified
 * identity, so they score like the existing signup-time shared-device signal
 * (`shared_device` in fiat-risk.ts). Checkout email and checkout IP/device are
 * the same class of evidence this service already trusts elsewhere (the post-
 * authorization identity-drift check contains on a changed email outright).
 * Card brand+last4 is the weakest of the six — a coincidental match between
 * two different real cards is far more likely than for an exact token — so it
 * scores lowest and needs a third account before it counts at all.
 *
 * 2026-08-06: promoted from evidence-only to scored per owner approval. This
 * only changes the score and recommendation shown to staff on the Fiat
 * review queue — crediting stays fully manual, and nothing here locks an
 * account or requires KYC on its own.
 */
const REUSE_SIGNALS: ReadonlyArray<{
  key: (evidence: FiatPostPaymentDetectionEvidence) => number;
  threshold: number;
  points: (users: number) => number;
  label: string;
  signalKey: string;
  noun: string;
  category: FiatSignal["category"];
}> = [
  {
    key: (e) => e.whopCustomerSharedUsers,
    threshold: 2,
    points: (users) => Math.min(70, 45 + users * 10),
    label: "Whop customer reused across accounts",
    signalKey: "checkout_whop_customer_shared",
    noun: "Whop customer identity",
    category: "provider",
  },
  {
    key: (e) => e.paymentMethodSharedUsers,
    threshold: 2,
    points: (users) => Math.min(70, 45 + users * 10),
    label: "Payment method reused across accounts",
    signalKey: "checkout_payment_method_shared",
    noun: "payment-method identity",
    category: "provider",
  },
  {
    key: (e) => e.checkoutDeviceSharedUsers,
    threshold: 2,
    points: (users) => Math.min(60, 35 + users * 8),
    label: "Checkout device reused across accounts",
    signalKey: "checkout_device_shared",
    noun: "checkout device",
    category: "network",
  },
  {
    key: (e) => e.checkoutEmailSharedUsers,
    threshold: 2,
    points: (users) => Math.min(50, 30 + users * 8),
    label: "Checkout email reused across accounts",
    signalKey: "checkout_email_shared",
    noun: "payer email",
    category: "provider",
  },
  {
    key: (e) => e.checkoutIpSharedUsers,
    threshold: 2,
    points: (users) => Math.min(30, 15 + users * 2),
    label: "Checkout IP reused across accounts",
    signalKey: "checkout_ip_shared",
    noun: "checkout IP",
    category: "network",
  },
  {
    key: (e) => e.cardSignatureSharedUsers,
    threshold: 3,
    points: (users) => Math.min(25, 10 + users * 5),
    label: "Card signature reused across accounts",
    signalKey: "checkout_card_signature_shared",
    noun: "weak card brand and last-four signature",
    category: "provider",
  },
];

/** Post-authorization detections. Reuse signals score; the rest are evidence. */
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
  for (const rule of REUSE_SIGNALS) {
    const users = rule.key(evidence);
    if (users < rule.threshold) continue;
    signals.push({
      key: rule.signalKey,
      label: rule.label,
      detail: `${users} other account(s) share this ${rule.noun}.`,
      points: rule.points(users),
      tone: "bad",
      category: rule.category,
    });
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
