export const FRAUD_BAN_REASON = "Fraud";

export const BAN_REASON_PRESETS = [
  "Multi",
  "CC Fraud",
  FRAUD_BAN_REASON,
  "Abuse",
] as const;

/**
 * More specific reasons used while resolving an Antifraud case. These are
 * operator conclusions, never automatic labels: a shared household/network
 * can be legitimate and staff must still review the linked accounts first.
 */
export const ANTIFRAUD_BAN_REASON_PRESETS = [
  "Shared device / fingerprint abuse",
  "Shared IP account abuse",
  "Multiple-account / bonus abuse",
  "Payment or card fraud",
  "Account takeover / identity mismatch",
  "Fraud or platform abuse",
] as const;
